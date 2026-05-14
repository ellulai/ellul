// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Sync Receipt Service — Server-Side Receipt Signing, Verification & Workspace Hashing
 *
 * Provides cryptographic receipts that prove a workspace sync completed successfully.
 * The client sends its Merkle root after sync; this service signs a receipt binding
 * the hash to a specific project and epoch. The receipt is later presented for
 * code-dependent operations (git push, deploy) to prove the workspace state.
 *
 * Receipt Structure:
 *   { hash, project, epoch, timestamp, signature }
 *   signature = HMAC-SHA256(hash|project|epoch|timestamp, receipt_key)
 *
 * The receipt key is HKDF-derived from the master jwt-secret with info="ellul-receipt-v1",
 * completely independent from the STS signing key.
 *
 * Epoch Management:
 *   - Each project has a monotonically increasing epoch counter stored at
 *     /var/lib/ellul-shielded/projects/{name}/.epoch
 *   - Epoch increments on every sync/patch operation
 *   - Receipts are only valid for the current epoch — any workspace mutation
 *     invalidates all outstanding receipts
 *   - Atomic write: write .tmp -> fsync -> rename (crash-safe)
 *
 * Workspace Hashing:
 *   Uses the IDENTICAL Merkle tree algorithm as the client-side content-hash.ts.
 *   See that file for the full algorithm specification. The critical invariants:
 *     1. NFC normalize all relative paths
 *     2. Sort by UTF-16 code unit order (JS default string comparison)
 *     3. leaf = SHA-256(relativePath | SHA-256(content))  where | = 0x7C
 *     4. root = SHA-256(binary concatenation of all leaf hashes)
 *
 * WorkspaceLock:
 *   In-process readers-writer lock per project. Writers (sync/patch) have exclusive
 *   access. Readers (git push, deploy) can proceed concurrently. Writers are
 *   prioritized to prevent starvation (Gotcha #2 — NOT flock()).
 */

import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { getReceiptKey } from './Sts';

// ── Constants ──

/** Base path for shielded project data. */
const SHIELDED_PROJECTS_BASE = '/var/lib/ellul-shielded/projects';

/** Receipt TTL in milliseconds. Receipts older than this are rejected. */
const RECEIPT_TTL_MS = 60 * 1000;

/**
 * Hardcoded exclusions — MUST be identical to client-side content-hash.ts ALWAYS_EXCLUDE.
 * Any divergence will cause hash mismatches between client and server.
 */
const ALWAYS_EXCLUDE = [
  '.git/',
  '.env',
  '.env.*',
  '.envrc',
  '.ellulignore',
  'credentials.json',
  'service-account.json',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.htpasswd',
  '.pgpass',
  'node_modules/',
];

// ── Types ──

export interface SyncReceipt {
  /** Hex-encoded SHA-256 Merkle root of the workspace at sync time. */
  hash: string;
  /** Project name this receipt is bound to. */
  project: string;
  /** Epoch at the time of signing. Any workspace mutation increments the epoch. */
  epoch: number;
  /** Unix millisecond timestamp of receipt creation. */
  timestamp: number;
  /** Hex-encoded HMAC-SHA256 signature over hash|project|epoch|timestamp. */
  signature: string;
}

// ── Glob Matcher (identical to client-side content-hash.ts) ──

/**
 * Minimal gitignore-compatible glob matcher.
 *
 * IMPORTANT: This implementation MUST produce identical matching behavior to
 * the client-side globToRegex in content-hash.ts. Any divergence causes hash
 * mismatches.
 *
 * Supports: `*`, `**`, `?`, trailing `/`, leading `/`, `!` negation, `[...]` classes.
 */
function globToRegex(pattern: string): { regex: RegExp; dirOnly: boolean; negated: boolean; anchored: boolean } {
  let negated = false;
  let dirOnly = false;
  let anchored = false;
  let p = pattern;

  if (p.startsWith('!')) {
    negated = true;
    p = p.slice(1);
  }

  if (p.endsWith('/')) {
    dirOnly = true;
    p = p.slice(0, -1);
  }

  if (p.startsWith('/')) {
    anchored = true;
    p = p.slice(1);
  }

  if (p.includes('/')) {
    anchored = true;
  }

  let regex = '';
  let i = 0;
  while (i < p.length) {
    const c = p[i];

    if (c === '*') {
      if (p[i + 1] === '*') {
        if (p[i + 2] === '/') {
          regex += '(?:.+/)?';
          i += 3;
        } else {
          regex += '.*';
          i += 2;
        }
      } else {
        regex += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      regex += '[^/]';
      i++;
    } else if (c === '.') {
      regex += '\\.';
      i++;
    } else if (c === '[') {
      const close = p.indexOf(']', i + 1);
      if (close !== -1) {
        regex += p.slice(i, close + 1);
        i = close + 1;
      } else {
        regex += '\\[';
        i++;
      }
    } else if ('(){}+^$|\\'.includes(c!)) {
      regex += '\\' + c;
      i++;
    } else {
      regex += c;
      i++;
    }
  }

  return {
    regex: new RegExp(anchored ? `^${regex}$` : `(?:^|/)${regex}$`),
    dirOnly,
    negated,
    anchored,
  };
}

interface IgnorePattern {
  regex: RegExp;
  dirOnly: boolean;
  negated: boolean;
}

/**
 * Parse .gitignore-style file content into compiled patterns.
 */
function parseIgnoreFile(content: string): IgnorePattern[] {
  const patterns: IgnorePattern[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const { regex, dirOnly, negated } = globToRegex(line);
    patterns.push({ regex, dirOnly, negated });
  }
  return patterns;
}

/**
 * Check whether a relative path is excluded by ignore patterns.
 * Last matching pattern wins (standard gitignore semantics).
 */
function isExcluded(relativePath: string, isDirectory: boolean, patterns: IgnorePattern[]): boolean {
  let excluded = false;

  for (const pat of patterns) {
    if (pat.dirOnly && !isDirectory) continue;
    if (pat.regex.test(relativePath)) {
      excluded = !pat.negated;
    }
  }

  return excluded;
}

// ── Ignore Pattern Loading ──

/**
 * Load and compile ignore patterns for a workspace directory.
 * Order: ALWAYS_EXCLUDE -> .gitignore -> .ellulignore
 */
function loadIgnorePatterns(workspaceDir: string): IgnorePattern[] {
  const patterns: IgnorePattern[] = [];

  for (const pat of ALWAYS_EXCLUDE) {
    const { regex, dirOnly, negated } = globToRegex(pat);
    patterns.push({ regex, dirOnly, negated });
  }

  const gitignorePath = path.join(workspaceDir, '.gitignore');
  try {
    const content = fs.readFileSync(gitignorePath, 'utf8');
    patterns.push(...parseIgnoreFile(content));
  } catch {
    // No .gitignore
  }

  const ellulignorePath = path.join(workspaceDir, '.ellulignore');
  try {
    const content = fs.readFileSync(ellulignorePath, 'utf8');
    patterns.push(...parseIgnoreFile(content));
  } catch {
    // No .ellulignore
  }

  return patterns;
}

// ── Workspace Merkle Tree (identical algorithm to client-side content-hash.ts) ──

/**
 * Recursively walk a directory, collecting file entries with their content hashes.
 * Skips symlinks, excluded paths, and non-regular files.
 */
async function walkDir(
  baseDir: string,
  relativeDir: string,
  patterns: IgnorePattern[],
  entries: Array<{ relativePath: string; hash: string }>,
): Promise<void> {
  const dirPath = relativeDir ? path.join(baseDir, relativeDir) : baseDir;

  let dirents: fs.Dirent[];
  try {
    dirents = await fsp.readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const dirent of dirents) {
    const name = dirent.name;
    const relPath = relativeDir ? `${relativeDir}/${name}` : name;

    // NFC normalize BEFORE matching or sorting.
    // Server filesystem is Linux (NFC), but normalize explicitly for correctness.
    const nfcPath = relPath.normalize('NFC');

    const isDir = dirent.isDirectory();

    // Skip symlinks — prevents following links outside workspace boundary
    if (dirent.isSymbolicLink()) continue;

    if (isExcluded(nfcPath, isDir, patterns)) continue;

    if (isDir) {
      await walkDir(baseDir, relPath, patterns, entries);
    } else if (dirent.isFile()) {
      const fullPath = path.join(dirPath, name);
      try {
        const content = await fsp.readFile(fullPath);
        const hash = crypto.createHash('sha256').update(content).digest('hex');
        entries.push({ relativePath: nfcPath, hash });
      } catch {
        // File vanished or unreadable — skip
      }
    }
  }
}

/**
 * Compute the Merkle root hash for a workspace directory.
 *
 * Algorithm (byte-identical to client-side content-hash.ts):
 *   1. Walk directory, hash each file's raw bytes with SHA-256
 *   2. NFC-normalize all relative paths
 *   3. Sort by NFC path using default JS string comparison (UTF-16 code units)
 *   4. leaf = SHA-256(relativePath | SHA-256(content))
 *   5. root = SHA-256(leaf_0 || leaf_1 || ... || leaf_n) — binary concatenation
 *
 * @param project - Project name (used to locate workspace directory)
 * @returns Hex-encoded SHA-256 Merkle root
 */
export async function computeWorkspaceHash(project: string): Promise<string> {
  const workspaceDir = path.join(SHIELDED_PROJECTS_BASE, project, 'workspace');
  const patterns = loadIgnorePatterns(workspaceDir);

  const entries: Array<{ relativePath: string; hash: string }> = [];
  await walkDir(workspaceDir, '', patterns, entries);

  // Sort by NFC-normalized path — UTF-16 code unit order (JS default)
  entries.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));

  // Build Merkle root
  const rootHasher = crypto.createHash('sha256');

  for (const entry of entries) {
    const leafInput = `${entry.relativePath}|${entry.hash}`;
    const leafHash = crypto.createHash('sha256').update(leafInput).digest();
    rootHasher.update(leafHash);
  }

  return entries.length > 0
    ? rootHasher.digest('hex')
    : crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex');
}

// ── Epoch Management ──

/**
 * Get the path to a project's epoch file.
 */
function epochPath(project: string): string {
  return path.join(SHIELDED_PROJECTS_BASE, project, '.epoch');
}

/**
 * Read the current epoch for a project.
 * Returns 0 if the epoch file doesn't exist (first sync).
 *
 * @param project - Project name
 * @returns Current epoch integer
 */
export function readEpoch(project: string): number {
  try {
    const raw = fs.readFileSync(epochPath(project), 'utf8').trim();
    const epoch = parseInt(raw, 10);
    return Number.isFinite(epoch) && epoch >= 0 ? epoch : 0;
  } catch {
    return 0;
  }
}

/**
 * Increment the epoch atomically and return the new value.
 *
 * Uses write-to-tmp -> fsync -> rename for crash safety. If the process crashes
 * between fsync and rename, the old epoch file remains — the worst case is a
 * stale epoch, which only means an extra sync cycle (safe side of the failure mode).
 *
 * @param project - Project name
 * @returns New epoch value after increment
 */
export function incrementEpoch(project: string): number {
  const current = readEpoch(project);
  const next = current + 1;
  const filePath = epochPath(project);
  const tmpPath = `${filePath}.tmp`;

  // Ensure the project directory exists
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  // Atomic write: tmp -> fsync -> rename
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeSync(fd, `${next}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);

  return next;
}

// ── Receipt Signing & Verification ──

/**
 * Compute the HMAC-SHA256 signature for a sync receipt.
 *
 * Input format: "hash|project|epoch|timestamp" (pipe-delimited).
 * Using a fixed delimiter with typed fields prevents canonicalization attacks.
 *
 * @param hash      - Hex Merkle root
 * @param project   - Project name
 * @param epoch     - Epoch integer
 * @param timestamp - Unix millisecond timestamp
 * @param key       - HKDF-derived receipt key
 * @returns Hex-encoded HMAC-SHA256
 */
function computeSignature(hash: string, project: string, epoch: number, timestamp: number, key: Buffer): string {
  // Length-prefix the project name to prevent delimiter injection attacks.
  // Without this, a project named "foo|123|456" could forge receipts for project "foo".
  const input = `${hash}|${project.length}:${project}|${epoch}|${timestamp}`;
  return crypto.createHmac('sha256', key).update(input).digest('hex');
}

/**
 * Sign a sync receipt after a successful file sync.
 *
 * Binds the workspace Merkle root hash to a specific project and epoch with a
 * cryptographic HMAC signature. The receipt proves that the workspace was in a
 * known state at a specific point in time.
 *
 * @param hash    - Hex-encoded SHA-256 Merkle root of the workspace
 * @param project - Project name
 * @returns Signed SyncReceipt, or null if the receipt key is unavailable
 */
export function signSyncReceipt(hash: string, project: string): SyncReceipt | null {
  const key = getReceiptKey();
  if (!key) {
    console.error('[sync-receipt] Receipt key unavailable — cannot sign receipt.');
    return null;
  }

  const epoch = readEpoch(project);
  const timestamp = Date.now();
  const signature = computeSignature(hash, project, epoch, timestamp, key);

  return { hash, project, epoch, timestamp, signature };
}

/**
 * Verify a sync receipt's authenticity and freshness.
 *
 * Checks (in order):
 *   1. Receipt key availability
 *   2. Project name matches (prevents cross-project receipt reuse)
 *   3. HMAC signature validity (timing-safe comparison)
 *   4. Epoch matches current epoch (invalidated by any workspace mutation)
 *   5. TTL check (receipt must be < 60 seconds old)
 *
 * @param receipt - The receipt to verify
 * @param project - Expected project name (must match receipt.project)
 * @returns Validation result with reason on failure
 */
export function verifySyncReceipt(
  receipt: SyncReceipt,
  project: string,
): { valid: boolean; reason?: string } {
  const key = getReceiptKey();
  if (!key) {
    return { valid: false, reason: 'receipt_key_unavailable' };
  }

  // Project binding check — prevents using a receipt from project A for project B
  if (receipt.project !== project) {
    return { valid: false, reason: 'project_mismatch' };
  }

  // Recompute expected signature
  const expected = computeSignature(receipt.hash, receipt.project, receipt.epoch, receipt.timestamp, key);

  // Timing-safe comparison — prevents brute-force via timing oracle.
  // Same pattern as jwt.ts and sts.service.ts.
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(receipt.signature, 'hex');

  if (expectedBuf.length !== actualBuf.length) {
    return { valid: false, reason: 'invalid_signature' };
  }

  if (!crypto.timingSafeEqual(expectedBuf, actualBuf)) {
    return { valid: false, reason: 'invalid_signature' };
  }

  // Epoch check — any workspace mutation (sync, patch) increments the epoch,
  // invalidating all receipts signed with the old epoch
  const currentEpoch = readEpoch(project);
  if (receipt.epoch !== currentEpoch) {
    return { valid: false, reason: 'epoch_mismatch' };
  }

  // TTL check — receipts are short-lived (60 seconds)
  const age = Date.now() - receipt.timestamp;
  if (age < 0 || age > RECEIPT_TTL_MS) {
    return { valid: false, reason: 'receipt_expired' };
  }

  return { valid: true };
}

// ── Workspace ReadWrite Lock ──

/**
 * In-process readers-writer lock with writer priority.
 *
 * Design (Gotcha #2 — NOT flock()):
 *   - Multiple concurrent readers allowed
 *   - Writer has exclusive access (blocks all readers and other writers)
 *   - Writer priority: once a writer is waiting, new readers queue behind it
 *     to prevent writer starvation
 *   - All operations are async (return Promises) to avoid blocking the event loop
 *
 * This is an in-process lock only. It does NOT provide cross-process safety.
 * Since sovereign-shield is a single-process Hono server, this is sufficient.
 */
export class WorkspaceLock {
  /** Number of active readers. */
  private readers = 0;
  /** Whether a writer currently holds the lock. */
  private writing = false;
  /** Number of writers waiting to acquire the lock. */
  private waitingWriters = 0;
  /** Queue of waiting readers (resolved when they can proceed). */
  private readerQueue: Array<() => void> = [];
  /** Queue of waiting writers (resolved when they can proceed). */
  private writerQueue: Array<() => void> = [];

  /**
   * Acquire a read lock. Multiple readers can hold the lock concurrently.
   * Blocks if a writer holds the lock or is waiting (writer priority).
   */
  async acquireRead(): Promise<void> {
    // If a writer is active or writers are waiting, queue this reader
    if (this.writing || this.waitingWriters > 0) {
      await new Promise<void>((resolve) => {
        this.readerQueue.push(resolve);
      });
    }
    this.readers++;
  }

  /**
   * Release a read lock. Wakes a waiting writer if this was the last reader.
   */
  releaseRead(): void {
    this.readers--;
    if (this.readers < 0) {
      throw new Error('WorkspaceLock: releaseRead() called without matching acquireRead()');
    }
    // If no more readers and writers are waiting, wake the next writer
    if (this.readers === 0 && this.writerQueue.length > 0) {
      const next = this.writerQueue.shift()!;
      next();
    }
  }

  /**
   * Acquire an exclusive write lock. Blocks until all readers and other writers release.
   * Writer priority: new reader acquisitions will queue behind waiting writers.
   */
  async acquireWrite(): Promise<void> {
    // If anyone holds the lock, queue this writer
    if (this.writing || this.readers > 0) {
      this.waitingWriters++;
      await new Promise<void>((resolve) => {
        this.writerQueue.push(resolve);
      });
      this.waitingWriters--;
    }
    this.writing = true;
  }

  /**
   * Release the write lock. Wakes waiting writers first (priority), then readers.
   */
  releaseWrite(): void {
    if (!this.writing) {
      throw new Error('WorkspaceLock: releaseWrite() called without matching acquireWrite()');
    }
    this.writing = false;

    // Writer priority: wake next writer first
    if (this.writerQueue.length > 0) {
      const next = this.writerQueue.shift()!;
      next();
    } else {
      // No waiting writers — wake ALL queued readers at once
      const readers = this.readerQueue.splice(0);
      for (const resolve of readers) {
        resolve();
      }
    }
  }
}

/** Per-project lock instances. Lazily created, never removed. */
const lockMap = new Map<string, WorkspaceLock>();

/**
 * Get the workspace lock for a project. Creates one if it doesn't exist.
 * Lock instances are cached in memory for the process lifetime.
 *
 * @param project - Project name
 * @returns WorkspaceLock instance for this project
 */
export function getWorkspaceLock(project: string): WorkspaceLock {
  let lock = lockMap.get(project);
  if (!lock) {
    lock = new WorkspaceLock();
    lockMap.set(project, lock);
  }
  return lock;
}
