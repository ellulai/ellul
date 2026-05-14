// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * IndexedDB helpers for PoP HMAC key + device identity.
 * Shared between service worker and session-pop client.
 *
 * Design notes:
 * - We only destroy the DB on actual schema mismatch (missing object store).
 *   Transient read errors return null without nuking state — the caller
 *   decides whether that warrants a re-bind. Destroying storage on every
 *   txn error amplifies one transient failure into a permanent key loss.
 * - deviceId is a random per-install identifier stored alongside the HMAC
 *   key; it survives IDB recreation only if storage is persisted.
 * - requestPersistence() should be called at bind time so the browser
 *   treats our origin as non-evictable under storage pressure.
 */

const DB_NAME = 'sovereign-shield';
const STORE_NAME = 'session-keys';
const DB_VERSION = 2;

export const KEY_ID = 'current';
const DEVICE_ID_ROW = 'device-id';

export interface StoredKey {
  id: string;
  hmacKey?: string;
  deviceId?: string;
  createdAt: number;
}

function needsSchemaRebuild(db: IDBDatabase): boolean {
  return !db.objectStoreNames.contains(STORE_NAME);
}

export function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  let db: IDBDatabase;
  try {
    db = await openDB();
  } catch {
    return null;
  }
  if (needsSchemaRebuild(db)) {
    db.close();
    try { indexedDB.deleteDatabase(DB_NAME); } catch {}
    return null;
  }
  return new Promise<T | null>((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE_NAME, mode, { durability: 'strict' } as IDBTransactionOptions);
    } catch {
      try {
        tx = db.transaction(STORE_NAME, mode);
      } catch {
        resolve(null);
        return;
      }
    }
    const req = run(tx.objectStore(STORE_NAME));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => resolve(null);
    tx.onerror = () => resolve(null);
  });
}

export async function getHmacKey(): Promise<string | null> {
  const row = await withStore<StoredKey | undefined>('readonly', (s) => s.get(KEY_ID));
  return row?.hmacKey ?? null;
}

export async function storeHmacKey(hmacKey: string): Promise<void> {
  await withStore('readwrite', (s) => s.put({
    id: KEY_ID,
    hmacKey,
    createdAt: Date.now(),
  } satisfies StoredKey));
}

export async function clearKeys(): Promise<void> {
  await withStore('readwrite', (s) => s.delete(KEY_ID));
}

/**
 * Device identity — a random 128-bit tag written once per install.
 * Generated on first access and then stable until storage is wiped.
 * Used so the server can keep per-device PoP bindings instead of
 * overwriting a single session-wide key.
 */
export async function getOrCreateDeviceId(): Promise<string | null> {
  const existing = await withStore<StoredKey | undefined>('readonly', (s) => s.get(DEVICE_ID_ROW));
  if (existing?.deviceId) return existing.deviceId;
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const deviceId = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  const written = await withStore('readwrite', (s) => s.put({
    id: DEVICE_ID_ROW,
    deviceId,
    createdAt: Date.now(),
  } satisfies StoredKey));
  return written === null ? null : deviceId;
}

/**
 * Ask the browser to mark this origin's storage as persisted.
 * Persisted storage is not evicted under pressure; this prevents Safari
 * ITP / Chromium quota eviction from silently destroying the PoP key.
 * Granted silently for installed PWAs and user-engaged origins.
 */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
