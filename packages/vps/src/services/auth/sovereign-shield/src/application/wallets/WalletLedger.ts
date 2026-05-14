// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Wallet Ledger Service
 *
 * SQLite-backed transaction ledger for tracking wallet spending.
 * Lives in the same local-auth.db as sessions, audit logs, etc.
 *
 * Used by the wallet proxy to:
 *   - Record every transaction (pending → signed → confirmed/failed)
 *   - Enforce spending limits per gate grant (cumulative sum check)
 *   - Deduplicate via idempotency keys (retried requests return cached result)
 *   - Provide transaction history per app
 */

import crypto from 'crypto';
import Database from 'better-sqlite3';

type SqliteDatabase = InstanceType<typeof Database>;

export interface WalletTransaction {
  id: number;
  txId: string;
  sandboxId: string;
  threadId: string | null;
  type: 'spend' | 'deposit' | 'refund';
  amountLamports: number;
  recipient: string | null;
  solanaSignature: string | null;
  status: 'pending' | 'signed' | 'submitted' | 'confirmed' | 'failed';
  gateKey: string | null;
  idempotencyKey: string | null;
  metadata: string | null;
  createdAt: number;
  updatedAt: number;
}

let db: SqliteDatabase | null = null;

/**
 * Initialize the wallet ledger table.
 * Called at shield startup when wallet feature is enabled.
 */
export function initWalletLedger(database: SqliteDatabase): void {
  db = database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tx_id TEXT NOT NULL UNIQUE,
      app_name TEXT NOT NULL,
      thread_id TEXT,
      type TEXT NOT NULL,
      amount_lamports INTEGER NOT NULL,
      recipient TEXT,
      solana_signature TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      gate_key TEXT,
      idempotency_key TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  // Indexes for common queries
  db.exec(`CREATE INDEX IF NOT EXISTS idx_wallet_tx_app ON wallet_transactions(app_name)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_wallet_tx_status ON wallet_transactions(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_wallet_tx_gate_key ON wallet_transactions(gate_key)`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_tx_idempotency ON wallet_transactions(app_name, idempotency_key) WHERE idempotency_key IS NOT NULL`);

  // Signing locks — crash-safe replacement for in-memory Map.
  // Stale timeout is the primary safety boundary (not PID liveness).
  db.exec(`
    CREATE TABLE IF NOT EXISTS signing_locks (
      derivation_index INTEGER PRIMARY KEY,
      locked_at INTEGER NOT NULL,
      pid INTEGER NOT NULL,
      lock_token TEXT NOT NULL
    )
  `);
}

function getDb(): SqliteDatabase {
  if (!db) throw new Error('Wallet ledger not initialized');
  return db;
}

/**
 * Record a new transaction.
 */
export function recordTransaction(tx: {
  txId: string;
  sandboxId: string;
  threadId?: string;
  type: 'spend' | 'deposit' | 'refund';
  amountLamports: number;
  recipient?: string;
  gateKey?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}): void {
  const now = Date.now();
  getDb().prepare(`
    INSERT INTO wallet_transactions (tx_id, app_name, thread_id, type, amount_lamports, recipient, status, gate_key, idempotency_key, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
  `).run(
    tx.txId,
    tx.sandboxId,
    tx.threadId ?? null,
    tx.type,
    tx.amountLamports,
    tx.recipient ?? null,
    tx.gateKey ?? null,
    tx.idempotencyKey ?? null,
    tx.metadata ? JSON.stringify(tx.metadata) : null,
    now,
    now,
  );
}

/**
 * Update a transaction's status and optional fields.
 */
export function updateTransaction(txId: string, updates: {
  status?: string;
  solanaSignature?: string;
  metadata?: Record<string, unknown>;
}): void {
  const now = Date.now();
  const ALLOWED_COLUMNS = new Set(['updated_at', 'status', 'solana_signature', 'metadata']);
  const sets: string[] = [];
  const params: unknown[] = [];

  const pushSet = (column: string, value: unknown): void => {
    if (!ALLOWED_COLUMNS.has(column)) {
      throw new Error(`updateTransaction: column not in allowlist: ${column}`);
    }
    sets.push(`${column} = ?`);
    params.push(value);
  };

  pushSet('updated_at', now);
  if (updates.status) pushSet('status', updates.status);
  if (updates.solanaSignature) pushSet('solana_signature', updates.solanaSignature);
  if (updates.metadata) pushSet('metadata', JSON.stringify(updates.metadata));

  params.push(txId);
  getDb().prepare(`UPDATE wallet_transactions SET ${sets.join(', ')} WHERE tx_id = ?`).run(...params);
}

/**
 * Get total lamports spent under a specific gate grant key.
 * Used to enforce the per-grant spending limit.
 * Only counts 'spend' type transactions with status != 'failed'.
 */
export function getSpentInCurrentGrant(sandboxId: string, gateKey: string): number {
  const row = getDb().prepare(`
    SELECT COALESCE(SUM(amount_lamports), 0) as total
    FROM wallet_transactions
    WHERE app_name = ? AND gate_key = ? AND type = 'spend' AND status != 'failed'
  `).get(sandboxId, gateKey) as { total: number } | undefined;
  return row?.total ?? 0;
}

/**
 * Look up a transaction by idempotency key.
 * Returns the existing transaction if one was already processed with this key.
 */
export function getTransactionByIdempotencyKey(sandboxId: string, idempotencyKey: string): WalletTransaction | undefined {
  return getDb().prepare(`
    SELECT id, tx_id as txId, app_name as sandboxId, thread_id as threadId,
           type, amount_lamports as amountLamports, recipient,
           solana_signature as solanaSignature, status, gate_key as gateKey,
           idempotency_key as idempotencyKey, metadata,
           created_at as createdAt, updated_at as updatedAt
    FROM wallet_transactions
    WHERE app_name = ? AND idempotency_key = ?
  `).get(sandboxId, idempotencyKey) as WalletTransaction | undefined;
}

/**
 * Record a quantum-blind transaction with HD wallet metadata.
 */
export function recordQuantumBlindTransaction(tx: {
  txId: string;
  sandboxId: string;
  threadId?: string;
  type: 'spend' | 'deposit' | 'refund';
  amountLamports: number;
  recipient?: string;
  gateKey?: string;
  idempotencyKey?: string;
  fromAddress: string;
  changeAddress?: string;
  derivationIndex: number;
  sweepAmountLamports?: number;
  quantumBlindCheck: string;
  metadata?: Record<string, unknown>;
}): void {
  const now = Date.now();
  getDb().prepare(`
    INSERT INTO wallet_transactions (tx_id, app_name, thread_id, type, amount_lamports, recipient, status, gate_key, idempotency_key, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
  `).run(
    tx.txId,
    tx.sandboxId,
    tx.threadId ?? null,
    tx.type,
    tx.amountLamports,
    tx.recipient ?? null,
    tx.gateKey ?? null,
    tx.idempotencyKey ?? null,
    tx.metadata ? JSON.stringify({
      ...tx.metadata,
      fromAddress: tx.fromAddress,
      changeAddress: tx.changeAddress ?? null,
      derivationIndex: tx.derivationIndex,
      sweepAmountLamports: tx.sweepAmountLamports ?? null,
      quantumBlindCheck: tx.quantumBlindCheck,
    }) : JSON.stringify({
      fromAddress: tx.fromAddress,
      changeAddress: tx.changeAddress ?? null,
      derivationIndex: tx.derivationIndex,
      sweepAmountLamports: tx.sweepAmountLamports ?? null,
      quantumBlindCheck: tx.quantumBlindCheck,
    }),
    now,
    now,
  );
}

// ── Signing lock (SQLite-backed, crash-safe) ──
// Replaces in-memory Map — survives process crashes. Stale locks are reclaimed
// after STALE_TIMEOUT_MS. Release requires matching both derivation_index AND
// lock_token to prevent PID-reuse ambiguity.

const SIGNING_LOCK_STALE_TIMEOUT_MS = 30_000;

/**
 * Try to acquire an exclusive signing lock for a derivation index.
 * Returns a release function if acquired, null if already locked.
 *
 * Lock safety:
 * - Acquisition and stale cleanup are in a single SQLite transaction
 * - Release requires matching lock_token (not just PID)
 * - Stale timeout (30s) is the primary crash recovery mechanism
 * - Call markAddressUsed() BEFORE calling the release function
 */
export function tryAcquireSigningLock(index: number): (() => void) | null {
  const now = Date.now();
  const lockToken = crypto.randomBytes(16).toString('hex');

  const acquireTx = getDb().transaction(() => {
    // Clean stale locks from crashed processes
    getDb().prepare(
      'DELETE FROM signing_locks WHERE locked_at < ?'
    ).run(now - SIGNING_LOCK_STALE_TIMEOUT_MS);

    // Try to acquire — UNIQUE constraint on derivation_index prevents double-lock
    try {
      getDb().prepare(
        'INSERT INTO signing_locks (derivation_index, locked_at, pid, lock_token) VALUES (?, ?, ?, ?)'
      ).run(index, now, process.pid, lockToken);
      return true;
    } catch {
      return false; // UNIQUE constraint violation = already locked
    }
  });

  const acquired = acquireTx();
  if (!acquired) return null;

  // Release requires matching lock_token — prevents PID-reuse ambiguity
  return () => {
    getDb().prepare(
      'DELETE FROM signing_locks WHERE derivation_index = ? AND lock_token = ?'
    ).run(index, lockToken);
  };
}

/**
 * Check if an address has been used for outbound signing.
 */
export function isAddressUsed(address: string): boolean {
  const row = getDb().prepare(
    'SELECT 1 FROM used_signing_addresses WHERE address = ?'
  ).get(address) as { 1: number } | undefined;
  return !!row;
}

/**
 * Mark an address as used after signing a transaction.
 */
export function markAddressUsed(address: string, index: number, txId: string, sweptTo: string | null): void {
  getDb().prepare(`
    INSERT OR IGNORE INTO used_signing_addresses (address, derivation_index, first_signed_at, tx_id, swept_to)
    VALUES (?, ?, ?, ?, ?)
  `).run(address, index, Date.now(), txId, sweptTo);
}

/**
 * Get the count of used signing addresses.
 */
export function getUsedAddressCount(): number {
  const row = getDb().prepare('SELECT COUNT(*) as cnt FROM used_signing_addresses').get() as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

/**
 * Get transaction history for an app.
 */
export function getTransactionHistory(sandboxId: string, limit: number = 50): WalletTransaction[] {
  return getDb().prepare(`
    SELECT id, tx_id as txId, app_name as sandboxId, thread_id as threadId,
           type, amount_lamports as amountLamports, recipient,
           solana_signature as solanaSignature, status, gate_key as gateKey,
           idempotency_key as idempotencyKey, metadata,
           created_at as createdAt, updated_at as updatedAt
    FROM wallet_transactions
    WHERE app_name = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(sandboxId, limit) as WalletTransaction[];
}
