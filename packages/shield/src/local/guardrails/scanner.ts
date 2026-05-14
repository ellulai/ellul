// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Guardrail binary (Go + tree-sitter) AST scan before guarded exec. Scanner reads ONLY
// ~/.ellul/guardrails/ (workspace .ellul/policies/ is informational mirror).
// Pre-scan SHA-256 integrity vs SQLite; fail-closed; TOCTOU residual acknowledged.

import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// ── Constants ──

const GUARDRAIL_TIMEOUT = 10_000; // 10s — generous; typical scan <10ms

/** Possible locations for the guardrail binary. */
const BINARY_SEARCH_PATHS = [
  () => path.join(process.env.HOME || '~', '.ellul', 'bin', 'guardrail'),
  () => 'guardrail', // PATH lookup
];

// ── Types ──

export interface GuardrailFinding {
  rule: string;
  message: string;
  file: string;
  line: number;
  column: number;
  severity: number;
}

export interface GuardrailResult {
  blocked: boolean;
  findings: GuardrailFinding[];
  files_scanned: number;
  error?: string;
}

export interface ChecksumResult {
  valid: boolean;
  mismatched: string[];
}

// ── Binary Resolution ──

let cachedBinaryPath: string | null | undefined; // undefined = not checked

/**
 * Find the guardrail binary. Caches result for process lifetime.
 * Returns null if not found.
 */
export function resolveGuardrailBinary(): string | null {
  if (cachedBinaryPath !== undefined) return cachedBinaryPath;

  for (const locate of BINARY_SEARCH_PATHS) {
    const p = locate();
    try {
      // Check if it's an absolute path that exists
      if (path.isAbsolute(p)) {
        fs.accessSync(p, fs.constants.X_OK);
        cachedBinaryPath = p;
        return p;
      }
      // For bare names (PATH lookup), try spawnSync with --help
      const test = spawnSync(p, ['scan', '--dir', '/nonexistent'], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      // Exit 2 = usage error (binary exists but bad args) — that's fine
      if (test.status !== null) {
        cachedBinaryPath = p;
        return p;
      }
    } catch {
      // Not found, try next
    }
  }

  cachedBinaryPath = null;
  return null;
}

// ── Checksum Verification ──

/**
 * Compute SHA-256 checksums of all .scm files in a directory.
 * Returns a map of filename → hex SHA-256 hash.
 */
function computeChecksums(dir: string): Map<string, string> {
  const checksums = new Map<string, string>();
  try {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.scm')) continue;
      const content = fs.readFileSync(path.join(dir, file));
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      checksums.set(file, hash);
    }
  } catch {
    // Directory doesn't exist — empty checksums
  }
  return checksums;
}

/**
 * Load stored checksums from checksums.json.
 * Returns a map of filename → hex SHA-256 hash, or null if file missing/corrupt.
 */
function loadStoredChecksums(configDir: string): Map<string, string> | null {
  const checksumFile = path.join(configDir, 'guardrails', 'checksums.json');
  try {
    const raw = fs.readFileSync(checksumFile, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, string>;
    return new Map(Object.entries(parsed));
  } catch {
    return null;
  }
}

/**
 * Save checksums to checksums.json.
 */
function saveChecksums(configDir: string, checksums: Map<string, string>): void {
  const checksumFile = path.join(configDir, 'guardrails', 'checksums.json');
  const obj: Record<string, string> = {};
  for (const [k, v] of checksums) obj[k] = v;
  fs.writeFileSync(checksumFile, JSON.stringify(obj, null, 2), { mode: 0o600 });
}

/**
 * Verify materialized rule integrity against stored checksums.
 *
 * This is INTEGRITY RESTORATION, not tamper prevention. A same-user
 * attacker can write to the guardrails directory between verification
 * and scanner invocation (TOCTOU window). The model catches and repairs
 * tampering — it does not prevent it from occurring.
 */
export function verifyAndRestoreIntegrity(
  configDir: string,
  rematerialize: () => void,
  log: (msg: string) => void,
): ChecksumResult {
  const globalDir = path.join(configDir, 'guardrails', 'global');
  const workspaceDir = path.join(configDir, 'guardrails', 'workspace');

  const storedChecksums = loadStoredChecksums(configDir);
  if (!storedChecksums) {
    log('[guardrail] No checksums file found. Re-materializing all rules from SQLite.');
    rematerialize();
    // Compute and save fresh checksums
    const fresh = new Map([
      ...computeChecksums(globalDir),
      ...computeChecksums(workspaceDir),
    ]);
    saveChecksums(configDir, fresh);
    return { valid: true, mismatched: [] };
  }

  // Compute current checksums
  const currentChecksums = new Map([
    ...computeChecksums(globalDir),
    ...computeChecksums(workspaceDir),
  ]);

  // Compare
  const mismatched: string[] = [];

  for (const [file, expectedHash] of storedChecksums) {
    const actualHash = currentChecksums.get(file);
    if (actualHash !== expectedHash) {
      mismatched.push(file);
    }
  }

  // Check for new files not in stored checksums
  for (const file of currentChecksums.keys()) {
    if (!storedChecksums.has(file)) {
      mismatched.push(file);
    }
  }

  // Check for deleted files
  for (const file of storedChecksums.keys()) {
    if (!currentChecksums.has(file)) {
      mismatched.push(file);
    }
  }

  if (mismatched.length > 0) {
    log(`[guardrail] Integrity check failed: ${mismatched.length} file(s) modified outside daemon.`);
    for (const f of mismatched) {
      log(`  - ${f}`);
    }
    log('[guardrail] Restoring all rules from SQLite source of truth.');

    // Re-materialize ALL rules (not just tampered ones — belt and suspenders)
    rematerialize();

    // Recompute and save fresh checksums
    const fresh = new Map([
      ...computeChecksums(globalDir),
      ...computeChecksums(workspaceDir),
    ]);
    saveChecksums(configDir, fresh);

    return { valid: false, mismatched };
  }

  return { valid: true, mismatched: [] };
}

// ── Scanner Invocation ──

/**
 * Scan a workspace directory for guardrail violations.
 *
 * The binary reads rules from daemon-controlled directories ONLY:
 *   --rules ~/.ellul/guardrails/global
 *   --rules ~/.ellul/guardrails/workspace
 *
 * Workspace .ellul/policies/ is NEVER passed as a --rules argument.
 *
 * Fail-closed: ANY error returns blocked=true.
 */
export function scanWorkspace(workspaceDir: string, configDir: string): GuardrailResult {
  const binary = resolveGuardrailBinary();
  if (!binary) {
    return {
      blocked: true,
      findings: [],
      files_scanned: 0,
      error: 'Guardrail binary not found. Install it at ~/.ellul/bin/guardrail or ensure it is in PATH.',
    };
  }

  try {
    const args = [
      'scan',
      '--dir', workspaceDir,
      // Rules from daemon-controlled directories ONLY
      '--rules', path.join(configDir, 'guardrails', 'global'),
      '--rules', path.join(configDir, 'guardrails', 'workspace'),
      // Engine analyzers config
      '--analyzers', path.join(configDir, 'guardrails', 'analyzers.json'),
    ];

    const result = spawnSync(binary, args, {
      encoding: 'utf8',
      timeout: GUARDRAIL_TIMEOUT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Fail-closed: spawn error (missing binary, ENOENT, timeout, etc.)
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      const isTimeout = code === 'ETIMEDOUT';
      return {
        blocked: true,
        findings: [],
        files_scanned: 0,
        error: isTimeout
          ? 'Guardrail binary timed out (killed after 10s)'
          : `Guardrail binary error: ${result.error.message}`,
      };
    }

    // Fail-closed: usage error (bad CLI args)
    if (result.status === 2) {
      return {
        blocked: true,
        findings: [],
        files_scanned: 0,
        error: result.stderr || 'Guardrail usage error',
      };
    }

    // Exit 0 = clean (blocked: false), Exit 1 = blocked (blocked: true).
    const parsed: GuardrailResult = JSON.parse(result.stdout);
    return parsed;
  } catch (err) {
    return {
      blocked: true,
      findings: [],
      files_scanned: 0,
      error: `Guardrail scan failed: ${(err as Error).message}`,
    };
  }
}
