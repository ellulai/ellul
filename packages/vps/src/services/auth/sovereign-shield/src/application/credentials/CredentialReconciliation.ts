/**
 * Credential Reconciliation Service
 *
 * Safety net for credential sync between VPS and API.
 * Runs periodically to ensure all local passkey credentials have been
 * synced to the API's userEncryptionCredentials table.
 *
 * Sync chain (ordered by priority):
 *   1. Primary: VPS→API synchronous notification during registration
 *   2. Fallback: Frontend→API direct sync via /encryption/credentials/sync
 *   3. Safety net: This reconciliation service (catches all edge cases)
 *
 * Only re-sends credentials that failed both primary and fallback paths.
 * Uses a local marker file to track which credentials have been confirmed synced.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { db } from '../../database';
import { getServerCredentials } from '../gates/Tier';

const RECONCILIATION_INTERVAL_MS = 5 * 60_000; // 5 minutes
const SYNCED_MARKER_PATH = '/etc/ellul/shield-data/.credentials-synced';

interface SyncedMarker {
  /** Credential IDs confirmed synced to API */
  synced: string[];
  updatedAt: number;
}

function readSyncedMarker(): SyncedMarker {
  try {
    if (fs.existsSync(SYNCED_MARKER_PATH)) {
      return JSON.parse(fs.readFileSync(SYNCED_MARKER_PATH, 'utf8'));
    }
  } catch {}
  return { synced: [], updatedAt: 0 };
}

function writeSyncedMarker(marker: SyncedMarker): void {
  try {
    fs.writeFileSync(SYNCED_MARKER_PATH, JSON.stringify(marker), 'utf8');
  } catch (e) {
    console.warn('[reconciliation] Failed to write synced marker:', (e as Error).message);
  }
}

export function markCredentialSynced(credentialId: string): void {
  const marker = readSyncedMarker();
  if (!marker.synced.includes(credentialId)) {
    marker.synced.push(credentialId);
    marker.updatedAt = Date.now();
    writeSyncedMarker(marker);
  }
}

async function reconcile(): Promise<void> {
  const creds = getServerCredentials();
  if (!creds || !creds.token) return;

  // Get all local credentials
  const localCreds = db.prepare(
    'SELECT credentialId, publicKey, counter, transports, aaguid, name FROM credential'
  ).all() as Array<{
    credentialId: string;
    publicKey: string;
    counter: number;
    transports: string;
    aaguid: string;
    name: string;
  }>;

  if (localCreds.length === 0) return;

  const marker = readSyncedMarker();
  const unsynced = localCreds.filter(c => !marker.synced.includes(c.credentialId));

  if (unsynced.length === 0) return;

  console.log(`[reconciliation] ${unsynced.length} credential(s) not confirmed synced — re-sending`);

  for (const cred of unsynced) {
    try {
      const res = await fetch(`${creds.apiUrl}/api/servers/${creds.serverId}/vps-event`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${creds.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          event: 'passkey_registered',
          data: {
            credentialId: cred.credentialId,
            name: cred.name,
            publicKey: cred.publicKey,
            counter: cred.counter,
            transports: JSON.parse(cred.transports || '[]'),
            aaguid: cred.aaguid,
            // PRF support unknown at reconciliation time — default true for platform passkeys
            prfSupported: true,
          },
          timestamp: Date.now(),
          nonce: crypto.randomBytes(16).toString('hex'),
        }),
        signal: AbortSignal.timeout(5000),
      });

      if (res.ok) {
        markCredentialSynced(cred.credentialId);
        console.log(`[reconciliation] Credential ${cred.credentialId.slice(0, 12)}... synced`);
      }
    } catch (e) {
      console.warn(`[reconciliation] Failed to sync credential:`, (e as Error).message);
    }
  }
}

// Start periodic reconciliation
setInterval(() => {
  reconcile().catch(e => {
    console.warn('[reconciliation] Reconciliation cycle failed:', (e as Error).message);
  });
}, RECONCILIATION_INTERVAL_MS);

// Run once on startup after a 30s delay (let everything initialize)
setTimeout(() => {
  reconcile().catch(() => {});
}, 30_000);
