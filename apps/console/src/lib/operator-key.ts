// SPDX-License-Identifier: MIT

import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { slh_dsa_sha2_128s } from "@noble/post-quantum/slh-dsa.js";
import { getRequiredSignatureType, type IntentSignatureType } from "@ellul.ai/pqc-types";
import { derivePrfKey } from "./passy-prf";
import { isTauriApp } from "./utils";
import type { BridgeSender } from "./gate-client";
import { getVpsApiUrl } from "./domains";

const PRF_SALT_LABEL = "ellul-browser-signing-keys-v1";
const DB_NAME = "ellul-operator-key";
const STORE = "wrapped";
const DB_VERSION = 1;
const BUNDLE_VERSION = 1;

// Console origin has no PoP Service Worker — direct fetch to shield endpoints
// returns 401 missing_pop_headers, which the dashboard interprets as
// `needsVpsAuth = true` and shows the AuthWall (the "asks again on every
// switch" symptom). All operator-key endpoints route through the bridge
// iframe so the SW at {srv}.ellul.ai signs each request. The bridge sender
// is stashed module-side because operatorKeyFor is called from multiple
// React surfaces and threading the parameter through every signOperation /
// signIntent call would multiply the diff for no semantic gain — there's
// only ever one bridge per dashboard session.
let bridgeSendRef: BridgeSender | null = null;

export class OperatorKeyUnrecoverableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperatorKeyUnrecoverableError";
  }
}

interface SessionState {
  serverDomain: string;
  operatorSecret: Uint8Array;
  operatorPublicKey: string;
  intentMldsa44Secret: Uint8Array;
  intentMldsa44PublicKey: string;
  intentSlhdsa128sSecret: Uint8Array;
  intentSlhdsa128sPublicKey: string;
}

let state: SessionState | null = null;
// Keyed by serverDomain so concurrent resolves for two servers in the same
// tab can't hand the wrong session across.
const inflight = new Map<string, Promise<SessionState>>();

export interface IntentSignature {
  intentSignature: string;
  intentNonce: string;
  intentType: IntentSignatureType;
}

export interface OperatorKeyApi {
  sign(payload: Uint8Array): Promise<{ signature: string; timestamp: string }>;
  signIntent(action: string, resource?: string | null): Promise<IntentSignature>;
  clear(): Promise<void>;
}

export function operatorKeyFor(
  serverDomain: string,
  bridgeSend: BridgeSender,
): OperatorKeyApi {
  if (isTauriApp()) return tauriOperatorKeyFor(serverDomain);
  // Latest call wins. There is one VpsBridgeProvider per dashboard session,
  // so the same bridge instance is passed in for every operatorKeyFor() call.
  bridgeSendRef = bridgeSend;
  return {
    sign: (payload) => signOperation(serverDomain, payload),
    signIntent: (action, resource) => signIntent(serverDomain, action, resource ?? null),
    clear: () => clearOperation(serverDomain),
  };
}

async function tauriInvoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return (window as any).__TAURI_INTERNALS__.invoke(`plugin:shield|${cmd}`, args) as Promise<T>;
}

function tauriOperatorKeyFor(serverDomain: string): OperatorKeyApi {
  return {
    async sign(payload: Uint8Array): Promise<{ signature: string; timestamp: string }> {
      let binary = "";
      for (let i = 0; i < payload.byteLength; i++) {
        binary += String.fromCharCode(payload[i]!);
      }
      const payloadB64 = btoa(binary);
      return tauriInvoke("shield_operator_sign", { payloadB64: payloadB64 });
    },
    async signIntent(action: string, resource?: string | null): Promise<IntentSignature> {
      return tauriInvoke("shield_operator_sign_intent", {
        action,
        resource: resource ?? undefined,
      });
    },
    async clear(): Promise<void> {
      await tauriInvoke("shield_operator_clear");
    },
  };
}

function requireBridge(): BridgeSender {
  if (!bridgeSendRef) {
    throw new OperatorKeyUnrecoverableError(
      "VPS bridge not initialised — operatorKeyFor() must be called inside VpsBridgeProvider before any sign/bind operation.",
    );
  }
  return bridgeSendRef;
}

// Zero all in-memory state and drop every wrapped blob from IDB. Called on
// logout — the wrapped key must not outlive its shield session.
export async function clearAllOperatorKeys(): Promise<void> {
  if (isTauriApp()) {
    await tauriInvoke("shield_operator_clear");
    return;
  }
  zeroizeState();
  await idbClearAll();
}

async function signOperation(
  serverDomain: string,
  payload: Uint8Array,
): Promise<{ signature: string; timestamp: string }> {
  const session = await loadOrBind(serverDomain);
  // Private copy — a concurrent clear() will zero state.operatorSecret and
  // noble reads the key bytes through the hash-tree walk.
  const secret = new Uint8Array(session.operatorSecret);
  try {
    const timestamp = Date.now().toString();
    const sep = new TextEncoder().encode(`|${timestamp}`);
    const message = new Uint8Array(payload.byteLength + sep.byteLength);
    message.set(payload, 0);
    message.set(sep, payload.byteLength);
    const signature = slh_dsa_sha2_128s.sign(message, secret);
    return { signature: bytesToBase64(signature), timestamp };
  } finally {
    secret.fill(0);
  }
}

async function signIntent(
  serverDomain: string,
  action: string,
  resource: string | null,
): Promise<IntentSignature> {
  const required = getRequiredSignatureType(action);
  if (!required) {
    throw new Error(`Action '${action}' is not classified — no intent signature required`);
  }
  const session = await loadOrBind(serverDomain);
  const { nonce } = await fetchIntentNonce(serverDomain, action, resource);
  const payload = new TextEncoder().encode(`intent|${action}|${resource ?? ""}|${nonce}`);
  const secret = new Uint8Array(
    required === "slhdsa128s" ? session.intentSlhdsa128sSecret : session.intentMldsa44Secret,
  );
  try {
    const sig = required === "slhdsa128s"
      ? slh_dsa_sha2_128s.sign(payload, secret)
      : ml_dsa44.sign(payload, secret);
    return {
      intentSignature: bytesToBase64(sig),
      intentNonce: nonce,
      intentType: required,
    };
  } finally {
    secret.fill(0);
  }
}

async function clearOperation(serverDomain: string): Promise<void> {
  if (state && state.serverDomain === serverDomain) zeroizeState();
  await idbDelete(serverDomain);
}

function zeroizeState(): void {
  if (!state) return;
  state.operatorSecret.fill(0);
  state.intentMldsa44Secret.fill(0);
  state.intentSlhdsa128sSecret.fill(0);
  state = null;
}

async function loadOrBind(serverDomain: string): Promise<SessionState> {
  if (state && state.serverDomain === serverDomain) return state;
  const existing = inflight.get(serverDomain);
  if (existing) return existing;
  const promise = (async () => {
    try {
      const resolved = await resolveSession(serverDomain);
      if (!state || state.serverDomain === serverDomain) state = resolved;
      return resolved;
    } finally {
      inflight.delete(serverDomain);
    }
  })();
  inflight.set(serverDomain, promise);
  return promise;
}

interface ServerStatusResponse {
  bound: boolean;
  publicKey?: string;
  intentMldsa44PublicKey?: string;
  intentSlhdsa128sPublicKey?: string;
}

async function resolveSession(serverDomain: string): Promise<SessionState> {
  const send = requireBridge();
  // gate_operator_status / gate_bind_nonce / gate_bind_operator route through
  // the iframe bridge so PoP is signed by the SW at {srv}.ellul.ai. Direct
  // fetch from console origin would 401 with missing_pop_headers and trip
  // the AuthWall on every sandbox/scope switch.
  const status = await send("gate_operator_status");
  const wrappedBlob = await idbGet(serverDomain);

  if (status.bound) {
    if (!wrappedBlob) {
      throw new OperatorKeyUnrecoverableError(
        "Session already bound on another device/tab; local key bundle is missing. Re-authenticate to rebind.",
      );
    }
    const kek = await derivePrfKey(PRF_SALT_LABEL);
    const bundle = await unwrapBundle(wrappedBlob, kek);
    return {
      serverDomain,
      operatorSecret: bundle.operator,
      operatorPublicKey: status.publicKey ?? "",
      intentMldsa44Secret: bundle.intentMldsa44,
      intentMldsa44PublicKey: status.intentMldsa44PublicKey ?? "",
      intentSlhdsa128sSecret: bundle.intentSlhdsa128s,
      intentSlhdsa128sPublicKey: status.intentSlhdsa128sPublicKey ?? "",
    };
  }

  const nonceResp = await send("gate_bind_nonce");
  if (nonceResp.alreadyBound) {
    return resolveSession(serverDomain);
  }
  if (!nonceResp.nonce) {
    throw new OperatorKeyUnrecoverableError(
      "No bind nonce available and session is not bound. Re-authenticate to obtain a fresh session.",
    );
  }

  const operatorKp = slh_dsa_sha2_128s.keygen();
  const mldsaKp = ml_dsa44.keygen();
  const slhdsaIntentKp = slh_dsa_sha2_128s.keygen();

  const operatorPublicKey = bytesToBase64(operatorKp.publicKey);
  const intentMldsa44PublicKey = bytesToBase64(mldsaKp.publicKey);
  const intentSlhdsa128sPublicKey = bytesToBase64(slhdsaIntentKp.publicKey);

  const kek = await derivePrfKey(PRF_SALT_LABEL);
  const wrapped = await wrapBundle(
    {
      operator: operatorKp.secretKey,
      intentMldsa44: mldsaKp.secretKey,
      intentSlhdsa128s: slhdsaIntentKp.secretKey,
    },
    kek,
  );

  try {
    await send("gate_bind_operator", {
      operatorPublicKey,
      operatorBindNonce: nonceResp.nonce,
      intentMldsa44PublicKey,
      intentSlhdsa128sPublicKey,
    });
  } catch (e) {
    // Concurrent-tab race: nonce consumed by whichever tab won the CAS. The
    // winner will eventually write its own wrap under the same IDB key — we
    // surface a retryable error rather than poisoning with ours. The bridge
    // transport rejects with `new Error(parsed.error)` so we no longer have
    // a status code; match on the canonical error text shield emits.
    const msg = e instanceof Error ? e.message : String(e);
    if (
      msg.includes("nonce") ||
      msg.includes("already consumed") ||
      msg.includes("already bound")
    ) {
      throw new OperatorKeyUnrecoverableError(
        "Bind nonce already consumed. Another tab may have just bound this session — retry.",
      );
    }
    throw e;
  }

  await idbPut(serverDomain, wrapped);
  return {
    serverDomain,
    operatorSecret: operatorKp.secretKey,
    operatorPublicKey,
    intentMldsa44Secret: mldsaKp.secretKey,
    intentMldsa44PublicKey,
    intentSlhdsa128sSecret: slhdsaIntentKp.secretKey,
    intentSlhdsa128sPublicKey,
  };
}

// ── Intent nonce ──

async function fetchIntentNonce(
  _serverDomain: string,
  action: string,
  resource: string | null,
): Promise<{ nonce: string; expiresAt: number }> {
  const send = requireBridge();
  return await send("intent_nonce", {
    action,
    ...(resource ? { resource } : {}),
  });
}

// ── Bundle wrap: three secret keys in one AES-GCM envelope ──

interface SecretBundle {
  operator: Uint8Array;
  intentMldsa44: Uint8Array;
  intentSlhdsa128s: Uint8Array;
}

// Serialized layout (plaintext, pre-encryption):
//   u8  version
//   u32 operatorLen
//   u8[operatorLen]     operatorSecret
//   u32 intentMldsa44Len
//   u8[intentMldsa44Len] intentMldsa44Secret
//   u32 intentSlhdsa128sLen
//   u8[intentSlhdsa128sLen] intentSlhdsa128sSecret
function encodeBundle(bundle: SecretBundle): Uint8Array {
  const parts: Uint8Array[] = [];
  const version = new Uint8Array([BUNDLE_VERSION]);
  parts.push(version);
  for (const secret of [bundle.operator, bundle.intentMldsa44, bundle.intentSlhdsa128s]) {
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, secret.byteLength, false);
    parts.push(len);
    parts.push(secret);
  }
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

function decodeBundle(bytes: Uint8Array): SecretBundle {
  if (bytes.byteLength < 1 || bytes[0] !== BUNDLE_VERSION) {
    throw new OperatorKeyUnrecoverableError(
      `Unsupported key bundle version: expected ${BUNDLE_VERSION}, got ${bytes[0] ?? "none"}`,
    );
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 1;
  const readOne = (): Uint8Array => {
    if (off + 4 > bytes.byteLength) {
      throw new OperatorKeyUnrecoverableError("Key bundle truncated (len header)");
    }
    const len = dv.getUint32(off, false);
    off += 4;
    if (off + len > bytes.byteLength) {
      throw new OperatorKeyUnrecoverableError("Key bundle truncated (body)");
    }
    const slice = new Uint8Array(len);
    slice.set(bytes.subarray(off, off + len));
    off += len;
    return slice;
  };
  const operator = readOne();
  const intentMldsa44 = readOne();
  const intentSlhdsa128s = readOne();
  if (off !== bytes.byteLength) {
    throw new OperatorKeyUnrecoverableError("Key bundle has trailing bytes");
  }
  return { operator, intentMldsa44, intentSlhdsa128s };
}

async function wrapBundle(bundle: SecretBundle, kek: Uint8Array): Promise<Uint8Array> {
  const plaintext = encodeBundle(bundle);
  try {
    return await aesGcmEncrypt(plaintext, kek);
  } finally {
    plaintext.fill(0);
  }
}

async function unwrapBundle(blob: Uint8Array, kek: Uint8Array): Promise<SecretBundle> {
  const plaintext = await aesGcmDecrypt(blob, kek);
  try {
    return decodeBundle(plaintext);
  } finally {
    plaintext.fill(0);
  }
}

async function aesGcmEncrypt(plaintext: Uint8Array, kek: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    asArrayBuffer(kek),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: asArrayBuffer(iv) },
    cryptoKey,
    asArrayBuffer(plaintext),
  );
  const out = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ciphertext), iv.byteLength);
  return out;
}

async function aesGcmDecrypt(blob: Uint8Array, kek: Uint8Array): Promise<Uint8Array> {
  if (blob.byteLength < 13) {
    throw new OperatorKeyUnrecoverableError("Stored key bundle is malformed.");
  }
  const iv = blob.slice(0, 12);
  const ciphertext = blob.slice(12);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    asArrayBuffer(kek),
    "AES-GCM",
    false,
    ["decrypt"],
  );
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: asArrayBuffer(iv) },
      cryptoKey,
      asArrayBuffer(ciphertext),
    );
    return new Uint8Array(plaintext);
  } catch {
    throw new OperatorKeyUnrecoverableError(
      "Unable to unwrap key bundle — authenticator may have changed. Re-authenticate to rebind.",
    );
  }
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // Copy into a fresh ArrayBuffer so WebCrypto's strict BufferSource type
  // accepts it regardless of the source's backing (SharedArrayBuffer in
  // cross-origin-isolated contexts, subarray views, etc.).
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

// ── IndexedDB (raw API; no `idb` dep) ──

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key: string): Promise<Uint8Array | null> {
  const db = await openDb();
  try {
    return await new Promise<Uint8Array | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => {
        const val = req.result;
        if (!val) return resolve(null);
        if (val instanceof Uint8Array) return resolve(val);
        if (val instanceof ArrayBuffer) return resolve(new Uint8Array(val));
        resolve(null);
      };
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

async function idbPut(key: string, value: Uint8Array): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function idbDelete(key: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function idbClearAll(): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

// ── HTTP ──

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

async function apiGet<T>(serverDomain: string, path: string): Promise<T> {
  const res = await fetch(`${getVpsApiUrl(serverDomain)}${path}`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new HttpError(res.status, body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function apiPost<T>(
  serverDomain: string,
  path: string,
  body: unknown,
): Promise<T> {
  const res = await fetch(`${getVpsApiUrl(serverDomain)}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new HttpError(res.status, errBody.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}
