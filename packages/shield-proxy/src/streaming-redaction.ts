// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Aho-Corasick DFA redaction with (L-1) sliding buffer for chunk-boundary-split credentials.
// Multi-encoding (raw/base64/url/hex); post-redaction confinement audit halts on survived bytes.

/** A named secret with its value for the redaction dictionary. */
export interface SecretEntry {
  name: string;
  value: string;
}

/** Internal pattern entry with pre-computed byte representation. */
interface PatternEntry {
  /** The bytes to match */
  bytes: Buffer;
  /** The redaction token to replace with, e.g. [REDACTED:DATABASE_URL] */
  token: Buffer;
  /** Which secret this pattern belongs to (for logging) */
  secretName: string;
}

/**
 * Aho-Corasick automaton node.
 *
 * Each node represents a state in the DFA. The `fail` link points to the
 * longest proper suffix of this node's path that is also a prefix of some
 * pattern — this is the key invariant that eliminates backtracking.
 * The `dictSuffix` link shortcuts to the nearest ancestor (via the fail chain)
 * that is a terminal node, enabling O(1) enumeration of all matches at any state.
 */
interface AhoNode {
  /** Byte → child node transitions */
  children: Map<number, AhoNode>;
  /** Failure link (root's fail points to itself) */
  fail: AhoNode;
  /** Pattern ending at this node (null if not a terminal) */
  output: PatternEntry | null;
  /** Dictionary suffix link — nearest output node reachable via fail chain */
  dictSuffix: AhoNode | null;
  /** Depth from root (byte count on path from root to this node) */
  depth: number;
}

/** Redaction metrics for observability and logging. */
export interface RedactionMetrics {
  /** Total patterns matched and replaced */
  matchCount: number;
  /** Total raw bytes processed (input) */
  bytesProcessed: number;
  /** Total bytes emitted (output, after redaction) */
  bytesEmitted: number;
  /** Confinement audit violations detected (should always be 0) */
  confinementViolations: number;
}

/** Confinement violation detail (Patent Claim 108). */
export interface ConfinementViolation {
  /** The secret name whose value was found in the output */
  secretName: string;
  /** Byte position in the output buffer where the violation was detected */
  position: number;
}

function createRootNode(): AhoNode {
  const root: AhoNode = {
    children: new Map(),
    fail: null as unknown as AhoNode,
    output: null,
    dictSuffix: null,
    depth: 0,
  };
  root.fail = root; // Root's failure link is self-referential
  return root;
}

function createAhoNode(depth: number, failDefault: AhoNode): AhoNode {
  return {
    children: new Map(),
    fail: failDefault,
    output: null,
    dictSuffix: null,
    depth,
  };
}

/**
 * StreamingRedactionEngine — stateful, chunk-boundary-safe redaction
 * with Aho-Corasick DFA and post-redaction confinement audit.
 *
 * Usage:
 *   const engine = new StreamingRedactionEngine(secrets);
 *   // For each response chunk from upstream:
 *   const redacted = engine.process(chunk);
 *   // After the last chunk:
 *   const final = engine.flush();
 *   // Check metrics:
 *   const metrics = engine.getMetrics();
 */
export class StreamingRedactionEngine {
  private patterns: PatternEntry[] = [];
  /** Aho-Corasick automaton root */
  private root: AhoNode = createRootNode();
  /** Sliding buffer: retains the last (L-1) RAW bytes from the previous chunk */
  private carryover: Buffer = Buffer.alloc(0);
  /** Max pattern length in bytes — determines sliding buffer size */
  private maxPatternLen: number = 0;
  /** Per-stream redaction metrics */
  private metrics: RedactionMetrics = {
    matchCount: 0,
    bytesProcessed: 0,
    bytesEmitted: 0,
    confinementViolations: 0,
  };
  /** Whether the stream has been halted due to a confinement violation */
  private halted: boolean = false;

  constructor(secrets: SecretEntry[]) {
    this.buildDictionary(secrets);
  }

  /**
   * Build the multi-encoding redaction dictionary and compile the Aho-Corasick DFA.
   *
   * Three-phase construction:
   * 1. Insert all patterns into trie (goto function)
   * 2. BFS to compute failure links (failure function)
   * 3. Compute dictionary suffix links (output shortcut)
   *
   * For each secret, we generate: raw, base64, URL-encoded, and hex variants.
   * Patterns are deduplicated on byte content and sorted longest-first.
   */
  private buildDictionary(secrets: SecretEntry[]): void {
    const entries: PatternEntry[] = [];
    const seen = new Set<string>(); // Deduplicate on byte content (hex-encoded)

    for (const { name, value } of secrets) {
      if (value.length < 4) continue; // Skip trivially short values

      const variants = this.getEncodedVariants(value);
      const token = Buffer.from(`[REDACTED:${name}]`, 'utf-8');

      for (const variant of variants) {
        const bytes = Buffer.from(variant, 'utf-8');
        const bytesHex = bytes.toString('hex');

        // Deduplicate on actual byte content, not string representation
        if (seen.has(bytesHex)) continue;
        seen.add(bytesHex);

        entries.push({ bytes, token, secretName: name });
        if (bytes.length > this.maxPatternLen) {
          this.maxPatternLen = bytes.length;
        }
      }
    }

    // Sort longest-first: ensures longest match wins when patterns overlap
    entries.sort((a, b) => b.bytes.length - a.bytes.length);
    this.patterns = entries;

    // ── Phase 1: Build trie (goto function) ──
    this.root = createRootNode();
    for (const pattern of entries) {
      let node = this.root;
      for (let d = 0; d < pattern.bytes.length; d++) {
        const byte = pattern.bytes[d]!;
        let child = node.children.get(byte);
        if (!child) {
          child = createAhoNode(d + 1, this.root);
          node.children.set(byte, child);
        }
        node = child;
      }
      // Store longest match at this terminal node
      if (!node.output || pattern.bytes.length > node.output.bytes.length) {
        node.output = pattern;
      }
    }

    // ── Phase 2: BFS to compute failure links ──
    // Failure link invariant: fail(s) = longest proper suffix of s that is
    // also a prefix of some pattern in the dictionary.
    const queue: AhoNode[] = [];

    // Depth-1 nodes: failure → root (no proper suffix can be a prefix)
    for (const child of this.root.children.values()) {
      child.fail = this.root;
      queue.push(child);
    }

    while (queue.length > 0) {
      const node = queue.shift()!;

      for (const [byte, child] of node.children) {
        // Walk up the failure chain from node until we find a state
        // that has a transition on `byte`, or we reach root.
        let f = node.fail;
        while (f !== this.root && !f.children.has(byte)) {
          f = f.fail;
        }
        child.fail = f.children.get(byte) ?? this.root;
        // Prevent self-loops (can occur if root has a transition on byte)
        if (child.fail === child) child.fail = this.root;

        queue.push(child);
      }
    }

    // ── Phase 3: Compute dictionary suffix links ──
    // dictSuffix(s) = nearest node reachable via the fail chain that has output.
    // This lets us enumerate ALL matches ending at a position in O(z) time.
    const queue2: AhoNode[] = [];
    for (const child of this.root.children.values()) {
      child.dictSuffix = null; // Depth-1 nodes: fail=root, root has no output
      queue2.push(child);
    }
    while (queue2.length > 0) {
      const node = queue2.shift()!;
      if (node.fail.output) {
        node.dictSuffix = node.fail;
      } else {
        node.dictSuffix = node.fail.dictSuffix ?? null;
      }
      for (const child of node.children.values()) {
        queue2.push(child);
      }
    }
  }

  /** Compute all encoded variants of a secret value. */
  private getEncodedVariants(value: string): string[] {
    const variants = [value];

    // Base64
    const b64 = Buffer.from(value).toString('base64');
    if (b64 !== value) variants.push(b64);

    // URL-encoded
    try {
      const urlEnc = encodeURIComponent(value);
      if (urlEnc !== value) variants.push(urlEnc);
    } catch {
      // encodeURIComponent can throw on malformed surrogate pairs — skip
    }

    // Hex
    const hex = Buffer.from(value).toString('hex');
    if (hex !== value) variants.push(hex);

    return variants;
  }

  /**
   * Process a chunk of response bytes.
   *
   * Prepends the raw carryover buffer from the previous chunk, scans the safe
   * region (everything except the trailing L-1 bytes) through the Aho-Corasick
   * automaton, then retains the trailing raw bytes as carryover for the next chunk.
   *
   * After replacement, runs the confinement audit (Patent Claim 108) on the
   * output buffer. If any credential bytes survive, the stream is halted.
   *
   * Returns the redacted bytes safe to forward to the agent.
   */
  process(chunk: Buffer): Buffer {
    if (this.halted) return Buffer.alloc(0);
    if (this.patterns.length === 0) {
      this.metrics.bytesProcessed += chunk.length;
      this.metrics.bytesEmitted += chunk.length;
      return chunk;
    }

    // Concatenate raw carryover + new chunk for boundary detection
    const combined = this.carryover.length > 0
      ? Buffer.concat([this.carryover, chunk])
      : chunk;

    // The safe scan boundary: any pattern starting at or after this position
    // might extend past the end of combined and into the next chunk.
    const tailLen = Math.min(this.maxPatternLen - 1, combined.length);
    const stopAt = combined.length - tailLen;

    if (stopAt <= 0) {
      // Not enough data to safely process — buffer everything as raw carryover
      this.carryover = Buffer.from(combined);
      this.metrics.bytesProcessed += chunk.length;
      return Buffer.alloc(0);
    }

    // Scan and redact the safe region using the Aho-Corasick automaton
    const { output, consumed, matches } = this.ahoReplace(combined, stopAt);

    // Retain unconsumed raw bytes as carryover (COPY to prevent shared memory)
    this.carryover = Buffer.from(combined.subarray(consumed));

    this.metrics.bytesProcessed += chunk.length;
    this.metrics.bytesEmitted += output.length;
    this.metrics.matchCount += matches;

    // Confinement audit (Patent Claim 108): verify no credential bytes in output
    const violation = this.confinementAudit(output);
    if (violation) {
      this.metrics.confinementViolations++;
      this.halted = true;
      return Buffer.alloc(0);
    }

    return output;
  }

  /**
   * Flush any remaining bytes in the carryover buffer.
   * Call this after the last chunk to emit the final bytes.
   */
  flush(): Buffer {
    if (this.halted) return Buffer.alloc(0);
    if (this.carryover.length === 0) return Buffer.alloc(0);

    if (this.patterns.length === 0) {
      const out = this.carryover;
      this.metrics.bytesEmitted += out.length;
      this.carryover = Buffer.alloc(0);
      return out;
    }

    // Final pass on remaining bytes — no more chunks coming,
    // so scan everything (stopAt = length, no carryover retained)
    const { output, matches } = this.ahoReplace(this.carryover, this.carryover.length);
    this.carryover = Buffer.alloc(0);
    this.metrics.bytesEmitted += output.length;
    this.metrics.matchCount += matches;

    // Final confinement audit
    const violation = this.confinementAudit(output);
    if (violation) {
      this.metrics.confinementViolations++;
      this.halted = true;
      return Buffer.alloc(0);
    }

    return output;
  }

  /**
   * Aho-Corasick two-phase multi-pattern replacement with safe-region boundary.
   *
   * Phase 1 — Match collection:
   *   Walk the automaton byte-by-byte through the input. At each state, follow
   *   the output + dictSuffix chain to collect all pattern matches ending at
   *   that position. For each match, record the start position and pattern.
   *   Keep only the longest match at each start position.
   *
   * Phase 2 — Greedy replacement:
   *   Scan left-to-right. At each position with a match, emit the redaction
   *   token and advance past the match. At positions without a match, emit
   *   one byte and advance by one.
   *
   * Only matches that START before `stopAt` are considered. A match that starts
   * before stopAt may consume bytes past stopAt (the full match is in the
   * combined buffer).
   *
   * Time: O(n + z) where n = input length, z = number of matches found.
   * The failure links guarantee each byte is processed exactly once during
   * the automaton walk — no backtracking from root at each position.
   */
  private ahoReplace(
    input: Buffer,
    stopAt: number,
  ): { output: Buffer; consumed: number; matches: number } {
    // Phase 1: Find all matches using Aho-Corasick automaton
    // Map: startPosition → { len, pattern } (longest match at each start)
    const bestMatch = new Map<number, { len: number; pattern: PatternEntry }>();

    let state = this.root;
    for (let i = 0; i < input.length; i++) {
      const byte = input[i]!;

      // Follow failure links until we find a transition or return to root
      while (state !== this.root && !state.children.has(byte)) {
        state = state.fail;
      }
      const next = state.children.get(byte);
      if (next) {
        state = next;
      }
      // If no transition from root either, state remains at root

      // Collect all matches ending at position i via output + dictSuffix chain
      let check: AhoNode | null = state;
      while (check && check !== this.root) {
        if (check.output) {
          const matchLen = check.output.bytes.length;
          const start = i - matchLen + 1;
          // Only accept matches that start in the safe region
          if (start >= 0 && start < stopAt) {
            const existing = bestMatch.get(start);
            if (!existing || matchLen > existing.len) {
              bestMatch.set(start, { len: matchLen, pattern: check.output });
            }
          }
        }
        check = check.dictSuffix;
      }
    }

    // Phase 2: Greedy left-to-right replacement
    const outputParts: Buffer[] = [];
    let matchCount = 0;
    let i = 0;

    while (i < stopAt) {
      const m = bestMatch.get(i);
      if (m) {
        outputParts.push(m.pattern.token);
        i += m.len;
        matchCount++;
      } else {
        outputParts.push(input.subarray(i, i + 1));
        i++;
      }
    }

    return {
      output: Buffer.concat(outputParts),
      consumed: i,
      matches: matchCount,
    };
  }

  /**
   * Confinement audit (Patent Claim 108) — post-redaction verification pass.
   *
   * Runs the Aho-Corasick automaton on the OUTPUT buffer to verify that no
   * unredacted credential bytes survived the replacement pass. This provides
   * a defence-in-depth guarantee: even if the replacement logic has a subtle
   * bug, the audit catches leaked credentials before they reach the agent.
   *
   * On violation: returns the first match found. The caller should halt the
   * stream and log the incident.
   *
   * Returns null if the output is clean (expected case).
   */
  private confinementAudit(output: Buffer): ConfinementViolation | null {
    if (output.length === 0 || this.patterns.length === 0) return null;

    let state = this.root;
    for (let i = 0; i < output.length; i++) {
      const byte = output[i]!;

      while (state !== this.root && !state.children.has(byte)) {
        state = state.fail;
      }
      const next = state.children.get(byte);
      if (next) {
        state = next;
      }

      // Any pattern match in the output is a confinement violation
      let check: AhoNode | null = state;
      while (check && check !== this.root) {
        if (check.output) {
          return {
            secretName: check.output.secretName,
            position: i - check.output.bytes.length + 1,
          };
        }
        check = check.dictSuffix;
      }
    }

    return null;
  }

  /**
   * Atomically swap the redaction dictionary (live recompilation).
   * Active streams that call process() after this will use the new dictionary.
   * The carryover buffer and halted state are reset.
   */
  updateDictionary(secrets: SecretEntry[]): void {
    this.buildDictionary(secrets);
    this.carryover = Buffer.alloc(0);
    this.halted = false;
    this.metrics = {
      matchCount: 0,
      bytesProcessed: 0,
      bytesEmitted: 0,
      confinementViolations: 0,
    };
  }

  /** Returns true if the engine has patterns to match. */
  hasPatterns(): boolean {
    return this.patterns.length > 0;
  }

  /** Returns the sliding buffer size (L-1 bytes). */
  getBufferSize(): number {
    return Math.max(0, this.maxPatternLen - 1);
  }

  /** Returns the current redaction metrics for this stream instance. */
  getMetrics(): RedactionMetrics {
    return { ...this.metrics };
  }

  /** Returns true if the stream has been halted due to a confinement violation. */
  isHalted(): boolean {
    return this.halted;
  }

  /**
   * Create a per-stream instance that shares this engine's compiled automaton
   * and pattern dictionary but has its own independent sliding buffer state.
   * Use this when processing concurrent response streams — each stream needs
   * its own carryover buffer to avoid cross-stream contamination.
   */
  createStreamInstance(): StreamingRedactionEngine {
    const instance = Object.create(StreamingRedactionEngine.prototype) as StreamingRedactionEngine;
    // Share the compiled automaton and pattern array (immutable references — safe for concurrent reads)
    instance['patterns'] = this.patterns;
    instance['root'] = this.root;
    instance['maxPatternLen'] = this.maxPatternLen;
    // Fresh per-stream state
    instance['carryover'] = Buffer.alloc(0);
    instance['halted'] = false;
    instance['metrics'] = {
      matchCount: 0,
      bytesProcessed: 0,
      bytesEmitted: 0,
      confinementViolations: 0,
    };
    return instance;
  }
}
