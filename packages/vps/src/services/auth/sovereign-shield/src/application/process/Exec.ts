// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Exec Service — Sovereign Sandbox file management
 *
 * Manages file sync and patching for the sovereign sandbox (Flow B).
 * Files live in the persistent shielded workspace, invisible to the agent.
 *
 * Workspace structure:
 *   /var/lib/ellul-shielded/projects/{name}/
 *     workspace/   — synced source code (tar.gz or incremental patches)
 *     .cache/      — persisted dep caches (node_modules, .venv, etc.)
 *
 * Security:
 *   - All directories are 0700 owned by shield service user
 *   - Agent (coder/dev) has no read access
 *   - Tar extraction validates: magic bytes, no absolute paths, no traversal
 *   - Patch paths validated via path.resolve() prefix matching
 *
 * Performance:
 *   - syncFiles and patchFiles are async — they never block the Hono event loop
 *   - Tar extraction runs in a child process (non-blocking)
 *   - File I/O uses fs/promises
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const SHIELDED_PROJECTS_DIR = '/var/lib/ellul-shielded/projects';

// Defense-in-depth: project names that reach syncFiles must already be vetted
// upstream, but enforce a strict charset locally so a forgotten check upstream
// can't yield arg/shell-style abuse here.
const PROJECT_NAME_RE = /^[a-zA-Z0-9._-]+$/;

// Tar magic bytes: 1f 8b (gzip)
const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

// Max file sizes
const MAX_SYNC_SIZE = 50 * 1024 * 1024;   // full-sync payload cap
const MAX_PATCH_SIZE = 5 * 1024 * 1024;    // incremental-patch payload cap

// ── Path Resolution ──

export function getWorkspaceDir(project: string): string {
  return path.join(SHIELDED_PROJECTS_DIR, project, 'workspace');
}

export function getCacheDir(project: string): string {
  return path.join(SHIELDED_PROJECTS_DIR, project, '.cache');
}

/**
 * Validate that a project's shielded workspace exists and is accessible.
 */
export async function validateWorkspace(project: string): Promise<{ valid: boolean; error?: string }> {
  const workspaceDir = getWorkspaceDir(project);
  try {
    const stat = await fs.stat(workspaceDir);
    if (!stat.isDirectory()) {
      return { valid: false, error: 'Workspace is not a directory' };
    }
    return { valid: true };
  } catch {
    return { valid: false, error: 'Workspace does not exist. Register project first via POST /_auth/projects' };
  }
}

// ── Full Sync ──

/**
 * Sync files from a tar.gz buffer to the project workspace.
 *
 * Security:
 * - Validates gzip magic bytes (1f 8b)
 * - Uses tar --strip-components=1 --no-absolute-names
 * - Cleans workspace before extraction (clean slate)
 * - Preserves dep cache (separate directory)
 *
 * Performance:
 * - Async — tar extraction runs in a child process, does not block event loop
 * - File I/O uses fs/promises
 *
 * @param project   Project name (validated upstream)
 * @param tarBuffer Raw tar.gz buffer from client
 */
export async function syncFiles(project: string, tarBuffer: Buffer): Promise<{ filesCount: number }> {
  if (!PROJECT_NAME_RE.test(project)) {
    throw new Error('Invalid project name');
  }

  // Validate size
  if (tarBuffer.length > MAX_SYNC_SIZE) {
    throw new Error(`Sync payload exceeds ${MAX_SYNC_SIZE / 1024 / 1024}MB limit`);
  }

  // Validate gzip magic bytes
  if (tarBuffer.length < 2 || tarBuffer[0] !== GZIP_MAGIC_0 || tarBuffer[1] !== GZIP_MAGIC_1) {
    throw new Error('Invalid format: expected tar.gz (gzip magic bytes 1f 8b)');
  }

  const workspaceDir = getWorkspaceDir(project);
  const check = await validateWorkspace(project);
  if (!check.valid) throw new Error(check.error!);

  // Clean workspace (preserves .cache which is a sibling directory)
  const entries = await fs.readdir(workspaceDir);
  await Promise.all(
    entries.map((entry) => fs.rm(path.join(workspaceDir, entry), { recursive: true, force: true })),
  );

  // Write tar to temp file for extraction
  const tmpTar = path.join(SHIELDED_PROJECTS_DIR, project, `.sync-${Date.now()}.tar.gz`);
  try {
    await fs.writeFile(tmpTar, tarBuffer, { mode: 0o600 });

    // Extract with security flags — runs in child process (non-blocking)
    // --no-absolute-names: prevents /etc/shadow extraction
    // --no-same-owner: prevents UID spoofing
    // --no-same-permissions: prevents setuid/setgid bits
    // Post-extract: scan for symlinks planted by malicious tars
    // execFile (argv) — no shell, so $/`/\\ in any path component cannot expand.
    await execFileAsync(
      'tar',
      ['xzf', tmpTar, '--strip-components=1', '--no-absolute-names', '--no-same-owner', '--no-same-permissions', '-C', workspaceDir],
      { timeout: 60_000 },
    );

    // Remove any symlinks planted by the tar — prevents second-order path traversal
    // where a later patch writes through a symlink to outside the workspace.
    await execFileAsync(
      'find',
      [workspaceDir, '-type', 'l', '-delete'],
      { timeout: 10_000 },
    );
  } finally {
    await fs.unlink(tmpTar).catch(() => {});
  }

  // Count extracted files
  const filesCount = await countFiles(workspaceDir);
  return { filesCount };
}

// ── Incremental Patch ──

export interface PatchFile {
  path: string;              // Relative path from workspace root
  content?: string;          // Base64-encoded content (for write)
  action: 'write' | 'delete';
}

/**
 * Apply incremental file patches to the project workspace.
 *
 * Security:
 * - Path traversal protection via path.resolve() prefix matching
 * - Rejects paths containing '..'
 * - Same 0700 shielded directory
 *
 * @param project Project name
 * @param patches Array of file patches
 */
export async function patchFiles(project: string, patches: PatchFile[]): Promise<{ applied: number; errors: string[] }> {
  const workspaceDir = getWorkspaceDir(project);
  const check = await validateWorkspace(project);
  if (!check.valid) throw new Error(check.error!);

  let applied = 0;
  const errors: string[] = [];

  // Process patches concurrently (safe — each writes to a distinct path)
  const results = await Promise.allSettled(
    patches.map(async (patch) => {
      // Path traversal protection
      if (patch.path.includes('..')) {
        throw new Error(`Rejected path with '..': ${patch.path}`);
      }

      const resolvedPath = path.resolve(workspaceDir, patch.path);
      if (!resolvedPath.startsWith(workspaceDir + path.sep) && resolvedPath !== workspaceDir) {
        throw new Error(`Path traversal detected: ${patch.path}`);
      }

      if (patch.action === 'delete') {
        await fs.rm(resolvedPath, { recursive: true, force: true });
      } else if (patch.action === 'write') {
        if (!patch.content) {
          throw new Error(`Missing content for write: ${patch.path}`);
        }
        // Ensure parent directory exists
        await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
        // Decode base64 content
        await fs.writeFile(resolvedPath, Buffer.from(patch.content, 'base64'));
      }
    }),
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    if (result.status === 'fulfilled') {
      applied++;
    } else {
      errors.push(result.reason?.message ?? `Patch ${i} failed`);
    }
  }

  return { applied, errors };
}

// ── Dep Install ──

/**
 * Install dependencies inside the workspace if a lockfile is present.
 * Returns the install command used, or null if no lockfile found.
 *
 * Uses the persistent .cache directory for node_modules so installs
 * survive across sessions. The cache dir is bind-mounted into the
 * namespace by execInNamespace's writableDirs.
 */
export async function detectInstallCommand(project: string): Promise<string | null> {
  const workspaceDir = getWorkspaceDir(project);

  // Check for lockfiles in priority order
  const checks: Array<[string, string]> = [
    ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile'],
    ['yarn.lock', 'yarn install --frozen-lockfile'],
    ['bun.lockb', 'bun install --frozen-lockfile'],
    ['package-lock.json', 'npm ci'],
    ['requirements.txt', 'pip install -r requirements.txt'],
    ['Pipfile.lock', 'pipenv install'],
    ['poetry.lock', 'poetry install --no-interaction'],
  ];

  for (const [lockfile, command] of checks) {
    try {
      await fs.access(path.join(workspaceDir, lockfile));
      return command;
    } catch {
      // Lockfile doesn't exist, try next
    }
  }

  // Fallback: if package.json exists but no lockfile, use npm install
  try {
    await fs.access(path.join(workspaceDir, 'package.json'));
    return 'npm install';
  } catch {
    return null;
  }
}

// ── Helpers ──

async function countFiles(dir: string): Promise<number> {
  let count = 0;
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const subCounts = await Promise.all(
      entries.map(async (entry) => {
        if (entry.isFile()) return 1;
        if (entry.isDirectory()) return countFiles(path.join(dir, entry.name));
        return 0;
      }),
    );
    count = subCounts.reduce((a, b) => a + b, 0);
  } catch {
    // Directory may be empty
  }
  return count;
}

/**
 * Total size of patches in bytes (for validation upstream).
 */
export function computePatchSize(patches: PatchFile[]): number {
  let total = 0;
  for (const p of patches) {
    if (p.content) {
      total += Buffer.byteLength(p.content, 'base64');
    }
  }
  return total;
}

export { MAX_SYNC_SIZE, MAX_PATCH_SIZE };
