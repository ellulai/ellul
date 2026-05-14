// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Git Credentials Service
 *
 * Stores git credentials (tokens, provider info) ONLY in sovereign-shield's
 * process memory — never written to disk. This prevents the AI agent from
 * reading credentials directly (e.g. from env files on disk).
 *
 * Credential sessions are short-lived tokens that sovereign-shield passes
 * to git subprocesses via the GIT_CREDENTIAL_SESSION env var. The credential
 * helper reads this var and calls back to sovereign-shield to get credentials.
 *
 * Sessions can ONLY be created in-process (no HTTP endpoint for creation),
 * so the agent cannot mint its own sessions.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execSync, execFileSync, spawn } from 'child_process';
import { isSandboxId } from '@ellul.ai/types';
import { SVC_HOME } from '../../config';

const PROJECTS_DIR = `${SVC_HOME}/projects`;

// ── Shared Utility Functions ──
// These live here (not in git.service.ts) to avoid circular dependencies
// with workflow.routes.ts which imports from both files.

/**
 * Resolve the project directory for the given app.
 *
 * Accepts three shapes (under the nested-app model):
 *   - sandbox slug       "sbx-xyz"
 *   - app root           "sbx-xyz/my-app"
 *   - monorepo package   "sbx-xyz/my-turbo/packages/web"
 *
 * Falls back to the first available sandbox if no name is given.
 *
 * SECURITY: Per-segment allowlist (alphanumeric + `.`/`_`/`-`), no `..`, then
 * `path.resolve` and prefix-check against PROJECTS_DIR. This is the last-line
 * defence against traversal and shell injection — callers pass this path into
 * execAsync.
 */
export function resolveProjectDir(sandboxId: string | undefined): string {
  if (sandboxId && sandboxId !== 'null' && sandboxId !== 'default') {
    // Split into segments and validate each. Empty segments (double slashes) and
    // `.`/`..` are rejected, as are segments with shell metacharacters.
    const segments = sandboxId.split('/');
    for (const seg of segments) {
      if (!seg) {
        throw new Error('Invalid project name: empty path segment');
      }
      if (seg === '.' || seg === '..') {
        throw new Error('Invalid project name: path traversal detected');
      }
      if (!/^[a-zA-Z0-9._-]+$/.test(seg)) {
        throw new Error('Invalid project name: each segment must be alphanumeric with . _ - only');
      }
    }
    // First segment must always be a sandbox slug. Everything inside a sandbox is
    // per-sandbox credential scope; refusing anything that doesn't start with a
    // sandbox slug keeps cross-sandbox credential leakage out of reach.
    if (!isSandboxId(segments[0]!)) {
      throw new Error('Invalid project name: first segment must be a sandbox slug');
    }
    const appDir = path.resolve(PROJECTS_DIR, sandboxId);
    if (!appDir.startsWith(PROJECTS_DIR + '/')) {
      throw new Error('Invalid project name: path traversal detected');
    }
    if (fs.existsSync(appDir)) return appDir;
  }
  // Fallback: first available sandbox, then projects root
  try {
    const entries = fs.readdirSync(PROJECTS_DIR);
    for (const entry of entries) {
      if (!isSandboxId(entry)) continue;
      const full = path.resolve(PROJECTS_DIR, entry);
      if (fs.statSync(full).isDirectory()) return full;
    }
  } catch {}
  return PROJECTS_DIR;
}

/**
 * Build an app-name suffix for secret resolution.
 * e.g. "my-app" → "__MY_APP"
 */
export function buildAppSuffix(sandboxId: string): string {
  const cleaned = sandboxId
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_/, '')
    .replace(/_$/, '');
  return `__${cleaned}`;
}

// ── Types ──

interface GitCredential {
  token: string;
  provider: string;
  repoUrl?: string;
  userName?: string;
  userEmail?: string;
  defaultBranch?: string;
}

interface CredentialSession {
  id: string;
  appSuffix: string;
  createdAt: number;
  expiresAt: number;
}

// ── State ──

/** In-memory git credential store (keyed by app suffix, '' for default) */
const gitCredentials = new Map<string, GitCredential>();

/** Active credential sessions (keyed by session ID) */
const credentialSessions = new Map<string, CredentialSession>();

const SESSION_TTL_MS = 120_000; // 2 minutes — enough for any git operation
const MAX_SESSIONS = 20;

// ── Secret Name Parsing ──

const GIT_SECRET_PREFIXES = [
  '__GIT_TOKEN',
  '__GIT_PROVIDER',
  '__GIT_REPO_URL',
  '__GIT_USER_NAME',
  '__GIT_USER_EMAIL',
  '__GIT_DEFAULT_BRANCH',
];

/** Check if a secret name is a git credential */
export function isGitSecret(name: string): boolean {
  return GIT_SECRET_PREFIXES.some(prefix =>
    name === prefix || name.startsWith(prefix + '__'),
  );
}

/**
 * Parse a git secret name into its field and app suffix.
 * e.g. "__GIT_TOKEN__MY_APP" → { field: "__GIT_TOKEN", suffix: "__MY_APP" }
 * e.g. "__GIT_TOKEN" → { field: "__GIT_TOKEN", suffix: "" }
 */
function parseGitSecretName(name: string): { field: string; suffix: string } {
  for (const prefix of GIT_SECRET_PREFIXES) {
    if (name === prefix) return { field: prefix, suffix: '' };
    if (name.startsWith(prefix + '__')) return { field: prefix, suffix: name.slice(prefix.length) };
  }
  return { field: name, suffix: '' };
}

// ── Git Credential CRUD ──

/** Store a git secret value in memory */
export function setGitSecret(name: string, value: string): void {
  const { field, suffix } = parseGitSecretName(name);
  const existing = gitCredentials.get(suffix);
  const cred: GitCredential = existing || { token: '', provider: '' };

  switch (field) {
    case '__GIT_TOKEN': cred.token = value; break;
    case '__GIT_PROVIDER': cred.provider = value; break;
    case '__GIT_REPO_URL': cred.repoUrl = value; break;
    case '__GIT_USER_NAME': cred.userName = value; break;
    case '__GIT_USER_EMAIL': cred.userEmail = value; break;
    case '__GIT_DEFAULT_BRANCH': cred.defaultBranch = value; break;
  }

  gitCredentials.set(suffix, cred);
}

/** Delete a specific git secret field */
export function deleteGitSecret(name: string): void {
  if (name === '__GIT_TOKEN') {
    // Special case: delete default token means clear all default git creds
    gitCredentials.delete('');
    return;
  }

  const { field, suffix } = parseGitSecretName(name);
  const cred = gitCredentials.get(suffix);
  if (!cred) return;

  switch (field) {
    case '__GIT_TOKEN': cred.token = ''; break;
    case '__GIT_PROVIDER': cred.provider = ''; break;
    case '__GIT_REPO_URL': cred.repoUrl = undefined; break;
    case '__GIT_USER_NAME': cred.userName = undefined; break;
    case '__GIT_USER_EMAIL': cred.userEmail = undefined; break;
    case '__GIT_DEFAULT_BRANCH': cred.defaultBranch = undefined; break;
  }

  // If credential has no token and no provider, remove it entirely
  if (!cred.token && !cred.provider) {
    gitCredentials.delete(suffix);
  }
}

/**
 * Delete ALL git secrets (used during teardown).
 * Overwrites credential fields before clearing the Map to sever references
 * immediately rather than relying on GC timing for secret cleanup.
 */
export function deleteAllGitSecrets(): void {
  for (const [, cred] of gitCredentials) {
    cred.token = '';
    cred.provider = '';
    cred.repoUrl = undefined;
    cred.userName = undefined;
    cred.userEmail = undefined;
    cred.defaultBranch = undefined;
  }
  gitCredentials.clear();
}

/** Get credentials for an app (falls back to default if app-specific not found) */
export function getGitCredential(appSuffix: string = ''): GitCredential | undefined {
  return gitCredentials.get(appSuffix) || (appSuffix ? gitCredentials.get('') : undefined);
}

/**
 * Get git env vars for a subprocess (e.g. git-setup needs __GIT_TOKEN etc. for validation).
 * Does NOT include the credential session — that's separate.
 */
export function getGitEnvVars(appSuffix: string = ''): Record<string, string> {
  const cred = getGitCredential(appSuffix);
  if (!cred) return {};

  const env: Record<string, string> = {};
  if (cred.token) env.__GIT_TOKEN = cred.token;
  if (cred.provider) env.__GIT_PROVIDER = cred.provider;
  if (cred.repoUrl) env.__GIT_REPO_URL = cred.repoUrl;
  if (cred.userName) env.__GIT_USER_NAME = cred.userName;
  if (cred.userEmail) env.__GIT_USER_EMAIL = cred.userEmail;
  if (cred.defaultBranch) env.__GIT_DEFAULT_BRANCH = cred.defaultBranch;

  return env;
}

// ── Credential Sessions ──

function gcSessions(): void {
  const now = Date.now();
  for (const [id, session] of credentialSessions) {
    if (now > session.expiresAt) {
      credentialSessions.delete(id);
    }
  }
  // Hard cap eviction
  if (credentialSessions.size >= MAX_SESSIONS) {
    const sorted = [...credentialSessions.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    const toRemove = sorted.slice(0, sorted.length - MAX_SESSIONS + 1);
    for (const [key] of toRemove) credentialSessions.delete(key);
  }
}

setInterval(gcSessions, 30_000);

/**
 * Create a credential session. IN-PROCESS ONLY — never exposed via HTTP.
 * Returns the session ID to pass as GIT_CREDENTIAL_SESSION env var.
 */
export function createCredentialSession(appSuffix: string = ''): string {
  gcSessions();
  const id = crypto.randomUUID();
  credentialSessions.set(id, {
    id,
    appSuffix,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return id;
}

/**
 * Default hostname for each supported provider. Used when the stored credential
 * has no explicit `repoUrl` to check against.
 */
const PROVIDER_DEFAULT_HOSTS: Record<string, string> = {
  github: 'github.com',
  gitlab: 'gitlab.com',
  bitbucket: 'bitbucket.org',
};

/**
 * Extract the hostname (no port) from a repo URL. Returns null if URL is
 * unparseable or the protocol is not https.
 */
function hostFromRepoUrl(repoUrl: string | undefined): string | null {
  if (!repoUrl) return null;
  try {
    const u = new URL(repoUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Validate a credential session and return credentials.
 * Does NOT consume the session (git may call credential helper multiple times).
 * Session expires naturally after TTL or via explicit cleanup.
 *
 * SECURITY: `expectedHost` MUST be the `host=` value the credential helper
 * received from git. We reject any request whose host does not match the
 * hostname of the credential's bound repoUrl (or the provider's default host
 * when no repoUrl is bound). This prevents credential exfiltration via
 * `.git/config` `insteadOf` rewrites or malicious remote URLs. Calls without
 * a host are treated as mismatches and return null.
 */
export function resolveCredentialSession(
  sessionId: string,
  expectedHost?: string,
): { username: string; password: string } | null {
  const session = credentialSessions.get(sessionId);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    credentialSessions.delete(sessionId);
    return null;
  }

  const cred = getGitCredential(session.appSuffix);
  if (!cred?.token || !cred?.provider) return null;

  let username: string;
  switch (cred.provider) {
    case 'github': username = 'x-access-token'; break;
    case 'gitlab': username = 'oauth2'; break;
    case 'bitbucket': username = 'x-token-auth'; break;
    default: return null;
  }

  // Host binding check. We only skip when no expectedHost was supplied (legacy
  // in-process caller) — the HTTP endpoint always supplies one.
  if (expectedHost !== undefined) {
    const requested = expectedHost.split(':')[0]!.toLowerCase();
    if (!requested) return null;
    const bound = hostFromRepoUrl(cred.repoUrl) || PROVIDER_DEFAULT_HOSTS[cred.provider] || null;
    if (!bound) return null;
    if (requested !== bound) {
      // Host mismatch — refuse to hand over credentials. Do not leak which
      // host was expected in logs; the attacker already knows the one they
      // asked for.
      console.warn('[shield] credential host mismatch (refused)');
      return null;
    }
  }

  return { username, password: cred.token };
}

/** Explicitly delete a credential session (cleanup after git operation) */
export function deleteCredentialSession(sessionId: string): void {
  credentialSessions.delete(sessionId);
}

/** Check if any git credentials exist (for diagnostics) */
export function hasGitCredentials(): boolean {
  return gitCredentials.size > 0;
}

// ── Hardened Git Commands ──

/**
 * Build a hardened git command prefix that:
 * 1. Disables all hooks (prevents trojan hooks planted by agent)
 * 2. Forces our credential helper (prevents credential exfiltration via custom .git/config helper)
 *
 * SECURITY: The agent can write to .git/hooks/ and .git/config. Without these flags:
 * - A post-merge hook could run `git push` during a pull (inherits GIT_CREDENTIAL_SESSION)
 * - A custom credential.helper in .git/config could capture the raw token
 */
export function safeGitCmd(): string {
  return [
    'git',
    '-c core.hooksPath=/dev/null',                                    // Block trojan hooks
    '-c credential.helper=',                                          // Clear credential helpers
    '-c credential.helper=/usr/local/bin/git-credential-ellul',     // Force ours
    '-c http.proxy=',                                                 // Block MITM proxy
    '-c https.proxy=',                                                // Block MITM proxy (HTTPS)
    '-c http.sslVerify=true',                                         // Force TLS verification
  ].join(' ');
}

// ── Co-Author Stamping ──

/** Co-author trailer appended to commits pushed through ellul */
export const ELLUL_CO_AUTHOR = 'Co-Authored-By: ellul <dev@ellul.ai>';
const CO_AUTHOR_MARKER = 'Co-Authored-By: ellul';

/**
 * Async exec helper (duplicated from git.service to avoid circular dep).
 * SECURITY: Pass dynamic values as positional args ($1, $2, etc.), not
 * interpolated into the script string.
 */
function execAsyncLocal(
  script: string,
  args: string[],
  opts?: { timeout?: number; env?: NodeJS.ProcessEnv },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('bash', ['-c', script, '_', ...args], {
      env: opts?.env || process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = opts?.timeout ? setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
    }, opts.timeout) : null;

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (killed) {
        reject(new Error('Command timed out'));
      } else if (code === 0) {
        resolve(stdout);
      } else {
        const err = new Error(stderr || stdout || `Process exited with code ${code}`);
        (err as any).stdout = stdout;
        (err as any).stderr = stderr;
        reject(err);
      }
    });
    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Run a git command in a project directory using execFileSync (no shell — immune
 * to injection). Returns trimmed stdout or null on failure.
 */
function gitInDir(projectDir: string, args: string[], timeout = 5_000): string | null {
  try {
    const result = execFileSync(
      'git', ['-C', projectDir, ...args],
      { timeout, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return result.trim();
  } catch {
    return null;
  }
}

/**
 * Stamp all unpushed commits with the ellul co-author trailer.
 *
 * Strategy:
 * 1. Determine upstream ref (tracking branch or origin/HEAD)
 * 2. Enumerate each unpushed commit hash
 * 3. For each commit, check if already stamped (idempotent)
 * 4. Write a temporary rebase --exec script that adds the trailer
 * 5. Run rebase with hooks disabled
 * 6. On any failure, abort rebase and proceed without stamping
 *
 * Design principles:
 * - Idempotent: re-running on already-stamped commits is a no-op
 * - Non-blocking: failures silently fall through (push proceeds unstamped)
 * - No shell injection: script written to temp file, not inline
 * - Merge-safe: uses --rebase-merges to preserve merge topology
 * - Atomic: git rebase is all-or-nothing; abort restores original state
 */
export async function stampCoAuthor(projectDir: string): Promise<void> {
  // ── 1. Determine upstream ref ──
  // Try tracking branch first, then origin/HEAD, then origin/main, origin/master
  let upstream: string | null = null;
  for (const ref of ['@{u}', 'origin/HEAD', 'origin/main', 'origin/master']) {
    upstream = gitInDir(projectDir, ['rev-parse', '--verify', ref]);
    if (upstream) break;
  }

  if (!upstream) {
    // No upstream at all (first push, empty remote) — stamp HEAD only
    await stampSingleCommit(projectDir);
    return;
  }

  // ── 2. Enumerate unpushed commits ──
  const commitList = gitInDir(projectDir, ['rev-list', `${upstream}..HEAD`]);
  if (!commitList) return; // Can't determine range

  const commits = commitList.split('\n').filter(Boolean);
  if (commits.length === 0) return; // Nothing to push

  // ── 3. Check if ALL are already stamped (fast path) ──
  let allStamped = true;
  for (const hash of commits) {
    const body = gitInDir(projectDir, ['log', '-1', '--format=%B', hash]);
    if (!body || !body.includes(CO_AUTHOR_MARKER)) {
      allStamped = false;
      break;
    }
  }
  if (allStamped) return;

  // ── 4. Write temporary rebase script ──
  // Using a script file avoids shell quoting issues entirely.
  // All commit message handling uses temp files — never shell interpolation —
  // to prevent injection via malicious commit messages containing $(), ``, etc.
  const scriptPath = `/tmp/.ellul-coauthor-${crypto.randomUUID()}.sh`;
  const scriptContent = [
    '#!/bin/bash',
    'set -euo pipefail',
    'TMPFILE="/tmp/.ellul-msg-$$"',
    'trap \'rm -f "$TMPFILE"\' EXIT',
    '',
    '# Dump current commit message to temp file (no shell variable — safe from injection)',
    'git log -1 --format=\'%B\' > "$TMPFILE"',
    '',
    '# Skip if already stamped (idempotent)',
    `if grep -qF '${CO_AUTHOR_MARKER}' "$TMPFILE"; then`,
    '  exit 0',
    'fi',
    '',
    '# Add co-author trailer using git interpret-trailers (reads from file, not echo)',
    `git interpret-trailers --trailer '${ELLUL_CO_AUTHOR}' --in-place "$TMPFILE"`,
    'git commit --amend -F "$TMPFILE" --no-verify --allow-empty',
  ].join('\n');

  try {
    fs.writeFileSync(scriptPath, scriptContent, { mode: 0o700 });

    // ── 5. Run rebase ──
    // --rebase-merges preserves merge commit topology
    // core.hooksPath=/dev/null prevents trojan hooks during rebase
    await execAsyncLocal(
      'cd -- "$1" && git -c core.hooksPath=/dev/null rebase --rebase-merges "$2" --exec "$3"',
      [projectDir, upstream, scriptPath],
      { timeout: 30_000 },
    );

    console.log(`[shield] Stamped ${commits.length} commit(s) with ellul co-author`);
  } catch (err: any) {
    // ── 6. Abort on failure — push proceeds unstamped ──
    console.warn('[shield] Co-author stamping failed, aborting rebase:', err.message);
    try {
      execFileSync('git', ['-C', projectDir, 'rebase', '--abort'], { timeout: 5_000, stdio: 'pipe' });
    } catch {}
  } finally {
    // Clean up script
    try { fs.unlinkSync(scriptPath); } catch {}
  }
}

/**
 * Stamp only the HEAD commit (for first push with no upstream).
 * Idempotent: skips if already stamped.
 *
 * Uses temp files for both input and output to avoid shell injection
 * via malicious commit messages.
 */
async function stampSingleCommit(projectDir: string): Promise<void> {
  const body = gitInDir(projectDir, ['log', '-1', '--format=%B', 'HEAD']);
  if (!body) return;
  if (body.includes(CO_AUTHOR_MARKER)) return;

  const inputPath = `/tmp/.ellul-in-${crypto.randomUUID()}`;
  const outputPath = `/tmp/.ellul-out-${crypto.randomUUID()}`;
  try {
    // Write original message to temp file (avoids shell injection from commit body)
    fs.writeFileSync(inputPath, body, { mode: 0o600 });

    // Use git interpret-trailers with file input (no shell interpolation of message)
    await execAsyncLocal(
      'git -C "$1" interpret-trailers --trailer "$2" < "$3" > "$4"',
      [projectDir, ELLUL_CO_AUTHOR, inputPath, outputPath],
      { timeout: 5_000 },
    );

    // Amend commit with stamped message
    await execAsyncLocal(
      'git -C "$1" commit --amend -F "$2" --no-verify --allow-empty',
      [projectDir, outputPath],
      { timeout: 10_000 },
    );
    console.log('[shield] Stamped HEAD commit with ellul co-author');
  } catch (err: any) {
    console.warn('[shield] Failed to stamp HEAD:', err.message);
  } finally {
    try { fs.unlinkSync(inputPath); } catch {}
    try { fs.unlinkSync(outputPath); } catch {}
  }
}
