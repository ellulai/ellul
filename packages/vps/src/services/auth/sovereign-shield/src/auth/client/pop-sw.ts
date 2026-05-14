// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * PoP Service Worker v2 (HMAC-SHA256)
 *
 * Intercepts ALL same-origin requests and adds PoP HMAC headers.
 * Installed by SESSION_POP.registerServiceWorker() from session-pop.ts.
 *
 * Runs in ServiceWorkerGlobalScope — no DOM, no window.
 */

/// <reference lib="webworker" />

declare const self: ServiceWorkerGlobalScope;

import { getHmacKey } from './idb';
import { getEmptyBodyHash, hashBody, importHmacKey, hmacSign } from './crypto';

const SKIP_PATHS = [
  '/_auth/pop/bind',
  '/_auth/pop/status',
  '/_auth/pop/sw-confirm',
];

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

async function signAndFetch(request: Request): Promise<Response> {
  try {
    const hmacKeyBase64 = await getHmacKey();
    if (!hmacKeyBase64) return fetch(request);

    const url = new URL(request.url);
    const method = request.method;

    let bodyStr: string | null = null;
    let bodyHash: string;
    if (method !== 'GET' && method !== 'HEAD') {
      bodyStr = await request.clone().text();
      bodyHash = await hashBody(bodyStr);
    } else {
      bodyHash = await getEmptyBodyHash();
    }

    const timestamp = Date.now().toString();
    const nonce = crypto.randomUUID();
    const payload = timestamp + '|' + method + '|' + url.pathname + '|' + bodyHash + '|' + nonce;

    const key = await importHmacKey(hmacKeyBase64);
    const sig64 = await hmacSign(key, payload);

    const newHeaders = new Headers(request.headers);
    newHeaders.set('X-PoP-Timestamp', timestamp);
    newHeaders.set('X-PoP-Nonce', nonce);
    newHeaders.set('X-PoP-Signature', sig64);
    // Body hash is part of the signature payload. Sending it as a header
    // lets the forward_auth handler reconstruct the same payload even though
    // Caddy's forward_auth sub-request has no body. Attacker cannot forge
    // this header because the value is bound by the HMAC signature.
    newHeaders.set('X-PoP-BodyHash', bodyHash);

    const init: RequestInit = {
      method,
      headers: newHeaders,
      credentials: request.credentials,
      redirect: request.redirect,
      referrer: request.referrer,
      referrerPolicy: request.referrerPolicy,
    };
    if (request.mode !== 'navigate') {
      init.mode = request.mode;
    }
    if (method !== 'GET' && method !== 'HEAD' && bodyStr !== null) {
      init.body = bodyStr;
    }

    return fetch(new Request(request.url, init));
  } catch {
    return fetch(request);
  }
}

self.addEventListener('fetch', (event: FetchEvent) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (SKIP_PATHS.some(p => url.pathname.startsWith(p))) return;
  if (url.pathname === '/_auth/static/pop-sw.js') return;
  event.respondWith(signAndFetch(event.request));
});
