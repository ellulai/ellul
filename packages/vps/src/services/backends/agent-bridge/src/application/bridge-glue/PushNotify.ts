// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Remote Push Notification Service (VPS → API)
 *
 * When broadcastToSubscribers detects zero WebSocket subscribers (sent === 0)
 * for important events (gate requests, task completion, errors), this service
 * calls the platform API to trigger APNs/FCM push notifications to the user's
 * registered mobile/desktop devices.
 *
 * Reads server credentials from /etc/ellul/ (same pattern as tier.service.ts
 * in sovereign-shield).
 */

import * as fs from 'fs';
import * as crypto from 'crypto';

const SERVER_ID_FILE = '/etc/ellul-bootstrap/server-id';
const API_URL_FILE = '/etc/ellul/api-url';

// Rate limit: max 1 push per event type per 30 seconds
const pushCooldowns = new Map<string, number>();
const COOLDOWN_MS = 30_000;

interface ServerCredentials {
  serverId: string;
  apiUrl: string;
  token: string | null;
}

let _cachedCreds: ServerCredentials | null = null;
let _credsReadAt = 0;
const CREDS_CACHE_MS = 60_000; // Re-read every 60s

function getServerCredentials(): ServerCredentials | null {
  const now = Date.now();
  if (_cachedCreds && now - _credsReadAt < CREDS_CACHE_MS) {
    return _cachedCreds;
  }

  try {
    const serverId = fs.readFileSync(SERVER_ID_FILE, 'utf8').trim();
    const apiUrl = fs.existsSync(API_URL_FILE)
      ? fs.readFileSync(API_URL_FILE, 'utf8').trim()
      : (() => { try { const z = fs.readFileSync('/etc/ellul/platform-zone', 'utf8').trim(); return `https://api.${z}`; } catch { return ''; } })();

    const token = process.env.AI_PROXY_TOKEN?.trim() || null;

    _cachedCreds = { serverId, apiUrl, token };
    _credsReadAt = now;
    return _cachedCreds;
  } catch {
    return null;
  }
}

/** Event types that warrant a remote push notification */
const PUSHABLE_EVENTS = new Set([
  'gate_request',
  'cli_prompt',
  'command_complete',
  'command_error',
  'deploy_complete',
  'deploy_error',
]);

/**
 * Send a remote push notification via the platform API.
 * Called from broadcastToSubscribers when sent === 0 and the message
 * is an important event type.
 *
 * Non-blocking: fires and forgets. Errors are logged but never thrown.
 */
export function triggerRemotePush(
  eventType: string,
  eventData: Record<string, unknown>
): void {
  if (!PUSHABLE_EVENTS.has(eventType)) return;

  // Rate limit per event type
  const cooldownKey = eventType;
  const lastPush = pushCooldowns.get(cooldownKey) || 0;
  if (Date.now() - lastPush < COOLDOWN_MS) return;
  pushCooldowns.set(cooldownKey, Date.now());

  const creds = getServerCredentials();
  if (!creds?.token) return;

  // Fire and forget — don't block the main thread
  fetch(`${creds.apiUrl}/api/push/send`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${creds.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      eventType,
      eventData,
      timestamp: Date.now(),
      nonce: crypto.randomBytes(16).toString('hex'),
    }),
  }).then(res => {
    if (!res.ok) {
      console.warn(`[PushNotify] API returned ${res.status} for ${eventType}`);
    } else {
      console.log(`[PushNotify] Remote push sent for ${eventType}`);
    }
  }).catch(err => {
    console.warn(`[PushNotify] Failed to send push for ${eventType}:`, (err as Error).message);
  });
}
