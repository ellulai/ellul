// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * External PostgreSQL Client — Connection Pool + Circuit Breaker
 *
 * Production-grade client for external PostgreSQL providers (Neon, Supabase,
 * PlanetScale, etc.). Replaces shell-based `psql` execution with a native
 * `pg` driver using connection pooling and non-blocking async I/O.
 *
 * Security:
 *   - TLS enforced: `sslmode=require` injected if not present
 *   - Connection URL encrypted at rest via AES-256-GCM (using VPS node.key)
 *   - Credentials never logged, never in process list, never in error messages
 *   - Statement timeout enforced server-side (not just client-side)
 *   - Idle connections reaped after 30s to avoid stale TCP
 *
 * Resilience:
 *   - Circuit breaker: trips after 5 consecutive failures, half-opens after 30s
 *   - Per-app connection pools: isolated failure domains
 *   - Health check on pool creation: SELECT 1 before trusting config
 *   - Graceful shutdown: drains all pools on SIGTERM
 */

import crypto from 'crypto';
import fs from 'fs';
import pg from 'pg';

const { Pool } = pg;

// ── Types ──

interface CircuitState {
  failures: number;
  lastFailure: number;
  state: 'closed' | 'open' | 'half-open';
}

interface AppPool {
  pool: InstanceType<typeof Pool>;
  circuit: CircuitState;
  createdAt: number;
}

// ── Constants ──

const CIRCUIT_THRESHOLD = 5;         // Failures before tripping
const CIRCUIT_RESET_MS = 30_000;     // Half-open after 30s
const MAX_POOL_SIZE = 5;             // Per-app pool size (external DBs have connection limits)
const IDLE_TIMEOUT_MS = 30_000;      // Reap idle connections after 30s
const CONNECTION_TIMEOUT_MS = 10_000; // Max wait for a connection from pool
const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
const PRIVATE_KEY_PATH = '/etc/ellul-bootstrap/node.key';
const ENCRYPTED_URL_DIR = '/etc/ellul/shield-data/db-credentials';

// ── State ──

/** Per-app connection pools. Key = sanitized sandboxId. */
const pools = new Map<string, AppPool>();

// ── TLS Enforcement ──

/**
 * Ensure the connection URL has TLS enabled.
 * If no sslmode is specified, injects `sslmode=require`.
 * If sslmode=disable is set, overrides to `require`.
 */
export function enforceTls(connectionUrl: string): string {
  const parsed = new URL(connectionUrl);
  const sslmode = parsed.searchParams.get('sslmode');

  if (!sslmode) {
    parsed.searchParams.set('sslmode', 'require');
  } else if (sslmode === 'disable' || sslmode === 'allow' || sslmode === 'prefer') {
    // Upgrade weak modes to require
    parsed.searchParams.set('sslmode', 'require');
  }
  // If already 'require', 'verify-ca', or 'verify-full' — leave as-is

  return parsed.toString();
}

// ── Credential Encryption at Rest ──

let privateKeyCache: string | null = null;

function getPrivateKey(): string {
  if (!privateKeyCache) {
    privateKeyCache = fs.readFileSync(PRIVATE_KEY_PATH, 'utf8');
  }
  return privateKeyCache;
}

/**
 * Encrypt a connection URL for at-rest storage.
 * Uses AES-256-GCM with a random key, key wrapped via RSA-OAEP with the VPS node.key.
 * Same envelope format as secrets.service.ts for consistency.
 */
export function encryptConnectionUrl(connectionUrl: string): {
  encryptedKey: string;
  iv: string;
  encryptedData: string;
} {
  const publicKey = crypto.createPublicKey(getPrivateKey());

  // Generate random AES-256 key
  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);

  // Encrypt the URL with AES-256-GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(connectionUrl, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  // Append auth tag to ciphertext (matches browser SubtleCrypto format)
  const encryptedData = Buffer.concat([encrypted, authTag]);

  // Wrap the AES key with RSA-OAEP
  const encryptedKey = crypto.publicEncrypt(
    {
      key: publicKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    aesKey,
  );

  // Zero the raw AES key
  aesKey.fill(0);

  return {
    encryptedKey: encryptedKey.toString('base64'),
    iv: iv.toString('base64'),
    encryptedData: encryptedData.toString('base64'),
  };
}

/**
 * Decrypt a connection URL from at-rest storage.
 */
export function decryptConnectionUrl(envelope: {
  encryptedKey: string;
  iv: string;
  encryptedData: string;
}): string {
  const privateKey = getPrivateKey();

  // Unwrap AES key
  const aesKey = crypto.privateDecrypt(
    {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    Buffer.from(envelope.encryptedKey, 'base64'),
  );

  // Decrypt data
  const data = Buffer.from(envelope.encryptedData, 'base64');
  const authTag = data.subarray(-16);
  const ciphertext = data.subarray(0, -16);

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    aesKey,
    Buffer.from(envelope.iv, 'base64'),
  );
  decipher.setAuthTag(authTag);

  const url = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');

  // Zero the AES key
  aesKey.fill(0);

  return url;
}

/**
 * Save an encrypted connection URL to disk.
 * File: /etc/ellul/shield-data/db-credentials/{sandboxId}.enc.json
 * Permissions: root:shield 640 (agent cannot read)
 */
export function saveEncryptedUrl(sandboxId: string, connectionUrl: string): void {
  const safe = sandboxId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!fs.existsSync(ENCRYPTED_URL_DIR)) {
    fs.mkdirSync(ENCRYPTED_URL_DIR, { recursive: true });
  }

  const envelope = encryptConnectionUrl(connectionUrl);
  const filePath = `${ENCRYPTED_URL_DIR}/${safe}.enc.json`;

  // Atomic write: tmp + fsync + rename
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  const fd = fs.openSync(tmpPath, 'w', 0o640);
  try {
    fs.writeSync(fd, JSON.stringify(envelope));
    fs.fdatasyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);

  // Ensure permissions
  try {
    const { execFileSync } = require('child_process') as typeof import('child_process');
    execFileSync('chown', ['root:shield', filePath], { stdio: 'pipe' });
    execFileSync('chmod', ['640', filePath], { stdio: 'pipe' });
  } catch {
    // Best-effort — directory SGID should handle group
  }
}

/**
 * Load and decrypt a connection URL from disk.
 */
export function loadEncryptedUrl(sandboxId: string): string | null {
  const safe = sandboxId.replace(/[^a-zA-Z0-9_-]/g, '');
  const filePath = `${ENCRYPTED_URL_DIR}/${safe}.enc.json`;

  if (!fs.existsSync(filePath)) return null;

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const envelope = JSON.parse(raw);
    return decryptConnectionUrl(envelope);
  } catch (err: any) {
    console.error(`[shield] Failed to decrypt connection URL for ${safe}:`, err.message);
    return null;
  }
}

/**
 * Remove encrypted connection URL from disk.
 */
export function removeEncryptedUrl(sandboxId: string): void {
  const safe = sandboxId.replace(/[^a-zA-Z0-9_-]/g, '');
  const filePath = `${ENCRYPTED_URL_DIR}/${safe}.enc.json`;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Best-effort
  }
}

// ── Circuit Breaker ──

function newCircuit(): CircuitState {
  return { failures: 0, lastFailure: 0, state: 'closed' };
}

function checkCircuit(circuit: CircuitState): void {
  if (circuit.state === 'open') {
    if (Date.now() - circuit.lastFailure > CIRCUIT_RESET_MS) {
      circuit.state = 'half-open';
    } else {
      throw new Error('External database circuit breaker is OPEN — too many recent failures. Try again shortly.');
    }
  }
}

function recordSuccess(circuit: CircuitState): void {
  circuit.failures = 0;
  circuit.state = 'closed';
}

function recordFailure(circuit: CircuitState): void {
  circuit.failures++;
  circuit.lastFailure = Date.now();
  if (circuit.failures >= CIRCUIT_THRESHOLD) {
    circuit.state = 'open';
    console.warn(`[shield] External DB circuit breaker tripped after ${circuit.failures} failures`);
  }
}

// ── Connection Pool Management ──

/**
 * Get or create a connection pool for an app.
 * Pool is created lazily on first query.
 * TLS is enforced before pool creation.
 */
function getPool(sandboxId: string, connectionUrl: string): AppPool {
  const existing = pools.get(sandboxId);
  if (existing) return existing;

  const tlsUrl = enforceTls(connectionUrl);

  const pool = new Pool({
    connectionString: tlsUrl,
    max: MAX_POOL_SIZE,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    // Force statement_timeout at session level for defense-in-depth
    statement_timeout: DEFAULT_STATEMENT_TIMEOUT_MS,
    // Verify TLS chain against Node's bundled Mozilla CA set. Neon, Supabase,
    // RDS, and Cloud SQL all present publicly-rooted certs. Without this,
    // any network-adjacent attacker could MITM the connection and harvest
    // the user's DB credentials + all query traffic.
    ssl: { rejectUnauthorized: true },
  });

  // Log pool errors (don't crash the process)
  pool.on('error', (err: Error) => {
    console.error(`[shield] External DB pool error for ${sandboxId}:`, sanitizeError(err.message));
    const entry = pools.get(sandboxId);
    if (entry) recordFailure(entry.circuit);
  });

  const entry: AppPool = {
    pool,
    circuit: newCircuit(),
    createdAt: Date.now(),
  };

  pools.set(sandboxId, entry);
  return entry;
}

/**
 * Destroy the pool for an app (e.g., when config changes or app is deleted).
 */
export async function destroyPool(sandboxId: string): Promise<void> {
  const entry = pools.get(sandboxId);
  if (!entry) return;

  pools.delete(sandboxId);
  try {
    await entry.pool.end();
  } catch (err: any) {
    console.warn(`[shield] Pool drain error for ${sandboxId}:`, err.message);
  }
}

/**
 * Drain all pools on shutdown.
 */
export async function drainAllPools(): Promise<void> {
  const drainPromises: Promise<void>[] = [];
  for (const [sandboxId, entry] of pools) {
    pools.delete(sandboxId);
    drainPromises.push(
      entry.pool.end().catch((err: Error) => {
        console.warn(`[shield] Pool drain error for ${sandboxId}:`, err.message);
      }),
    );
  }
  await Promise.all(drainPromises);
}

// ── Query Execution ──

/**
 * Sanitize error messages — strip connection URLs and credentials.
 */
function sanitizeError(msg: string): string {
  return msg
    .replace(/postgresql?:\/\/[^\s"']+/gi, '[REDACTED_URL]')
    .replace(/password[=:]\s*\S+/gi, 'password=[REDACTED]');
}

/**
 * Execute a SQL query against an external database via connection pool.
 *
 * Features:
 *   - Non-blocking async (does NOT block event loop)
 *   - Connection pooling (reuses TCP connections)
 *   - TLS enforced
 *   - Circuit breaker protection
 *   - Statement timeout enforced server-side
 *   - Credentials never in error messages
 *
 * @param sandboxId - App identifier for pool routing
 * @param connectionUrl - Full postgresql:// URL
 * @param sql - SQL query to execute
 * @param statementTimeoutMs - Per-query timeout (default 30s)
 */
export async function queryExternal(
  sandboxId: string,
  connectionUrl: string,
  sql: string,
  statementTimeoutMs?: number,
): Promise<{ rows: any[]; rowCount: number; command: string }> {
  const entry = getPool(sandboxId, connectionUrl);

  // Check circuit breaker
  checkCircuit(entry.circuit);

  const timeoutMs = statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;

  let client: pg.PoolClient | null = null;
  try {
    client = await entry.pool.connect();

    // Set per-query statement timeout
    const safeTimeoutMs = Number.parseInt(String(timeoutMs), 10);
    if (!Number.isFinite(safeTimeoutMs) || safeTimeoutMs <= 0 || safeTimeoutMs >= 600000) {
      throw new Error(`Invalid statement_timeout: ${timeoutMs} (must be 1..599999 ms)`);
    }
    await client.query(`SET statement_timeout = '${safeTimeoutMs}ms'`);

    const result = await client.query(sql);

    recordSuccess(entry.circuit);

    // Normalize result
    const command = result.command || sql.trim().split(/\s+/)[0]?.toUpperCase() || 'UNKNOWN';
    const rows = result.rows ?? [];
    const rowCount = result.rowCount ?? rows.length;

    return { rows, rowCount, command };
  } catch (err: any) {
    recordFailure(entry.circuit);

    const sanitized = sanitizeError(err.message || 'Query failed');
    throw new Error(`External database error: ${sanitized}`);
  } finally {
    if (client) {
      // Reset statement_timeout before returning to pool
      try {
        await client.query('RESET statement_timeout');
      } catch {
        // If reset fails, destroy the client so it doesn't pollute the pool
        client.release(true);
        client = null;
      }
      client?.release();
    }
  }
}

/**
 * Test connectivity to an external database via the pool.
 * Returns true if SELECT 1 succeeds within 5 seconds.
 */
export async function testConnection(
  sandboxId: string,
  connectionUrl: string,
): Promise<boolean> {
  try {
    await queryExternal(sandboxId, connectionUrl, 'SELECT 1', 5_000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get circuit breaker state for an app (for monitoring/debugging).
 */
export function getCircuitState(sandboxId: string): CircuitState | null {
  return pools.get(sandboxId)?.circuit ?? null;
}

// ── Lifecycle ──

// Graceful shutdown: drain all pools
process.on('SIGTERM', () => {
  drainAllPools().catch(() => {});
});

process.on('SIGINT', () => {
  drainAllPools().catch(() => {});
});
