// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Client-side Proof of Possession (PoP) — ML-KEM + HMAC-SHA256
 *
 * Manages the full PoP lifecycle in the browser:
 *   1. ML-KEM key encapsulation with server (bind) — keyed per deviceId
 *   2. HMAC key derivation + IndexedDB storage with persisted storage hint
 *   3. WebAuthn PRF-backed silent recovery when IDB is evicted
 *   4. Service worker registration for universal PoP coverage
 *   5. Fetch wrapper fallback when SW unavailable
 *   6. WebSocket challenge-response signing
 *
 * Exposed as `window.SESSION_POP` for inline scripts and terminal wrapper.
 *
 * Device-binding model: every request to /_auth/pop/bind/* carries the local
 * deviceId (stable per browser install, stored in IDB alongside the HMAC
 * key). The server keeps an authoritative per-(session, device) binding, so
 * multiple browsers or profiles coexist without overwriting one another and
 * a single device's IDB loss no longer invalidates the others.
 *
 * Recovery model: when local HMAC is missing but the passkey and wrapped
 * recovery blob still exist, we regain the key via a single WebAuthn
 * assertion with the prf extension — no full re-auth, no tier downgrade,
 * no server-side visibility into the PRF output. The KEK is derived only
 * inside the authenticator's secure element + the browser process.
 */

import {
  getHmacKey,
  storeHmacKey,
  clearKeys,
  getOrCreateDeviceId,
  requestPersistence,
} from './idb';
import {
  hashBody,
  importHmacKey,
  hmacSign,
  base64ToBytes,
  bufToBase64,
} from './crypto';

import type { PqcMlKemModule } from './pqc-mlkem';

declare global {
  interface Window {
    __popFetchWrapped?: boolean;
    SESSION_POP: typeof SESSION_POP;
  }
}

interface BindInitResponse {
  mlkem_ek?: string;
  bind_challenge?: string;
  bound?: boolean;
  existing?: boolean;
  hasWrappedKey?: boolean;
  error?: string;
}

export interface LoginPrfMaterial {
  prfOutput: ArrayBuffer;
  prfSalt: string;
}

// base64url → Uint8Array (PRF salt + eval are transported as base64url).
function b64urlToBytes(b64url: string): Uint8Array {
  const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
  const b64 = (b64url + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  // Back with a concrete ArrayBuffer (not SharedArrayBuffer) so the result
  // satisfies WebCrypto and WebAuthn BufferSource parameter types under
  // strict TS settings.
  const buf = new ArrayBuffer(raw.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ──────────────────────────────────────────────────────────────────────────
// PRF recovery crypto
// ──────────────────────────────────────────────────────────────────────────
//
// KEK = HKDF-SHA256(prf_output, salt=prf_salt, info="pop-recover-kek|v1").
// wrappedHmac = AES-GCM(KEK, nonce || ciphertext) where nonce is a 12-byte
// random prefix. Server stores the wrapped blob only; PRF output never
// leaves the browser.
//
const PRF_KEK_INFO = 'pop-recover-kek|v1';

async function deriveKek(prfOutput: ArrayBuffer, prfSalt: Uint8Array): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: prfSalt as BufferSource,
      info: new TextEncoder().encode(PRF_KEK_INFO),
    },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function wrapHmac(hmacB64: string, kek: CryptoKey): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const pt = new TextEncoder().encode(hmacB64);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, kek, pt);
  const combined = new Uint8Array(nonce.length + ct.byteLength);
  combined.set(nonce, 0);
  combined.set(new Uint8Array(ct), nonce.length);
  return bytesToB64url(combined);
}

async function unwrapHmac(wrappedB64u: string, kek: CryptoKey): Promise<string> {
  const combined = b64urlToBytes(wrappedB64u);
  const nonce = combined.slice(0, 12);
  const ct = combined.slice(12);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, kek, ct);
  return new TextDecoder().decode(pt);
}

// Detect whether the platform authenticator plausibly supports the PRF
// extension. We don't have a reliable feature probe short of running an
// assertion, so we gate on the presence of `PublicKeyCredential` + WebAuthn
// Level 3 APIs and fall through gracefully if PRF evaluation returns empty.
function canAttemptPrf(): boolean {
  return typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential === 'function' &&
    typeof navigator.credentials?.get === 'function';
}

const SESSION_POP = {
  // ── IndexedDB delegation ──

  getHmacKey,
  storeHmacKey,
  clearKeys,

  // ── Crypto delegation ──

  hashBody,

  async hmacSign(data: string): Promise<string> {
    const hmacKeyB64 = await getHmacKey();
    if (!hmacKeyB64) throw new Error('No session HMAC key');
    const key = await importHmacKey(hmacKeyB64);
    return hmacSign(key, data);
  },

  // ── Request signing ──

  async signRequest(
    url: string,
    method: string = 'GET',
    body: string | null = null
  ): Promise<Record<string, string>> {
    const timestamp = Date.now().toString();
    const nonce = crypto.randomUUID();
    const bodyHash = await hashBody(body);
    const payload = timestamp + '|' + method + '|' + url + '|' + bodyHash + '|' + nonce;
    const signature = await this.hmacSign(payload);
    return {
      'X-PoP-Timestamp': timestamp,
      'X-PoP-Nonce': nonce,
      'X-PoP-Signature': signature,
      'X-PoP-BodyHash': bodyHash,
    };
  },

  // ── Login assertion with PRF piggyback ──

  /**
   * Run the login WebAuthn ceremony with the prf extension attached so the
   * same biometric tap produces both the assertion (verified by /login/verify)
   * and a PRF output that `initialize()` can use to enroll recovery material
   * during /pop/bind/complete — eliminating a second user-visible prompt.
   */
  async runLoginAssertion(
    optionsJSON: PublicKeyCredentialRequestOptionsJSON,
  ): Promise<{
    assertion: ReturnType<typeof publicKeyCredentialToJSON>;
    prfMaterial?: LoginPrfMaterial;
  }> {
    const prfSaltBytes = crypto.getRandomValues(new Uint8Array(32));
    const prfSalt = bytesToB64url(prfSaltBytes);

    const publicKey: PublicKeyCredentialRequestOptions = {
      ...jsonToPublicKeyRequest(optionsJSON),
    };
    if (canAttemptPrf()) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (publicKey as any).extensions = { prf: { eval: { first: prfSaltBytes } } };
    }

    const credential = await navigator.credentials.get({ publicKey }) as PublicKeyCredential | null;
    if (!credential) throw new Error('Authentication cancelled');

    const assertion = publicKeyCredentialToJSON(credential);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ext = (credential.getClientExtensionResults?.() || {}) as any;
    const prfOutput: ArrayBuffer | undefined = ext.prf?.results?.first;

    return prfOutput
      ? { assertion, prfMaterial: { prfOutput, prfSalt } }
      : { assertion };
  },

  // ── ML-KEM bind flow ──

  async initialize(prfMaterial?: LoginPrfMaterial): Promise<boolean> {
    // Pre-flight sanity checks on the local HMAC key. Corrupt base64 is
    // unrecoverable — drop it and let the bind flow / recovery flow replace
    // it. A transient read error returns null from getHmacKey() without
    // wiping, so we don't amplify a one-off IDB glitch into a full re-auth.
    try {
      const existing = await getHmacKey();
      if (existing) atob(existing);
    } catch {
      await clearKeys();
    }

    // Ask the browser to persist our origin's storage so Safari ITP and
    // Chromium quota eviction can't silently discard the HMAC key under
    // pressure. Silently no-ops if the permission isn't granted.
    await requestPersistence().catch(() => {});

    const deviceId = await getOrCreateDeviceId();
    if (!deviceId) {
      throw new Error('Unable to allocate device id — IndexedDB unavailable');
    }

    // Phase 1: server says bound-or-not for THIS device.
    const initRes = await fetch('/_auth/pop/bind/init', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId }),
    });

    // Normalise: both 200 and 4xx bodies may carry bound/existing/error.
    const initBody: BindInitResponse = await initRes.json().catch(() => ({}));

    if (initRes.ok && initBody.bound && initBody.existing) {
      const localKey = await getHmacKey();
      if (localKey) return true;

      // Local HMAC missing (IDB eviction). Instead of PRF recovery (which
      // triggers a second passkey popup), delete the stale binding and
      // create a fresh one — no user interaction needed.
      const rebindRes = await fetch('/_auth/pop/bind/init', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, forceRebind: true }),
      });
      const rebindBody: BindInitResponse = await rebindRes.json().catch(() => ({}));
      if (rebindRes.ok && rebindBody.mlkem_ek && rebindBody.bind_challenge) {
        return this._completeBind(deviceId, rebindBody.mlkem_ek, rebindBody.bind_challenge, prfMaterial);
      }
      throw new Error('Device rebind failed');
    }

    if (!initRes.ok) {
      throw new Error(initBody.error || 'Bind init failed');
    }

    if (!initBody.mlkem_ek || !initBody.bind_challenge) {
      throw new Error('Malformed bind init response');
    }

    return this._completeBind(deviceId, initBody.mlkem_ek, initBody.bind_challenge, prfMaterial);
  },

  /**
   * Complete the ML-KEM bind handshake. When `prfMaterial` is provided (from
   * the same WebAuthn ceremony that produced the login assertion), the
   * derived HMAC is wrapped with a PRF-derived KEK and the wrapped blob +
   * salt are persisted to /pop/bind/complete in the same call. This enrolls
   * silent recovery without a second WebAuthn prompt.
   */
  async _completeBind(
    deviceId: string,
    mlkem_ek: string,
    bind_challenge: string,
    prfMaterial?: LoginPrfMaterial,
  ): Promise<boolean> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pqcModule = (await import(/* webpackIgnore: true */ '/_auth/static/pqc-mlkem.js' as any)) as PqcMlKemModule;
    const ekBytes = base64ToBytes(mlkem_ek);
    const { sharedSecret, cipherText } = pqcModule.ml_kem1024.encapsulate(ekBytes);

    const proofKey = await crypto.subtle.importKey(
      'raw', sharedSecret.buffer as ArrayBuffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const proofSig = await crypto.subtle.sign(
      'HMAC', proofKey, new TextEncoder().encode('pop-bind|' + bind_challenge)
    );
    const bindProof = bufToBase64(proofSig);
    const ctB64 = bufToBase64(cipherText.buffer as ArrayBuffer);

    const kPopKey = await crypto.subtle.importKey(
      'raw', sharedSecret.buffer as ArrayBuffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const kPopSig = await crypto.subtle.sign(
      'HMAC', kPopKey, new TextEncoder().encode('pop-session-mac')
    );
    const kPop = bufToBase64(kPopSig);

    sharedSecret.fill(0);

    await storeHmacKey(kPop);

    const payload: Record<string, string> = {
      deviceId, ciphertext: ctB64, bind_proof: bindProof,
    };
    if (prfMaterial) {
      const prfSaltBytes = b64urlToBytes(prfMaterial.prfSalt);
      const kek = await deriveKek(prfMaterial.prfOutput, prfSaltBytes);
      payload.wrapped_hmac = await wrapHmac(kPop, kek);
      payload.prf_salt = prfMaterial.prfSalt;
    }

    const completeRes = await fetch('/_auth/pop/bind/complete', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!completeRes.ok) {
      await clearKeys();
      const err = await completeRes.json().catch(() => ({}));
      throw new Error(err.error || 'Bind complete failed');
    }

    return true;
  },

  // ── PRF recovery ──

  /**
   * Attempt to recover the HMAC key via WebAuthn PRF.
   * Requires the server to have recovery material (wrapped_hmac + prf_salt)
   * for this (session, device) pair. Returns true on successful recovery.
   */
  async _attemptPrfRecovery(deviceId: string): Promise<boolean> {
    if (!canAttemptPrf()) return false;

    const optRes = await fetch('/_auth/pop/recover/options', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId }),
    });
    if (!optRes.ok) return false;
    const { options, prf_salt } = await optRes.json() as {
      options: PublicKeyCredentialRequestOptionsJSON;
      prf_salt: string;
    };

    const prfSaltBytes = b64urlToBytes(prf_salt);
    const getOptions: CredentialRequestOptions = {
      publicKey: {
        ...jsonToPublicKeyRequest(options),
        extensions: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          prf: { eval: { first: prfSaltBytes } } as any,
        },
      },
    };

    const credential = await navigator.credentials.get(getOptions) as PublicKeyCredential | null;
    if (!credential) return false;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const extResults = (credential.getClientExtensionResults?.() || {}) as any;
    const prfOutput: ArrayBuffer | undefined = extResults.prf?.results?.first;
    if (!prfOutput) return false;

    // Complete the recovery: server verifies the assertion, hands back the
    // wrapped blob, we unwrap locally and repopulate IDB.
    const assertion = publicKeyCredentialToJSON(credential);
    const completeRes = await fetch('/_auth/pop/recover/complete', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, assertion }),
    });
    if (!completeRes.ok) return false;
    const { wrapped_hmac } = await completeRes.json() as { wrapped_hmac: string };

    const kek = await deriveKek(prfOutput, prfSaltBytes);
    const hmacB64 = await unwrapHmac(wrapped_hmac, kek);
    await storeHmacKey(hmacB64);
    return true;
  },

  /**
   * Enroll recovery material: fresh assertion + prf extension, derive KEK,
   * encrypt current HMAC key, hand wrapped blob to server. Server never
   * sees the KEK or the HMAC.
   */
  async _enrollPrfRecovery(deviceId: string, hmacB64: string): Promise<boolean> {
    if (!canAttemptPrf()) return false;

    const optRes = await fetch('/_auth/pop/recover/enroll/options', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId }),
    });
    if (!optRes.ok) return false;
    const { options, prf_salt } = await optRes.json() as {
      options: PublicKeyCredentialRequestOptionsJSON;
      prf_salt: string;
    };

    const prfSaltBytes = b64urlToBytes(prf_salt);
    const getOptions: CredentialRequestOptions = {
      publicKey: {
        ...jsonToPublicKeyRequest(options),
        extensions: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          prf: { eval: { first: prfSaltBytes } } as any,
        },
      },
    };

    const credential = await navigator.credentials.get(getOptions) as PublicKeyCredential | null;
    if (!credential) return false;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const extResults = (credential.getClientExtensionResults?.() || {}) as any;
    const prfOutput: ArrayBuffer | undefined = extResults.prf?.results?.first;
    if (!prfOutput) return false;

    const kek = await deriveKek(prfOutput, prfSaltBytes);
    const wrapped = await wrapHmac(hmacB64, kek);
    const assertion = publicKeyCredentialToJSON(credential);

    const completeRes = await fetch('/_auth/pop/recover/enroll/complete', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, wrapped_hmac: wrapped, prf_salt, assertion }),
    });
    return completeRes.ok;
  },

  // ── Service Worker registration ──

  async registerServiceWorker(): Promise<boolean> {
    if (!('serviceWorker' in navigator)) return false;
    try {
      const reg = await navigator.serviceWorker.register('/_auth/static/pop-sw.js', { scope: '/' });
      const sw = reg.installing || reg.waiting || reg.active;
      if (sw && sw.state !== 'activated') {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => resolve(), 3000);
          sw.addEventListener('statechange', () => {
            if (sw.state === 'activated') { clearTimeout(timeout); resolve(); }
            if (sw.state === 'redundant') { clearTimeout(timeout); reject(new Error('SW redundant')); }
          });
        });
      }
      await fetch('/_auth/pop/sw-confirm', { method: 'POST', credentials: 'include' });
      return true;
    } catch (e) {
      console.warn('[PoP] Service Worker registration failed:', e);
      return false;
    }
  },

  // ── Fetch wrapper (fallback when SW unavailable) ──

  wrapFetch(): void {
    if (navigator.serviceWorker && navigator.serviceWorker.controller) return;
    const originalFetch = window.fetch;
    const self = this;
    window.fetch = async function(
      input: RequestInfo | URL,
      options: RequestInit = {}
    ): Promise<Response> {
      const urlObj = new URL(input as string, window.location.origin);
      if (urlObj.origin !== window.location.origin) return originalFetch(input, options);
      if (urlObj.pathname.startsWith('/_auth/pop/')) return originalFetch(input, options);
      try {
        const popHeaders = await self.signRequest(
          urlObj.pathname,
          (options.method || 'GET') as string,
          (options.body as string) || null
        );
        options.headers = { ...options.headers, ...popHeaders };
      } catch (e) { console.warn('[PoP] Sign failed:', e); }
      return originalFetch(input, options);
    };
  },

  // ── WebSocket challenge-response ──

  createSignedWebSocket(url: string, protocols?: string | string[]): WebSocket {
    const ws = new WebSocket(url, protocols);
    const self = this;
    let userOnMessage: ((event: MessageEvent) => void) | null = null;
    Object.defineProperty(ws, 'onmessage', {
      set(fn: ((event: MessageEvent) => void) | null) { userOnMessage = fn; },
      get() { return userOnMessage; },
    });
    ws.addEventListener('message', async (event: MessageEvent) => {
      if (typeof event.data === 'string' && event.data.startsWith('POP_CHALLENGE:')) {
        const challenge = event.data.slice('POP_CHALLENGE:'.length);
        try {
          const signature = await self.hmacSign('challenge|' + challenge);
          ws.send('POP_RESPONSE:' + signature);
        } catch (e) {
          console.error('[PoP] Challenge failed:', e);
          ws.close(4001, 'PoP challenge failed');
        }
        return;
      }
      if (userOnMessage) userOnMessage(event);
    });
    return ws;
  },
};

// ──────────────────────────────────────────────────────────────────────────
// WebAuthn options JSON <-> binary marshalling
// ──────────────────────────────────────────────────────────────────────────
//
// @simplewebauthn/server emits JSON-encoded options (base64url strings for
// challenge + credential ids). navigator.credentials.get() wants ArrayBuffers.
// These helpers are narrow, not a full port of @simplewebauthn/browser.

interface PublicKeyCredentialRequestOptionsJSON {
  challenge: string;
  rpId?: string;
  timeout?: number;
  userVerification?: UserVerificationRequirement;
  allowCredentials?: Array<{
    id: string;
    type: 'public-key';
    transports?: AuthenticatorTransport[];
  }>;
}

function jsonToPublicKeyRequest(
  json: PublicKeyCredentialRequestOptionsJSON,
): PublicKeyCredentialRequestOptions {
  return {
    challenge: b64urlToBytes(json.challenge) as BufferSource,
    rpId: json.rpId,
    timeout: json.timeout,
    userVerification: json.userVerification,
    allowCredentials: json.allowCredentials?.map(c => ({
      id: b64urlToBytes(c.id) as BufferSource,
      type: c.type,
      transports: c.transports,
    })),
  };
}

function publicKeyCredentialToJSON(cred: PublicKeyCredential): {
  id: string;
  rawId: string;
  type: string;
  response: {
    authenticatorData: string;
    signature: string;
    userHandle: string | null;
    clientDataJSON: string;
  };
} {
  const resp = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    rawId: bytesToB64url(cred.rawId),
    type: cred.type,
    response: {
      authenticatorData: bytesToB64url(resp.authenticatorData),
      signature: bytesToB64url(resp.signature),
      userHandle: resp.userHandle ? bytesToB64url(resp.userHandle) : null,
      clientDataJSON: bytesToB64url(resp.clientDataJSON),
    },
  };
}

// ── Auto-initialize ──
// Freeze to prevent runtime property tampering (XSS → prototype pollution → PoP bypass).
window.SESSION_POP = Object.freeze(SESSION_POP);

SESSION_POP.initialize()
  .then(() => {
    if (!window.__popFetchWrapped) { SESSION_POP.wrapFetch(); window.__popFetchWrapped = true; }
    SESSION_POP.registerServiceWorker();
  })
  .catch(() => {});
