// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

// SHA-256 Merkle root over workspace. MUST stay byte-identical to server sync-receipt.service.ts.
// Algorithm: walk+gitignore → NFC-normalize paths → sort UTF-16 → leaf=SHA256(path|SHA256(content)) → root=SHA256(concat).
// Incremental mtime+size cache, in-memory only. No permissions/timestamps in hash.

import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';

// ── Constants ──

/** Hardcoded exclusions — ALWAYS excluded regardless of .gitignore. */
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

/** Workspace size warning threshold (500 MB). */
const WORKSPACE_SIZE_WARNING_BYTES = 500 * 1024 * 1024;

// ── Types ──

export interface MerkleResult {
  /** Hex-encoded SHA-256 Merkle root hash. */
  root: string;
  /** Number of files included in the hash. */
  fileCount: number;
  /** Total bytes of file content hashed. */
  totalBytes: number;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  /** Hex-encoded SHA-256 of the file's raw bytes. */
  hash: string;
}

// ── Glob Matcher ──

// Minimal gitignore glob: *, **, ?, trailing /, leading /, ! negation.
function globToRegex(pattern: string): { regex: RegExp; dirOnly: boolean; negated: boolean; anchored: boolean } {
  let negated = false;
  let dirOnly = false;
  let anchored = false;
  let p = pattern;

  // Handle negation
  if (p.startsWith('!')) {
    negated = true;
    p = p.slice(1);
  }

  // Handle trailing slash (directory-only pattern)
  if (p.endsWith('/')) {
    dirOnly = true;
    p = p.slice(0, -1);
  }

  // Handle leading slash (anchored to root)
  if (p.startsWith('/')) {
    anchored = true;
    p = p.slice(1);
  }

  // If pattern contains no slash (after stripping leading/trailing), it matches
  // in any directory. Otherwise it's anchored to the root.
  if (p.includes('/')) {
    anchored = true;
  }

  // Convert glob to regex
  let regex = '';
  let i = 0;
  while (i < p.length) {
    const c = p[i];

    if (c === '*') {
      if (p[i + 1] === '*') {
        // ** — match any path segments
        if (p[i + 2] === '/') {
          // **/  — zero or more directories
          regex += '(?:.+/)?';
          i += 3;
        } else {
          // ** at end — match everything remaining
          regex += '.*';
          i += 2;
        }
      } else {
        // * — match anything except /
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
      // Character class — pass through to regex
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

/** Parsed ignore pattern with compiled regex. */
interface IgnorePattern {
  regex: RegExp;
  dirOnly: boolean;
  negated: boolean;
}

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

// Last-match-wins over ordered patterns.
function isExcluded(relativePath: string, isDirectory: boolean, patterns: IgnorePattern[]): boolean {
  let excluded = false;

  for (const pat of patterns) {
    // Directory-only patterns skip files
    if (pat.dirOnly && !isDirectory) continue;

    if (pat.regex.test(relativePath)) {
      excluded = !pat.negated;
    }
  }

  return excluded;
}

// ── ContentHasher ──

export class ContentHasher {
  // NFC-path → {mtime,size,hash}. Reuses when mtime+size match.
  private cache = new Map<string, CacheEntry>();

  constructor() {}

  async computeMerkleRoot(dir: string): Promise<MerkleResult> {
    // Load ignore patterns
    const patterns = this.loadIgnorePatterns(dir);

    // Walk and collect file entries
    const entries: Array<{ relativePath: string; hash: string; size: number }> = [];
    await this.walkDir(dir, '', patterns, entries);

    // Sort by NFC-normalized path using default JS string comparison (UTF-16 code unit order).
    // Paths are already NFC-normalized during walkDir, so this sort is deterministic
    // regardless of host filesystem normalization form.
    entries.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));

    // Compute total bytes and emit size warning
    let totalBytes = 0;
    for (const entry of entries) {
      totalBytes += entry.size;
    }

    if (totalBytes > WORKSPACE_SIZE_WARNING_BYTES) {
      process.stderr.write(
        `[content-hash] Warning: workspace is ${(totalBytes / 1024 / 1024).toFixed(0)}MB ` +
        `(${entries.length} files). Large workspaces may slow sync.\n`,
      );
    }

    // Build Merkle tree
    // Leaf = SHA-256(relativePath | SHA-256(content))  where | = pipe char 0x7C
    // Root = SHA-256(leaf_0 || leaf_1 || ... || leaf_n)  binary concatenation
    const rootHasher = crypto.createHash('sha256');

    for (const entry of entries) {
      const leafInput = `${entry.relativePath}|${entry.hash}`;
      const leafHash = crypto.createHash('sha256').update(leafInput).digest();
      rootHasher.update(leafHash);
    }

    const root = entries.length > 0
      ? rootHasher.digest('hex')
      : crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex');

    return {
      root,
      fileCount: entries.length,
      totalBytes,
    };
  }

  invalidateFiles(relativePaths: string[]): void {
    for (const p of relativePaths) {
      this.cache.delete(p.normalize('NFC'));
    }
  }

  /** Clear entire incremental hash cache. */
  clearCache(): void {
    this.cache.clear();
  }

  // ── Private ──

  // Order: ALWAYS_EXCLUDE → .gitignore → .ellulignore.
  private loadIgnorePatterns(dir: string): IgnorePattern[] {
    const patterns: IgnorePattern[] = [];

    // ALWAYS_EXCLUDE — applied first (lowest priority, can be overridden by negation)
    for (const pat of ALWAYS_EXCLUDE) {
      const { regex, dirOnly, negated } = globToRegex(pat);
      patterns.push({ regex, dirOnly, negated });
    }

    // .gitignore
    const gitignorePath = path.join(dir, '.gitignore');
    try {
      const content = fs.readFileSync(gitignorePath, 'utf8');
      patterns.push(...parseIgnoreFile(content));
    } catch {
      // No .gitignore — that's fine
    }

    // .ellulignore (project-specific extras)
    const ellulignorePath = path.join(dir, '.ellulignore');
    try {
      const content = fs.readFileSync(ellulignorePath, 'utf8');
      patterns.push(...parseIgnoreFile(content));
    } catch {
      // No .ellulignore — that's fine
    }

    return patterns;
  }

  private async walkDir(
    baseDir: string,
    relativeDir: string,
    patterns: IgnorePattern[],
    entries: Array<{ relativePath: string; hash: string; size: number }>,
  ): Promise<void> {
    const dirPath = relativeDir ? path.join(baseDir, relativeDir) : baseDir;

    let dirents: fs.Dirent[];
    try {
      dirents = await fsp.readdir(dirPath, { withFileTypes: true });
    } catch {
      // Directory disappeared or permission denied — skip silently
      return;
    }

    for (const dirent of dirents) {
      const name = dirent.name;
      const relPath = relativeDir ? `${relativeDir}/${name}` : name;

      // NFC normalize: macOS NFD vs Linux NFC would otherwise produce different hashes.
      const nfcPath = relPath.normalize('NFC');

      const isDir = dirent.isDirectory();

      // Skip symlinks entirely — prevents escaping the workspace boundary
      if (dirent.isSymbolicLink()) continue;

      // Check exclusion
      if (isExcluded(nfcPath, isDir, patterns)) continue;

      if (isDir) {
        await this.walkDir(baseDir, relPath, patterns, entries);
      } else if (dirent.isFile()) {
        const fullPath = path.join(dirPath, name);
        const hash = await this.hashFile(fullPath, nfcPath);
        if (hash) {
          entries.push(hash);
        }
      }
      // Skip other types (sockets, block devices, FIFOs)
    }
  }

  private async hashFile(
    fullPath: string,
    nfcRelPath: string,
  ): Promise<{ relativePath: string; hash: string; size: number } | null> {
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(fullPath);
    } catch {
      // File disappeared between readdir and stat — skip
      return null;
    }

    // Check incremental cache: reuse hash if mtime+size unchanged
    const cached = this.cache.get(nfcRelPath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return { relativePath: nfcRelPath, hash: cached.hash, size: cached.size };
    }

    // Hash file content — raw bytes, no encoding conversion
    let hash: string;
    try {
      const content = await fsp.readFile(fullPath);
      hash = crypto.createHash('sha256').update(content).digest('hex');
    } catch {
      // Read error (permission denied, file vanished) — skip
      return null;
    }

    // Update cache
    this.cache.set(nfcRelPath, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      hash,
    });

    return { relativePath: nfcRelPath, hash, size: stat.size };
  }
}
