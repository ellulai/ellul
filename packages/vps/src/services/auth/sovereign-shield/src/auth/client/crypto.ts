// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Browser-side HMAC-SHA256 cryptographic operations for PoP.
 * Shared between service worker and session-pop client.
 */

let EMPTY_BODY_HASH: string | null = null;

function sortKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(v => sortKeys(v));
  return Object.keys(obj as Record<string, unknown>).sort().reduce<Record<string, unknown>>((s, k) => {
    s[k] = sortKeys((obj as Record<string, unknown>)[k]);
    return s;
  }, {});
}

function bufToBase64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function bufToBase64Url(buf: ArrayBuffer): string {
  return bufToBase64(buf)
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

export async function getEmptyBodyHash(): Promise<string> {
  if (EMPTY_BODY_HASH) return EMPTY_BODY_HASH;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(''));
  EMPTY_BODY_HASH = bufToBase64Url(buf);
  return EMPTY_BODY_HASH;
}

export async function hashBody(body: string | object | null | undefined): Promise<string> {
  let canonical = '';
  if (body !== undefined && body !== null && body !== '') {
    if (typeof body === 'string') {
      try { canonical = JSON.stringify(sortKeys(JSON.parse(body))); }
      catch { canonical = body; }
    } else {
      canonical = JSON.stringify(sortKeys(body));
    }
  }
  const data = new TextEncoder().encode(canonical);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return bufToBase64Url(buf);
}

export async function importHmacKey(hmacKeyBase64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw', base64ToBytes(hmacKeyBase64).buffer as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
}

export async function hmacSign(key: CryptoKey, data: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return bufToBase64(sig);
}

export async function hmacSignWithStoredKey(
  hmacKeyBase64: string,
  data: string
): Promise<string> {
  const key = await importHmacKey(hmacKeyBase64);
  return hmacSign(key, data);
}

export { base64ToBytes, bufToBase64, bufToBase64Url };
