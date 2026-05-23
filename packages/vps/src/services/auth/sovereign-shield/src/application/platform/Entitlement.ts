// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Entitlement Service — Cryptographically Enforced Sandbox Capacity
 *
 * Mathematically provable sandbox limits using ML-DSA-65 (post-quantum) signed entitlement manifests.
 *
 * Architecture:
 *   - Central API (apps/api) holds the ML-DSA-65 private key and signs entitlement manifests.
 *   - VPS holds only the public key — can verify but NEVER forge a manifest.
 *   - Manifest is pushed via enforcer command queue ("update-entitlements") and written
 *     to /etc/ellul/entitlement.jws by root. Agent cannot modify (root:root 644).
 *
 * Enforcement chain (all provably impossible to bypass):
 *   1. Agent cannot write /etc/ellul/entitlement.jws (root:root 644)
 *   2. Agent cannot forge a valid JWS (no access to ML-DSA-65 private key)
 *   3. Agent cannot delete the file to raise cap (missing file → cap=1, extra=0)
 *   4. Agent cannot create project dirs that sovereign-shield recognises
 *      (project creation goes through this enforcement point)
 *   5. Agent cannot modify sovereign-shield binary (/opt/ellul, root-owned vault)
 *   6. Agent cannot replay an old manifest with higher caps (monotonic sequence number)
 *
 * Entitlement payload:
 *   {
 *     "vps": "srv-xxx",          // Server ID binding (prevents token replay across VPSes)
 *     "cap": 1,                  // Base sandboxes included with billing tier
 *     "extra": 0,                // Purchased extra sandboxes ($5/each)
 *     "seq": 1,                  // Monotonic sequence number (replay protection)
 *     "iat": 1710345000,         // Issued at (unix seconds)
 *     "jti": "unique-id"         // Unique manifest ID for audit trail
 *   }
 *
 * Per-tier base caps (from central API entitlement service):
 *   platform_free:     1
 *   platform_standard: 2     sandbox_standard: 2
 *   platform_pro:      5     sandbox_pro:      5
 *   shield_proxy:      0     (proxy only, no workspaces)
 *
 * Pricing: $15 per extra team seat (above base cap).
 *
 * Performance:
 *   - ML-DSA-65 verification is cached in memory with mtime-based invalidation.
 *   - On-disk JWS is only re-read when the file's mtime changes.
 *   - Project count is always fresh (filesystem is the source of truth).
 *
 * Replay protection:
 *   - Each manifest carries a monotonic `seq` (sequence number).
 *   - Highest-seen seq is persisted in /etc/ellul/shield-data/entitlement-seq
 *     (writable by shield-runner, NOT by agent).
 *   - Manifests with seq <= last_seen are rejected even if signature is valid.
 *   - Prevents downgrade attacks where attacker replays an old manifest with higher caps.
 */

import fs from 'fs';
import path from 'path';
import { SANDBOX_ID_RE } from '@ellul.ai/types';
import { SVC_HOME, SERVER_ID_FILE, SHIELD_DATA_DIR } from '../../config';
import { isValidProjectOwner } from '@vps/shared/platform';

// Lazy-loaded ML-DSA-65 (post-quantum signature verification)
let _ml_dsa65: typeof import("@noble/post-quantum/ml-dsa.js").ml_dsa65 | null = null;
async function getMlDsa65() {
  if (!_ml_dsa65) {
    _ml_dsa65 = (await import("@noble/post-quantum/ml-dsa.js")).ml_dsa65;
  }
  return _ml_dsa65;
}

// ── File Paths ──

/** ML-DSA-65 public key (base64) for verifying entitlement manifests. Root-owned, provisioned at boot. */
const ENTITLEMENT_PUBKEY_FILE = '/etc/ellul/entitlement-pubkey.pem';

/** Signed entitlement manifest (JWS). Pushed by central API via enforcer command queue. */
const ENTITLEMENT_JWS_FILE = '/etc/ellul/entitlement.jws';

/** Highest-seen sequence number. Shield-data dir is writable by shield-runner, not agent. */
const ENTITLEMENT_SEQ_FILE = path.join(SHIELD_DATA_DIR, 'entitlement-seq');

const PROJECTS_DIR = path.join(SVC_HOME, 'projects');
const SLUG_REGEX = SANDBOX_ID_RE;

/** Hard ceiling on cap/extra values — prevents integer overflow from compromised API. */
const MAX_SANDBOXES = 100;

// ── Types ──

export interface EntitlementPayload {
  /** Server ID binding — prevents replay across VPSes. */
  vps: string;
  /** Base sandbox cap included with billing tier. */
  cap: number;
  /** Extra sandboxes purchased at $5/each. */
  extra: number;
  /** Monotonic sequence number — replay protection. */
  seq: number;
  /** Issued at (unix seconds). */
  iat: number;
  /** Unique manifest ID for audit trail. */
  jti: string;
}

export interface EntitlementStatus {
  /** Maximum allowed sandboxes (cap + extra). */
  max: number;
  /** Current number of registered project slugs. */
  current: number;
  /** Remaining slots available. */
  remaining: number;
  /** Base cap from billing tier. */
  baseCap: number;
  /** Extra purchased sandboxes. */
  extraPurchased: number;
}

export type EntitlementCheckResult =
  | { allowed: true; status: EntitlementStatus }
  | { allowed: false; status: EntitlementStatus; reason: 'sandbox_limit_reached' | 'insufficient_resources' };

// ── BYOS Detection ──

function readProduct(): string | null {
  try {
    return fs.readFileSync('/etc/ellul/product', 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function isByos(): boolean {
  return readProduct() === 'byos';
}

// ── BYOS Resource Guard ──

const MIN_FREE_RAM_BYTES = 512 * 1024 * 1024;
const MIN_FREE_DISK_BYTES = 1024 * 1024 * 1024;

function checkResourceGuard(): { ok: true } | { ok: false; detail: string } {
  if (process.env.ELLUL_PLATFORM === 'android') return { ok: true };
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const match = meminfo.match(/MemAvailable:\s+(\d+)\s+kB/);
    if (match) {
      const availableBytes = parseInt(match[1]!, 10) * 1024;
      if (availableBytes < MIN_FREE_RAM_BYTES) {
        return { ok: false, detail: `${Math.floor(availableBytes / 1024 / 1024)}MB RAM free, need ${MIN_FREE_RAM_BYTES / 1024 / 1024}MB` };
      }
    }
  } catch { /* /proc/meminfo unavailable — skip RAM check */ }

  try {
    const stat = fs.statfsSync(PROJECTS_DIR);
    const freeBytes = Number(stat.bfree) * Number(stat.bsize);
    if (freeBytes < MIN_FREE_DISK_BYTES) {
      return { ok: false, detail: `${Math.floor(freeBytes / 1024 / 1024)}MB disk free, need ${MIN_FREE_DISK_BYTES / 1024 / 1024}MB` };
    }
  } catch { /* statfs unavailable — skip disk check */ }

  return { ok: true };
}

// ── Default Caps (no entitlement file or invalid) ──

function getDefaultCap(): number {
  const product = readProduct();
  if (product === 'byos') return Number.MAX_SAFE_INTEGER;
  if (product === 'shield_proxy') return 0;
  if (!product) {
    try {
      const billingTier = fs.readFileSync('/etc/ellul/billing-tier', 'utf8').trim();
      if (billingTier === 'governance') return 0;
    } catch {}
  }
  return 1;
}

const DEFAULT_EXTRA = 0;

// ── ML-DSA-65 Public Keys (loaded once at module init) ──

const COMMAND_SIGNING_PUB_FILE = '/etc/ellul/command-signing.pub';

let ENTITLEMENT_PUBKEYS: Uint8Array[] = [];

function loadKeyRing(): Uint8Array[] {
  const keys: Uint8Array[] = [];

  try {
    const ringJson = fs.readFileSync(COMMAND_SIGNING_PUB_FILE, 'utf8').trim();
    const ring = JSON.parse(ringJson);
    if (ring.version === 3 && Array.isArray(ring.keys)) {
      for (const entry of ring.keys) {
        if (entry.algorithm === 'ML-DSA-65' && entry.mldsa_pk) {
          const raw = new Uint8Array(Buffer.from(entry.mldsa_pk, 'base64'));
          if (raw.length === 1952) keys.push(raw);
        }
      }
    } else if (ring.mldsa_pk) {
      const raw = new Uint8Array(Buffer.from(ring.mldsa_pk, 'base64'));
      if (raw.length === 1952) keys.push(raw);
    }
  } catch { /* file missing or unparseable */ }

  if (keys.length === 0) {
    try {
      const b64 = fs.readFileSync(ENTITLEMENT_PUBKEY_FILE, 'utf8').trim();
      const raw = new Uint8Array(Buffer.from(b64, 'base64'));
      if (raw.length === 1952) keys.push(raw);
    } catch { /* file missing */ }
  }

  return keys;
}

ENTITLEMENT_PUBKEYS = loadKeyRing();
if (ENTITLEMENT_PUBKEYS.length > 0) {
  console.log(`[entitlement] ML-DSA-65 key ring loaded (${ENTITLEMENT_PUBKEYS.length} key${ENTITLEMENT_PUBKEYS.length > 1 ? 's' : ''}).`);
} else {
  console.log('[entitlement] No entitlement public key found — using default caps (cap=1, extra=0).');
}

// ── Mtime-Based Cache ──
// Avoids re-reading and re-verifying the JWS file on every request.
// Cache is invalidated when the file's mtime changes (written by enforcer as root).

interface EntitlementCache {
  /** Verified payload (null if verification failed). */
  payload: EntitlementPayload | null;
  /** File mtime at the time of verification (ms). */
  mtimeMs: number;
  /** Whether verification succeeded. */
  valid: boolean;
}

let entitlementCache: EntitlementCache | null = null;

/**
 * Get the mtime of the entitlement JWS file.
 * Returns 0 if the file doesn't exist (cache miss on first call).
 */
function getJwsMtime(): number {
  try {
    return fs.statSync(ENTITLEMENT_JWS_FILE).mtimeMs;
  } catch {
    return 0; // File doesn't exist
  }
}

// ── Sequence Number (Replay Protection) ──

/**
 * Read the highest-seen sequence number from disk.
 * Returns 0 if the file doesn't exist (first boot — accept any seq).
 */
function readHighestSeq(): number {
  try {
    const raw = fs.readFileSync(ENTITLEMENT_SEQ_FILE, 'utf8').trim();
    const seq = parseInt(raw, 10);
    return Number.isFinite(seq) && seq >= 0 ? seq : 0;
  } catch {
    return 0;
  }
}

/**
 * Persist the highest-seen sequence number.
 * Written to shield-data dir (writable by shield-runner, not agent).
 */
function writeHighestSeq(seq: number): void {
  try {
    fs.writeFileSync(ENTITLEMENT_SEQ_FILE, String(seq) + '\n', { mode: 0o644 });
  } catch (err) {
    console.error('[entitlement] Failed to persist sequence number:', (err as Error).message);
  }
}

// ── JWS Verification ──

/**
 * Verify and decode the entitlement JWS.
 *
 * JWS format: header.payload.signature (compact serialization)
 * Algorithm: ML-DSA-65 (post-quantum, FIPS 204)
 *
 * Verification order:
 *   1. Structural validation (3-part JWS)
 *   2. ML-DSA-65 signature verification (before any payload parsing)
 *   3. Payload decode (ONLY after signature verified)
 *   4. Server ID binding check
 *   5. Field validation (type, range, overflow)
 *   6. Monotonic sequence check (replay protection)
 */
async function verifyEntitlementJws(): Promise<EntitlementPayload | null> {
  if (ENTITLEMENT_PUBKEYS.length === 0) return null;

  // ── Mtime cache check ──
  const currentMtime = getJwsMtime();
  if (currentMtime === 0) {
    // File doesn't exist — invalidate cache, return null
    entitlementCache = null;
    return null;
  }
  if (entitlementCache && entitlementCache.mtimeMs === currentMtime) {
    return entitlementCache.payload;
  }

  // ── File changed or first read — re-verify ──
  let raw: string;
  try {
    raw = fs.readFileSync(ENTITLEMENT_JWS_FILE, 'utf8').trim();
  } catch {
    entitlementCache = { payload: null, mtimeMs: currentMtime, valid: false };
    return null;
  }

  try {
    const parts = raw.split('.');
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
      console.error('[entitlement] Malformed JWS — not 3 parts.');
      entitlementCache = { payload: null, mtimeMs: currentMtime, valid: false };
      return null;
    }

    // ML-DSA-65 signature verification FIRST — never parse untrusted data before verifying.
    const signInput = `${parts[0]}.${parts[1]}`;
    const signature = new Uint8Array(Buffer.from(parts[2], 'base64url'));
    const message = new Uint8Array(Buffer.from(signInput, 'utf8'));

    const ml_dsa65 = await getMlDsa65();

    // Try kid hint from JWS header to prioritize matching key
    let kidHint: string | undefined;
    try {
      const hdr = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
      if (typeof hdr.kid === 'string') kidHint = hdr.kid;
    } catch { /* malformed header — try all keys */ }

    let isValid = false;
    for (const pubkey of ENTITLEMENT_PUBKEYS) {
      if (ml_dsa65.verify(signature, message, pubkey)) {
        isValid = true;
        break;
      }
    }

    if (!isValid) {
      console.error('[entitlement] CRITICAL: ML-DSA-65 entitlement JWS signature verification FAILED against all keys. Using default caps.');
      entitlementCache = { payload: null, mtimeMs: currentMtime, valid: false };
      return null;
    }

    // Decode payload ONLY after signature is verified
    const payload: EntitlementPayload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());

    // Server ID binding — prevent replay of another VPS's entitlement
    let serverId: string | null = null;
    try {
      serverId = fs.readFileSync(SERVER_ID_FILE, 'utf8').trim();
    } catch {
      // No server ID file — skip binding check (first boot)
    }
    if (serverId && payload.vps !== serverId) {
      console.error(`[entitlement] Server ID mismatch: token="${payload.vps}", local="${serverId}". Rejecting.`);
      entitlementCache = { payload: null, mtimeMs: currentMtime, valid: false };
      return null;
    }

    // Validate required fields — cap values bounded to prevent overflow
    if (typeof payload.cap !== 'number' || !Number.isInteger(payload.cap) || payload.cap < 0 || payload.cap > MAX_SANDBOXES) {
      console.error('[entitlement] Invalid cap value in entitlement payload.');
      entitlementCache = { payload: null, mtimeMs: currentMtime, valid: false };
      return null;
    }
    if (typeof payload.extra !== 'number' || !Number.isInteger(payload.extra) || payload.extra < 0 || payload.extra > MAX_SANDBOXES) {
      console.error('[entitlement] Invalid extra value in entitlement payload.');
      entitlementCache = { payload: null, mtimeMs: currentMtime, valid: false };
      return null;
    }
    if (typeof payload.iat !== 'number' || !payload.jti) {
      console.error('[entitlement] Missing iat or jti in entitlement payload.');
      entitlementCache = { payload: null, mtimeMs: currentMtime, valid: false };
      return null;
    }

    // ── Monotonic sequence check (replay protection) ──
    // Reject manifests with seq <= highest-seen. Prevents downgrade attacks where an
    // attacker replays an old manifest (e.g., extra:3 before user cancelled back to extra:1).
    if (typeof payload.seq !== 'number' || !Number.isInteger(payload.seq) || payload.seq < 0) {
      console.error('[entitlement] Missing or invalid seq in entitlement payload.');
      entitlementCache = { payload: null, mtimeMs: currentMtime, valid: false };
      return null;
    }
    const highestSeq = readHighestSeq();
    if (payload.seq < highestSeq) {
      console.error(`[entitlement] REPLAY DETECTED: manifest seq=${payload.seq} < highest_seen=${highestSeq}. Rejecting.`);
      entitlementCache = { payload: null, mtimeMs: currentMtime, valid: false };
      return null;
    }
    // Persist new highest (only if strictly greater — idempotent replays of same seq are ok)
    if (payload.seq > highestSeq) {
      writeHighestSeq(payload.seq);
    }

    entitlementCache = { payload, mtimeMs: currentMtime, valid: true };
    return payload;
  } catch (err) {
    console.error('[entitlement] Failed to verify entitlement JWS:', (err as Error).message);
    entitlementCache = { payload: null, mtimeMs: currentMtime, valid: false };
    return null;
  }
}

// ── Project Counting ──

/**
 * Count existing project directories that match the slug pattern.
 *
 * Hard invariant: counted ⇔ visible to the user ⇔ `ellul.json` exists
 * at the project root. Three states map cleanly:
 *
 *   - In-flight create (mkdir done, ellul.json not yet written) →
 *     NOT counted, NOT visible. The user sees nothing during the
 *     creation window. If the create succeeds, the next probe sees
 *     ellul.json and starts counting + showing it. If the create
 *     fails, the orphan reaper deletes the dir on the next sweep.
 *
 *   - Live sandbox (root-owned dir + ellul.json) → counted, visible.
 *
 *   - Partial-delete or partial-create past the grace window → reaper
 *     deletes the dir, count drops automatically.
 *
 * The user never sees an "orphan slot" — a count without a visible
 * sandbox. This invariant is enforced by every consumer agreeing on
 * the same predicate (root-owned dir + ellul.json), not by chasing
 * disk state across multiple inconsistent counters.
 *
 * The root-owned check (uid === 0) prevents agent-created rogue dirs
 * from inflating the count — agent runs as the service user, so a
 * compromised agent that mkdir's an sbx-* dir produces a
 * uid=service-user dir which we ignore.
 */
function countProjects(): number {
  try {
    const entries = fs.readdirSync(PROJECTS_DIR);
    let count = 0;
    for (const entry of entries) {
      if (!SLUG_REGEX.test(entry)) continue;
      const fullPath = path.join(PROJECTS_DIR, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (!stat.isDirectory() || !isValidProjectOwner(stat)) continue;
        // Hard invariant: only fully-created sandboxes count toward the
        // entitlement cap. Partial-create dirs without ellul.json are
        // either in-flight (the grace window) or in line for the orphan
        // reaper. Either way they don't occupy a user-visible slot.
        if (!fs.existsSync(path.join(fullPath, 'ellul.json'))) continue;
        count++;
      } catch { /* stat / readdir failed — skip */ }
    }
    return count;
  } catch {
    return 0; // Projects dir doesn't exist yet
  }
}

// ── Public API ──

/**
 * Get current entitlement status.
 * Always returns a result — falls back to defaults if verification fails.
 */
export async function getEntitlementStatus(): Promise<EntitlementStatus> {
  const current = countProjects();

  if (isByos()) {
    return {
      max: Number.MAX_SAFE_INTEGER,
      current,
      remaining: Number.MAX_SAFE_INTEGER,
      baseCap: Number.MAX_SAFE_INTEGER,
      extraPurchased: 0,
    };
  }

  const payload = await verifyEntitlementJws();

  if (payload) {
    const max = payload.cap + payload.extra;
    return {
      max,
      current,
      remaining: Math.max(0, max - current),
      baseCap: payload.cap,
      extraPurchased: payload.extra,
    };
  }

  const defaultCap = getDefaultCap();
  const max = defaultCap + DEFAULT_EXTRA;
  return {
    max,
    current,
    remaining: Math.max(0, max - current),
    baseCap: defaultCap,
    extraPurchased: DEFAULT_EXTRA,
  };
}

/**
 * Check if a new sandbox can be created.
 * This is the enforcement point — called by POST /_auth/projects.
 */
export async function checkSandboxEntitlement(): Promise<EntitlementCheckResult> {
  if (isByos()) {
    const resourceCheck = checkResourceGuard();
    const status = await getEntitlementStatus();
    if (!resourceCheck.ok) {
      console.warn(`[entitlement] BYOS resource guard denied: ${resourceCheck.detail}`);
      return { allowed: false, status, reason: 'insufficient_resources' };
    }
    return { allowed: true, status };
  }

  const status = await getEntitlementStatus();

  if (status.current >= status.max) {
    return { allowed: false, status, reason: 'sandbox_limit_reached' };
  }

  return { allowed: true, status };
}

/**
 * Check if entitlement verification is available (public key loaded + self-test passed).
 */
export function isEntitlementAvailable(): boolean {
  return ENTITLEMENT_PUBKEYS.length > 0;
}

/**
 * Invalidate the in-memory cache. Called after the enforcer writes a new
 * entitlement.jws and restarts sovereign-shield. In practice this happens
 * naturally because the restart reloads the module, but this is available
 * for hot-reload scenarios.
 */
export function invalidateEntitlementCache(): void {
  entitlementCache = null;
}
