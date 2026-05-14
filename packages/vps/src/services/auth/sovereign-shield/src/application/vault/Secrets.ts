// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Secrets Service — Per-Sandbox, Per-Environment
 *
 * Handles encrypted secret decryption and environment file management.
 * Secrets are encrypted using ML-KEM-1024 + AES-256-GCM (post-quantum)
 * and decrypted here using the VPS private key.
 *
 * ── Scope ────────────────────────────────────────────────────────────────
 *
 * Secrets are scoped to the sandbox — the only hard OS-level containment
 * boundary on this VPS. Per-app secrets would be security theater: two
 * apps inside the same sandbox share a UID, mount namespace and file
 * system, so app-A can trivially read app-B's env file. The sandbox IS
 * the security boundary; secrets follow it.
 *
 * Per-sandbox, per-environment layout:
 *   /etc/ellul/secrets/{sandboxId}.env       — production secrets (root:shield 660)
 *   /etc/ellul/secrets/{sandboxId}.dev.env   — development secrets (root:shield 660)
 *   /etc/ellul/secrets/{sandboxId}.names     — production names (root:shield 664)
 *   /etc/ellul/secrets/{sandboxId}.dev.names — development names (root:shield 664)
 *   ~/.ellul-cli-env                         — CLI API keys (svcUser:svcUser 600)
 *
 * Environment model:
 *   - "production" — used by deployed apps (default)
 *   - "development" — used by preview server
 *
 * The secrets directory is root:shield 2770 (SGID); new files inherit the
 * shield group. The agent is NOT in the shield group, so kernel DAC blocks
 * direct .env reads.
 *
 * ── Typing ───────────────────────────────────────────────────────────────
 *
 * All public functions take a branded `SandboxId` from `@ellul.ai/types`.
 * Raw strings are rejected at compile time — every call site must parse
 * the scope at the HTTP boundary via `SandboxIdSchema` or `parseSandboxId`.
 * There is NO `_global` fallback — the agent always runs inside a sandbox.
 *
 * Format for env files:
 *   # ellul Environment
 *   # Updated: <ISO timestamp>
 *   export NAME="VALUE"
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execSync, execFileSync } from 'child_process';
import { x25519 } from '@noble/curves/ed25519.js';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import type { HybridKemPrivateKey } from '@ellul.ai/pqc-types';
import { HYBRID_KEM_HKDF_INFO } from '@ellul.ai/pqc-types';
import { parseSandboxId, type SandboxId } from '@ellul.ai/types';

import { SVC_USER, SVC_HOME } from '../../config';
import { isGitSecret, setGitSecret, deleteGitSecret } from '../credentials/GitCredentials';
// Imported lazily inside `readRuntimeEnv` to avoid a top-level cycle with
// `org-mode.service.ts` (which imports nothing from secrets but does import
// from `config` + `audit.service`; pulling it here keeps the dependency
// graph clean regardless of future changes to org-mode).

const PRIVATE_KEY_PATH = '/etc/ellul-bootstrap/node.key';

// Per-sandbox secrets directory — root:shield 2770 (SGID, agent cannot access directly)
const SECRETS_DIR = '/etc/ellul/secrets';

/**
 * Reserved filename for org-mode cross-sandbox environment variables.
 *
 * On an **org-mode** VPS (future — see docs/v2/security/15-org-mode.md), a team can set
 * environment variables at the org level that apply across every sandbox
 * in the org. Those get merged at runtime into every sandbox's effective
 * environment via `readRuntimeEnv`. There is no per-sandbox UI path that
 * writes to this file — it is managed exclusively through the org-secret
 * routes (`/_auth/org/secrets`) and the `setOrgSecret` service.
 *
 * The sandbox-scoped mutation API (`setSecret`, `deleteSecret`,
 * `setSecretsBulk`) intentionally does NOT read or write this file; a
 * sandbox secret and an org secret are separate concepts.
 */
const ORG_OVERLAY_FILE = path.join(SECRETS_DIR, '_global.env');

// CLI keys — svcUser:svcUser 600, agent CAN read (needed for claude/codex/cursor CLIs)
const CLI_ENV_FILE = `${SVC_HOME}/.ellul-cli-env`;

// CLI API keys that the agent needs access to (for running AI coding tools)
const CLI_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'DEEPSEEK_API_KEY',
  'XAI_API_KEY',
  'MISTRAL_API_KEY',
]);

export type SecretEnvironment = 'production' | 'development';
const VALID_ENVIRONMENTS: ReadonlySet<string> = new Set(['production', 'development']);

export function isValidEnvironment(env: string): env is SecretEnvironment {
  return VALID_ENVIRONMENTS.has(env);
}

export interface HybridKemEncryptedEnvelope {
  _e2ee: true;
  _pqc: 3;
  x25519_eph_pub: string; // Base64 ephemeral X25519 public key (32 bytes)
  mlkem_ct: string;       // Base64 ML-KEM-1024 ciphertext (1,568 bytes)
  iv: string;             // Base64 12-byte IV
  encryptedData: string;  // Base64 AES-GCM ciphertext + 16-byte auth tag
}

// ── Path helpers ────────────────────────────────────────────────────────────
//
// `SandboxId` is already validated against `/^sbx-[a-z0-9]{7}$/` at the HTTP
// boundary by `SandboxIdSchema` / `parseSandboxId`, so path-traversal defence
// is taken care of by the type system — no runtime re-sanitization needed on
// public APIs. Internal helpers (org-secret file-path segments) use the
// narrow, purpose-built `sanitizeFilenameSegment` below.

/** Environment file suffix: production = '' (backward compat), development = '.dev' */
function envSuffix(env: SecretEnvironment): string {
  return env === 'development' ? '.dev' : '';
}

function secretsPath(sandboxId: SandboxId, env: SecretEnvironment = 'production'): string {
  return path.join(SECRETS_DIR, `${sandboxId}${envSuffix(env)}.env`);
}

function namesPath(sandboxId: SandboxId, env: SecretEnvironment = 'production'): string {
  return path.join(SECRETS_DIR, `${sandboxId}${envSuffix(env)}.names`);
}

/**
 * Sanitize a generic filename segment for use inside the org-secrets
 * subtree (NOT sandbox paths — those use `SandboxId` directly). Strips
 * anything outside `[a-zA-Z0-9_-]`; rejects inputs that had to be
 * stripped, so invalid input fails loudly.
 */
function sanitizeFilenameSegment(input: string): string {
  const safe = input.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe || safe !== input) {
    throw new Error(`Invalid filename segment: ${input}`);
  }
  return safe;
}

// ── Decryption ──

// Private key cached as Buffer (not string) so we can zeroize on eviction.
// JS strings are immutable and cannot be zeroized — Buffer.fill(0) works.
let privateKeyCache: Buffer | null = null;
let privateKeyMtime: number = 0;

/**
 * Read the private key JSON, re-reading if the file changed on disk.
 *
 * On wake, shield may start before vault bind mounts complete. The root FS
 * has a DIFFERENT node.key (from the cache-build snapshot) than the vault.
 * Without mtime tracking, the wrong key gets cached forever and all
 * decryption calls fail.
 */
function getPrivateKey(): string {
  const mtime = fs.statSync(PRIVATE_KEY_PATH).mtimeMs;
  if (privateKeyCache && mtime === privateKeyMtime) {
    return privateKeyCache.toString('utf8');
  }
  // Zeroize previous cache before replacing
  if (privateKeyCache) {
    privateKeyCache.fill(0);
  }
  privateKeyCache = fs.readFileSync(PRIVATE_KEY_PATH);
  privateKeyMtime = mtime;
  return privateKeyCache.toString('utf8');
}

/**
 * Decrypt a hybrid X25519+ML-KEM-1024 + AES-256-GCM envelope using the VPS private key.
 *
 * Flow:
 *   1. X25519 DH → x25519_ss (32 bytes)
 *   2. ML-KEM-1024 decapsulate → mlkem_ss (32 bytes)
 *   3. HKDF-SHA256(x25519_ss || mlkem_ss, SHA-256(eph_pub || ct), info, 32) → AES key
 *   4. AES-256-GCM decrypt
 *
 * HKDF raw-byte invariants: ALL inputs are raw bytes, never base64 or hex strings.
 */
export function decryptHybridKemEnvelope(envelope: HybridKemEncryptedEnvelope): string {
  const privateKeyJson = getPrivateKey();
  let priv: HybridKemPrivateKey;
  try {
    priv = JSON.parse(privateKeyJson);
  } catch {
    throw new Error('PQC: Failed to parse private key JSON');
  }

  if (priv.version !== 3 || priv.algorithm !== 'X25519+ML-KEM-1024') {
    throw new Error(`PQC: Unsupported key version/algorithm: ${priv.version}/${priv.algorithm} — expected 3/X25519+ML-KEM-1024`);
  }

  // Decode all key material from base64 to raw bytes
  const x25519_sk = Buffer.from(priv.x25519_sk, 'base64');
  const mlkem_dk = new Uint8Array(Buffer.from(priv.mlkem_dk, 'base64'));
  const x25519_eph_pub = Buffer.from(envelope.x25519_eph_pub, 'base64');
  const mlkem_ct = new Uint8Array(Buffer.from(envelope.mlkem_ct, 'base64'));

  // Step 1: X25519 DH
  const x25519_ss = x25519.getSharedSecret(x25519_sk, x25519_eph_pub);

  // Step 2: ML-KEM-1024 decapsulate
  const mlkem_ss = ml_kem1024.decapsulate(mlkem_ct, mlkem_dk);

  // Step 3: HKDF-SHA256 — ALL raw bytes, no encoded strings
  const ikm = Buffer.concat([Buffer.from(x25519_ss), Buffer.from(mlkem_ss)]);
  const salt = crypto.createHash('sha256')
    .update(Buffer.from(x25519_eph_pub))
    .update(Buffer.from(mlkem_ct))
    .digest();
  const derivedKey = Buffer.from(
    crypto.hkdfSync('sha256', ikm, salt, HYBRID_KEM_HKDF_INFO, 32)
  );

  // Step 4: AES-256-GCM decrypt
  const data = Buffer.from(envelope.encryptedData, 'base64');
  const authTag = data.subarray(-16);
  const ciphertext = data.subarray(0, -16);

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    derivedKey,
    Buffer.from(envelope.iv, 'base64'),
  );
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');

  // Zeroize all sensitive material
  x25519_sk.fill(0);
  x25519_ss.fill(0);
  mlkem_ss.fill(0);
  ikm.fill(0);
  derivedKey.fill(0);

  return plaintext;
}

/**
 * Decrypt an envelope with automatic format detection.
 * Supports only hybrid KEM (v3) envelopes — no legacy fallback.
 */
export function decryptEnvelope(envelope: HybridKemEncryptedEnvelope): string {
  if ('_pqc' in envelope && envelope._pqc === 3) {
    return decryptHybridKemEnvelope(envelope);
  }
  throw new Error(`PQC: Only hybrid KEM envelopes (_pqc: 3) are accepted — got _pqc: ${(envelope as any)._pqc ?? 'missing'}`);
}

// ── Env File I/O ──

/** Parse an env file into a Map of name → value. */
function parseEnvFile(filePath: string): Map<string, string> {
  const entries = new Map<string, string>();
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^export\s+([a-zA-Z_][a-zA-Z0-9_]*)=["'](.*)["']$/);
      if (match) {
        entries.set(match[1]!, match[2]!);
      }
    }
  } catch (err: any) {
    if (err.code !== 'ENOENT' && err.code !== 'EACCES') throw err;
  }
  return entries;
}

/**
 * Write entries to an env file.
 *
 * For the per-app secrets directory (/etc/ellul/secrets/), which is 2770 root:shield (SGID),
 * the shield process CAN create new files — they automatically inherit the shield group.
 *
 * For CLI keys (~/.ellul-cli-env), falls back to tmp+rename if needed.
 */
function writeEnvFile_(
  filePath: string,
  entries: Map<string, string>,
  ownership: string,
  mode: number,
): void {
  const lines = [
    '# ellul Environment',
    `# Updated: ${new Date().toISOString()}`,
    '',
  ];
  for (const [name, value] of entries) {
    const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    lines.push(`export ${name}="${escaped}"`);
  }

  const content = lines.join('\n') + '\n';

  // Always use atomic write: tmp → fsync → rename.
  // Direct writeFileSync to an existing file is NOT atomic — a crash mid-write
  // corrupts the file. tmp→rename is atomic on all POSIX filesystems.
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tmpPath = filePath + '.tmp';
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmpPath, 'w', mode);
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    // Set ownership if file is new (existing files preserve perms via rename)
    if (!fs.existsSync(filePath)) {
      try {
        execFileSync('chown', [ownership, tmpPath], { stdio: 'ignore' });
      } catch {
        // Best effort — may fail in test environments
      }
    }

    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // Clean up orphaned temp file on ANY error (prevents plaintext leak on disk)
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

// ── Per-sandbox Read/Write ──────────────────────────────────────────────────

/**
 * Read secrets for a specific sandbox and environment.
 * Returns only this sandbox's env file — no `_global` merge, no scope
 * layering. Other sandboxes' secrets are physically unreachable.
 */
export function readSecrets(
  sandboxId: SandboxId,
  env: SecretEnvironment = 'production',
): Map<string, string> {
  return parseEnvFile(secretsPath(sandboxId, env));
}

/**
 * Read CLI keys only (svcUser:svcUser 600, agent CAN read).
 */
export function readCliKeys(): Map<string, string> {
  return parseEnvFile(CLI_ENV_FILE);
}

/**
 * Runtime env view for a sandbox: VPS-wide _global.env overlay merged with
 * the sandbox's own env (sandbox keys win). Read-only from the typed API.
 */
export function readRuntimeEnv(
  sandboxId: SandboxId,
  env: SecretEnvironment = 'production',
): Map<string, string> {
  const merged = new Map<string, string>();

  for (const [k, v] of parseEnvFile(ORG_OVERLAY_FILE)) merged.set(k, v);
  for (const [k, v] of readSecrets(sandboxId, env)) merged.set(k, v);

  return merged;
}

/**
 * Read ALL secrets+CLI keys for a specific sandbox and environment.
 * Used internally for routing when setting/deleting secrets.
 */
export function readEnvFile(
  sandboxId: SandboxId,
  env: SecretEnvironment = 'production',
): Map<string, string> {
  const combined = new Map<string, string>();
  for (const [k, v] of readSecrets(sandboxId, env)) combined.set(k, v);
  for (const [k, v] of parseEnvFile(CLI_ENV_FILE)) combined.set(k, v);
  return combined;
}

/**
 * Build an export string from sandbox secrets for injection into process env.
 */
export function buildEnvExportString(
  sandboxId: SandboxId,
  env: SecretEnvironment = 'production',
): string {
  const secrets = readEnvFile(sandboxId, env);
  const lines: string[] = [];
  for (const [name, value] of secrets) {
    const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    lines.push(`export ${name}="${escaped}"`);
  }
  return lines.join('\n');
}

/**
 * Build a NUL-delimited env buffer for piping to ellul-env-loader.sh.
 * Format: KEY=value\0KEY2=value2\0
 *
 * SECURITY: NUL-delimited format prevents shell metacharacter injection.
 * Values are treated as literal byte sequences — no eval, no shell interpretation.
 */
export function buildNulDelimitedEnv(envMap: Record<string, string>): Buffer {
  const pairs = Object.entries(envMap).map(([k, v]) => `${k}=${v}`);
  // Each pair is NUL-terminated (including the last one)
  return Buffer.from(pairs.join('\0') + '\0');
}

/**
 * Write secrets map to the appropriate files for a specific sandbox and
 * environment. CLI keys go to ~/.ellul-cli-env (agent-readable, one set per
 * service user). Sandbox secrets go to /etc/ellul/secrets/{sandboxId}[.dev].env
 * (agent-blocked). Secret names go to .names (agent-readable).
 */
export function writeEnvFile(
  secrets: Map<string, string>,
  sandboxId: SandboxId,
  env: SecretEnvironment = 'production',
): void {
  const sandboxSecrets = new Map<string, string>();
  const cliKeys = new Map<string, string>();

  for (const [name, value] of secrets) {
    if (CLI_KEYS.has(name)) {
      cliKeys.set(name, value);
    } else {
      sandboxSecrets.set(name, value);
    }
  }

  // Sandbox secrets: root:shield 660 — agent cannot read (SGID dir inherits shield group)
  writeEnvFile_(secretsPath(sandboxId, env), sandboxSecrets, 'root:shield', 0o660);
  // CLI keys: svcUser:svcUser 600 — agent can read (shared across sandboxes,
  // needed for AI tools). Only write if there are CLI keys to write or the
  // file already exists (avoid EACCES when shield-runner tries to create a
  // file in $SVC_HOME it doesn't own). ProtectHome=read-only blocks writes
  // to $SVC_HOME — catch and log rather than crash.
  if (cliKeys.size > 0 || fs.existsSync(CLI_ENV_FILE)) {
    try {
      writeEnvFile_(CLI_ENV_FILE, cliKeys, `${SVC_USER}:${SVC_USER}`, 0o600);
    } catch (err) {
      console.warn('[shield] CLI env write failed (ProtectHome?):', (err as Error).message);
    }
  }

  // Secret names list (no values) — agent-readable for context generation
  const names = Array.from(sandboxSecrets.keys()).join('\n');
  try {
    const nPath = namesPath(sandboxId, env);
    fs.writeFileSync(nPath, names ? names + '\n' : '', { mode: 0o644 });
    // Ensure correct ownership (SGID should handle group, but be explicit)
    try { execFileSync('chown', ['root:shield', nPath], { stdio: 'ignore' }); execFileSync('chmod', ['664', nPath], { stdio: 'ignore' }); } catch {}
  } catch {}
}

// ── Public API ──

/**
 * Set a secret: decrypt the envelope and store it on the per-sandbox env file.
 *
 * For setting git credentials (`__GIT_*`) — which are memory-only and do NOT
 * participate in sandbox scope — call `setGitCredentialEncrypted` instead.
 */
export function setSecret(
  name: string,
  envelope: HybridKemEncryptedEnvelope,
  sandboxId: SandboxId,
  env: SecretEnvironment = 'production',
): void {
  if (isGitSecret(name)) {
    throw new Error(
      `setSecret called with git credential name "${name}" — use setGitCredentialEncrypted instead`,
    );
  }
  const value = decryptEnvelope(envelope);
  const secrets = readEnvFile(sandboxId, env);
  secrets.set(name, value);
  writeEnvFile(secrets, sandboxId, env);
}

/**
 * Decrypt an encrypted envelope containing a git credential (`__GIT_*`) and
 * store it in the in-memory git-credential cache. Git credentials are not
 * sandbox-scoped — they live in a single process-memory map managed by
 * `git-credentials.service.ts`. Kept separate from `setSecret` so the
 * sandbox-scoping contract on the latter is watertight.
 */
export function setGitCredentialEncrypted(
  name: string,
  envelope: HybridKemEncryptedEnvelope,
): void {
  if (!isGitSecret(name)) {
    throw new Error(`setGitCredentialEncrypted requires __GIT_* name, got "${name}"`);
  }
  const value = decryptEnvelope(envelope);
  setGitSecret(name, value);
}

/** Delete a git credential from the in-memory cache. Not sandbox-scoped. */
export function deleteGitCredential(name: string): void {
  if (!isGitSecret(name)) {
    throw new Error(`deleteGitCredential requires __GIT_* name, got "${name}"`);
  }
  deleteGitSecret(name);
}

/**
 * Set a secret from a plaintext value — bypasses the PQC envelope.
 *
 * Used by the internal-token-authenticated routes that originate inside
 * the shielded perimeter (agent-bridge platform tools after a user-approved
 * `env` gate). The PQC envelope exists to protect untrusted browser → VPS
 * transport; callers inside the trust boundary don't need it.
 *
 * The name MUST pass POSIX env-var validation — rejected upstream at the
 * route layer so this is defense-in-depth.
 */
export function setSecretPlain(
  name: string,
  value: string,
  sandboxId: SandboxId,
  env: SecretEnvironment = 'production',
): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid secret name: ${name} (must match POSIX env var syntax)`);
  }
  if (isGitSecret(name)) {
    throw new Error(
      `setSecretPlain called with git credential name "${name}" — use setGitSecret directly`,
    );
  }
  const secrets = readEnvFile(sandboxId, env);
  secrets.set(name, value);
  writeEnvFile(secrets, sandboxId, env);
}

/**
 * Set multiple secrets atomically for a specific sandbox and environment.
 * Git secrets are routed to memory; others go to the per-sandbox env file.
 */
export function setSecretsBulk(
  items: Array<{ name: string; envelope: HybridKemEncryptedEnvelope }>,
  sandboxId: SandboxId,
  env: SecretEnvironment = 'production',
): void {
  // Reject git-credential names in a sandbox-scoped bulk call — route them
  // through setGitCredentialEncrypted explicitly so the sandbox scoping
  // contract stays invariant.
  for (const item of items) {
    if (isGitSecret(item.name)) {
      throw new Error(
        `setSecretsBulk refuses git credential name "${item.name}" — call setGitCredentialEncrypted per credential`,
      );
    }
  }
  const secrets = readEnvFile(sandboxId, env);
  for (const item of items) {
    secrets.set(item.name, decryptEnvelope(item.envelope));
  }
  writeEnvFile(secrets, sandboxId, env);
}

/**
 * Delete a secret from a specific sandbox and environment.
 * Git secrets are removed from memory; others from the per-sandbox env file.
 */
export function deleteSecret(
  name: string,
  sandboxId: SandboxId,
  env: SecretEnvironment = 'production',
): boolean {
  if (isGitSecret(name)) {
    throw new Error(
      `deleteSecret refuses git credential name "${name}" — call deleteGitCredential instead`,
    );
  }
  const secrets = readEnvFile(sandboxId, env);
  const existed = secrets.delete(name);
  if (existed) {
    writeEnvFile(secrets, sandboxId, env);
  }
  return existed;
}

/**
 * List secret names (no values exposed).
 *
 * With `sandboxId`: returns names for that specific sandbox and environment.
 * Without: returns every sandbox's names grouped by sandbox id —
 *   `{ "sbx-xyz": string[], ... }`.
 */
export function listSecrets(
  sandboxId?: SandboxId,
  env: SecretEnvironment = 'production',
): string[] | Record<string, string[]> {
  if (sandboxId) {
    const secrets = readEnvFile(sandboxId, env);
    return Array.from(secrets.keys());
  }

  // No sandbox filter: enumerate every sandbox's .names file.
  const result: Record<string, string[]> = {};
  const suffix = envSuffix(env);
  const namesSuffix = `${suffix}.names`;
  try {
    const files = fs.readdirSync(SECRETS_DIR);
    for (const file of files) {
      if (!file.endsWith(namesSuffix)) continue;
      const slug = file.slice(0, -namesSuffix.length);
      if (!slug) continue;
      // Only accept well-formed sandbox slugs — skip any stray files.
      try { parseSandboxId(slug); } catch { continue; }
      try {
        const content = fs.readFileSync(path.join(SECRETS_DIR, file), 'utf8').trim();
        result[slug] = content ? content.split('\n').filter(Boolean) : [];
      } catch {
        result[slug] = [];
      }
    }
  } catch (err: any) {
    if (err.code !== 'ENOENT' && err.code !== 'EACCES') throw err;
  }
  return result;
}

/**
 * Check which environments have secrets for a given sandbox.
 * Returns { production: boolean, development: boolean }.
 */
export function listEnvironments(sandboxId: SandboxId): Record<SecretEnvironment, boolean> {
  return {
    production: fs.existsSync(path.join(SECRETS_DIR, `${sandboxId}.env`)),
    development: fs.existsSync(path.join(SECRETS_DIR, `${sandboxId}.dev.env`)),
  };
}

/**
 * Clean up all secret files for a sandbox (called on sandbox teardown).
 * Removes both .env and .names files for all environments.
 * Returns list of files that were deleted.
 */
export function cleanupSandboxSecrets(sandboxId: SandboxId): string[] {
  const deleted: string[] = [];
  for (const ext of ['.env', '.names', '.dev.env', '.dev.names']) {
    const filePath = path.join(SECRETS_DIR, `${sandboxId}${ext}`);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        deleted.push(`${sandboxId}${ext}`);
      }
    } catch (e) {
      console.warn(`[shield] Could not clean ${filePath}: ${(e as Error).message}`);
    }
  }
  return deleted;
}

/**
 * Migrate existing __GIT_* secrets out of every sandbox's env file to
 * the in-memory git-credentials store. Called once on startup to ensure
 * a clean transition — git credentials must never touch disk.
 */
export function migrateGitSecretsFromEnvFile(): void {
  let files: string[] = [];
  try { files = fs.readdirSync(SECRETS_DIR); } catch { return; }
  for (const file of files) {
    // Match .env and .dev.env files whose slug is a valid sandbox id.
    const m = file.match(/^(sbx-[a-z0-9]{7})(\.dev)?\.env$/);
    if (!m) continue;
    const sandboxId = m[1] as SandboxId;
    const env: SecretEnvironment = m[2] === '.dev' ? 'development' : 'production';

    const secrets = readEnvFile(sandboxId, env);
    let changed = false;
    for (const [name, value] of secrets) {
      if (isGitSecret(name)) {
        setGitSecret(name, value);
        secrets.delete(name);
        changed = true;
      }
    }
    if (changed) {
      writeEnvFile(secrets, sandboxId, env);
      console.log(`[shield] Migrated git secrets from ${sandboxId} (${env}) to memory`);
    }
  }
}
