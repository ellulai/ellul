// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Master secret (keychain or ~/.ellul/master.key) → HKDF domain-separated keys → local STS JWS.
// Workspace fingerprint = SHA-256(slug:canonicalPath) prevents cross-workspace token reuse.
// Operator signatures (SLH-DSA-SHA2-128s) domain-separated to reject cross-op reuse.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

// ── Constants ──

const KEYCHAIN_SERVICE = 'ai.ellul.local-daemon';
const KEYCHAIN_ACCOUNT = 'master-secret';

const CONFIG_DIR = path.join(process.env.HOME || '~', '.ellul');
const MASTER_KEY_FILE = path.join(CONFIG_DIR, 'master.key');

const HKDF_HASH = 'sha256';
const HKDF_KEY_LENGTH = 32;

/** STS token default TTL: 15 minutes. */
export const STS_TOKEN_TTL_SECONDS = 15 * 60;

/** Operator signature timestamp tolerance: 30 seconds. */
const OPERATOR_TIMESTAMP_TOLERANCE_MS = 30_000;

// ── Types ──

export interface DerivedKeys {
  /** HMAC-SHA256 key for local STS token signing/verification. */
  stsSigningKey: Buffer;
  /** HMAC-SHA256 key for sync receipt signing. */
  receiptKey: Buffer;
  /** AES-256-GCM key for encrypting secrets at rest. */
  secretsEncKey: Buffer;
}

export interface LocalStsPayload {
  /** Subject: immutable project slug (e.g., "local-my-api-a3f8"). */
  sub: string;
  /** Canonical absolute path of workspace root. */
  dir: string;
  /** Workspace fingerprint: SHA-256(slug + ":" + canonicalPath). */
  fpr: string;
  /** Token type discriminator. Prevents cross-protocol confusion. */
  typ: 'STS';
  /** Issued at (unix seconds). */
  iat: number;
  /** Expiration (unix seconds). */
  exp: number;
  /** Unique token ID. */
  jti: string;
}

export type StsVerifyResult =
  | { valid: true; payload: LocalStsPayload }
  | { valid: false; reason: 'malformed' | 'signature_invalid' | 'expired' | 'invalid_claims' | 'fingerprint_mismatch' };

// ── OS Keychain ──
// Reuses the same spawnSync pattern as cli-host.ts but with a different
// service name to avoid collision with the VPS session keychain entries.

function keychainGet(service: string, account: string): string | null {
  if (process.platform === 'darwin') {
    const result = spawnSync('security', [
      'find-generic-password', '-s', service, '-a', account, '-w',
    ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return result.status === 0 ? result.stdout.trim() : null;
  }

  // Linux: secret-tool
  const result = spawnSync('secret-tool', [
    'lookup', 'service', service, 'account', account,
  ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  return result.status === 0 ? result.stdout.trim() : null;
}

function keychainSet(service: string, account: string, value: string): boolean {
  if (process.platform === 'darwin') {
    // Delete first (macOS keychain doesn't support atomic update)
    spawnSync('security', [
      'delete-generic-password', '-s', service, '-a', account,
    ], { stdio: 'pipe' });

    const result = spawnSync('security', [
      'add-generic-password', '-s', service, '-a', account, '-w', value,
    ], { stdio: 'pipe' });
    return result.status === 0;
  }

  // Linux: secret-tool reads the secret from stdin
  const result = spawnSync('secret-tool', [
    'store', '--label', `ellul local daemon: ${account}`,
    'service', service, 'account', account,
  ], { input: value, stdio: ['pipe', 'pipe', 'pipe'] });
  return result.status === 0;
}

// ── Master Secret Management ──

/**
 * Resolution: keychain → ~/.ellul/master.key (0600) → generate+store. Warns on file fallback.
 */
export function initMasterSecret(log: (msg: string) => void): Buffer {
  // Try keychain first
  const keychainValue = keychainGet(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
  if (keychainValue) {
    const buf = Buffer.from(keychainValue, 'hex');
    if (buf.length === 32) {
      log('[crypto] Master secret loaded from OS keychain');
      return buf;
    }
    log('[crypto] WARNING: Keychain master secret has invalid length, regenerating');
  }

  // Try fallback file
  try {
    const raw = fs.readFileSync(MASTER_KEY_FILE, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(raw)) {
      log('[crypto] WARNING: Master secret loaded from fallback file (~/.ellul/master.key). '
        + 'OS keychain storage is recommended for stronger protection.');
      return Buffer.from(raw, 'hex');
    }
    log('[crypto] WARNING: Fallback master key file has invalid format, regenerating');
  } catch {
    // File doesn't exist or can't be read — generate new
  }

  // Generate new secret
  const masterSecret = crypto.randomBytes(32);
  const hex = masterSecret.toString('hex');

  // Ensure config dir exists with strict permissions
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });

  // Try to store in keychain
  if (keychainSet(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, hex)) {
    log('[crypto] Master secret generated and stored in OS keychain');
    return masterSecret;
  }

  // Fallback: write to file
  fs.writeFileSync(MASTER_KEY_FILE, hex + '\n', { mode: 0o600 });
  log('[crypto] WARNING: OS keychain unavailable. Master secret stored in ~/.ellul/master.key (mode 0600). '
    + 'This is weaker than keychain storage — any same-user process can read the file.');
  return masterSecret;
}

// ── HKDF Key Derivation ──

// HKDF-SHA256 with unique info strings per domain.
export function deriveKeys(masterSecret: Buffer): DerivedKeys {
  return {
    stsSigningKey: Buffer.from(
      crypto.hkdfSync(HKDF_HASH, masterSecret, Buffer.alloc(0), 'ellul:sts-signing:v1', HKDF_KEY_LENGTH),
    ),
    receiptKey: Buffer.from(
      crypto.hkdfSync(HKDF_HASH, masterSecret, Buffer.alloc(0), 'ellul:receipt-signing:v1', HKDF_KEY_LENGTH),
    ),
    secretsEncKey: Buffer.from(
      crypto.hkdfSync(HKDF_HASH, masterSecret, Buffer.alloc(0), 'ellul:secrets-enc:v1', HKDF_KEY_LENGTH),
    ),
  };
}

// ── Workspace Fingerprint ──

// Binds token to project identity AND physical location.
export function computeWorkspaceFingerprint(slug: string, canonicalPath: string): string {
  return crypto.createHash('sha256')
    .update(`${slug}:${canonicalPath}`)
    .digest('hex');
}

// ── Local STS Tokens ──

// Compact JWS (HS256) signed with HKDF-derived stsSigningKey.
export function signLocalSts(
  slug: string,
  canonicalPath: string,
  stsSigningKey: Buffer,
  ttlSeconds: number = STS_TOKEN_TTL_SECONDS,
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: LocalStsPayload = {
    sub: slug,
    dir: canonicalPath,
    fpr: computeWorkspaceFingerprint(slug, canonicalPath),
    typ: 'STS',
    iat: now,
    exp: now + ttlSeconds,
    jti: crypto.randomBytes(16).toString('hex'),
  };

  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signInput = `${header}.${body}`;
  const signature = crypto.createHmac('sha256', stsSigningKey)
    .update(signInput)
    .digest('base64url');

  return `${signInput}.${signature}`;
}

/**
 * Order: struct → HMAC timing-safe → decode → typ → exp → fields.
 * (No exp oracle before sig verify.) 7. Optional fingerprint binding check.
 */
export function verifyLocalSts(
  token: string,
  stsSigningKey: Buffer,
  expectedFingerprint?: string,
): StsVerifyResult {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
      return { valid: false, reason: 'malformed' };
    }

    // Timing-safe HMAC comparison
    const signInput = `${parts[0]}.${parts[1]}`;
    const expectedSig = crypto.createHmac('sha256', stsSigningKey)
      .update(signInput)
      .digest('base64url');

    const expectedBuf = Buffer.from(expectedSig, 'utf8');
    const actualBuf = Buffer.from(parts[2], 'utf8');
    if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
      return { valid: false, reason: 'signature_invalid' };
    }

    // Decode AFTER signature verified
    const payload: LocalStsPayload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString(),
    );

    // Type discriminator
    if (payload.typ !== 'STS') return { valid: false, reason: 'invalid_claims' };

    // Expiration (safe to report — signature already verified)
    const now = Math.floor(Date.now() / 1000);
    if (!payload.exp || payload.exp < now) return { valid: false, reason: 'expired' };

    // Required fields
    if (!payload.sub || typeof payload.sub !== 'string') return { valid: false, reason: 'invalid_claims' };
    if (!payload.dir || typeof payload.dir !== 'string') return { valid: false, reason: 'invalid_claims' };
    if (!payload.fpr || typeof payload.fpr !== 'string') return { valid: false, reason: 'invalid_claims' };
    if (!payload.jti || typeof payload.jti !== 'string') return { valid: false, reason: 'invalid_claims' };

    // Workspace fingerprint binding
    if (expectedFingerprint && payload.fpr !== expectedFingerprint) {
      return { valid: false, reason: 'fingerprint_mismatch' };
    }

    return { valid: true, payload };
  } catch {
    return { valid: false, reason: 'malformed' };
  }
}

// ── Operator Signature Verification ──

// Verify SLH-DSA-SHA2-128s operator signature with timestamp tolerance.
export async function verifyOperatorSignature(
  publicKeyBase64: string,
  payload: string,
  signatureBase64: string,
  timestampStr: string,
): Promise<boolean> {
  // Check timestamp tolerance
  const ts = parseInt(timestampStr, 10);
  if (isNaN(ts)) return false;
  if (Math.abs(Date.now() - ts) > OPERATOR_TIMESTAMP_TOLERANCE_MS) return false;

  try {
    const { slh_dsa_sha2_128s } = await import('@noble/post-quantum/slh-dsa.js');
    const fullPayload = `${payload}|${timestampStr}`;
    const messageBytes = Buffer.from(fullPayload);
    const signatureBytes = Buffer.from(signatureBase64, 'base64');
    const publicKeyBytes = Buffer.from(publicKeyBase64, 'base64');

    return slh_dsa_sha2_128s.verify(signatureBytes, messageBytes, publicKeyBytes);
  } catch {
    return false;
  }
}

// ── Domain-Separated Payload Builders ──

/** Build signing payload for gate approval. */
export function gateApprovePayload(gate: string, project: string, duration: number): string {
  return `gate-approve|${gate}|${project}|${duration}`;
}

/** Build signing payload for gate denial. */
export function gateDenyPayload(gate: string, project: string): string {
  return `gate-deny|${gate}|${project}`;
}

/** Build signing payload for rule proposal approval. */
export function ruleApprovePayload(proposalId: string): string {
  return `rule-approve|${proposalId}`;
}

/** Build signing payload for rule proposal denial. */
export function ruleDenyPayload(proposalId: string): string {
  return `rule-deny|${proposalId}`;
}

/** Build signing payload for rule creation. */
export function ruleCreatePayload(ruleContent: string): string {
  const hash = crypto.createHash('sha256').update(ruleContent).digest('hex');
  return `rule-create|${hash}`;
}

/** Build signing payload for rule toggle. */
export function ruleTogglePayload(ruleId: string, enabled: boolean): string {
  return `rule-toggle|${ruleId}|${enabled}`;
}

/** Build signing payload for rule deletion. */
export function ruleDeletePayload(ruleId: string): string {
  return `rule-delete|${ruleId}`;
}

/** Build signing payload for policy change. */
export function policySetPayload(gate: string, policy: string, project: string): string {
  return `policy-set|${gate}|${policy}|${project}`;
}

/** Build signing payload for secret reveal. */
export function secretRevealPayload(secretName: string, project: string): string {
  return `secret-reveal|${secretName}|${project}`;
}
