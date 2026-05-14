// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Wallet Keypair Service — HD Wallet (PQC Quantum-Blind)
 *
 * BIP-39 mnemonic → BIP-32 HD key derivation for Solana keypairs.
 * Each transaction uses a fresh derived address to prevent quantum
 * harvesting of public keys from on-chain data.
 *
 * The master seed is encrypted at rest using ML-KEM envelope
 * (via the VPS's node.key ML-KEM decapsulation key).
 *
 * File permissions: root:shield 640 (same as node.key)
 * Agent user is NOT in shield group — cannot read the keypair file.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import { x25519 } from '@noble/curves/ed25519.js';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import type { HybridKemPublicKey, HybridKemPrivateKey } from '@ellul.ai/pqc-types';
import { HYBRID_KEM_HKDF_INFO } from '@ellul.ai/pqc-types';
import type { Keypair } from '@solana/web3.js';
function getKeypairClass(): typeof Keypair {
  try { return require('@solana/web3.js').Keypair; }
  catch { throw new Error('Wallet requires @solana/web3.js — enable wallet feature and install dependency'); }
}
import { WALLET_KEYPAIR_FILE, WALLET_STATE_FILE } from '../../config';
import { isWalletEnabled } from './WalletFeature';

const PRIVATE_KEY_PATH = '/etc/ellul-bootstrap/node.key';
const USED_ADDRESSES_FILE = '/var/lib/ellul-shielded/wallet-used-addresses.json';

interface EncryptedHdWalletFile {
  version: 3;
  /** Encrypted BIP-39 mnemonic (AES-256-GCM with HKDF-derived key) */
  encryptedSeed: string;
  /** Base64 ML-KEM-1024 ciphertext */
  encryptedKey: string;
  /** Base64 ephemeral X25519 public key (32 bytes) */
  x25519_eph_pub: string;
  /** AES-GCM IV (12 bytes, base64) */
  iv: string;
  /** HD wallet master fingerprint (first 4 bytes of master pubkey hash) */
  fingerprint: string;
  /** Next unused derivation index */
  nextIndex: number;
}

interface WalletStateFile {
  version: 2;
  /** Current receiving address (base58) */
  publicKey: string;
  /** HD wallet fingerprint */
  fingerprint: string;
  /** Current derivation index */
  currentIndex: number;
  createdAt: string;
  updatedAt: string;
}

interface UsedAddressesFile {
  /** Map of derivation index → base58 address */
  addresses: Record<number, string>;
  /** Addresses that have been swept (funds moved to change address) */
  swept: number[];
}

// ── Private key access (ML-KEM decapsulation key) ──
// Cache as Buffer (not string) with 30s TTL — Buffer can be zeroized via fill(0).
// JS strings are immutable and not zeroizable.

const PK_CACHE_TTL_MS = 30_000;
let privateKeyCache: Buffer | null = null;
let privateKeyCacheExpiry: number = 0;

function getPrivateKey(): string {
  const now = Date.now();
  if (privateKeyCache && now < privateKeyCacheExpiry) {
    return privateKeyCache.toString('utf8');
  }
  // Zeroize previous cache before replacing
  if (privateKeyCache) {
    privateKeyCache.fill(0);
  }
  privateKeyCache = fs.readFileSync(PRIVATE_KEY_PATH);
  privateKeyCacheExpiry = now + PK_CACHE_TTL_MS;
  return privateKeyCache.toString('utf8');
}

// ── Encryption (Hybrid X25519+ML-KEM-1024 + AES-256-GCM) ──

/**
 * Read the hybrid public key from node.pub.json for encapsulation.
 */
function getPublicKey(): HybridKemPublicKey {
  const raw = fs.readFileSync('/etc/ellul-bootstrap/node.pub.json', 'utf8');
  const pub = JSON.parse(raw) as HybridKemPublicKey;
  if (pub.version !== 3 || pub.algorithm !== 'X25519+ML-KEM-1024' || !pub.mlkem_ek || !pub.x25519_pk) {
    throw new Error('PQC: Invalid hybrid public key for wallet seed encryption — expected v3 X25519+ML-KEM-1024');
  }
  return pub;
}

function encryptSeed(seed: Buffer): EncryptedHdWalletFile {
  const pub = getPublicKey();
  const x25519_pk = Buffer.from(pub.x25519_pk, 'base64');
  const mlkem_ek = new Uint8Array(Buffer.from(pub.mlkem_ek, 'base64'));

  // X25519 ephemeral DH
  const eph_sk = x25519.utils.randomSecretKey();
  const eph_pk = x25519.getPublicKey(eph_sk);
  const x25519_ss = x25519.getSharedSecret(eph_sk, x25519_pk);

  // ML-KEM-1024 encapsulate
  const { cipherText: mlkem_ct, sharedSecret: mlkem_ss } = ml_kem1024.encapsulate(mlkem_ek);

  // HKDF-SHA256 — all raw bytes
  const ikm = Buffer.concat([Buffer.from(x25519_ss), Buffer.from(mlkem_ss)]);
  const salt = crypto.createHash('sha256')
    .update(Buffer.from(eph_pk))
    .update(Buffer.from(mlkem_ct))
    .digest();
  const derivedKey = Buffer.from(
    crypto.hkdfSync('sha256', ikm, salt, HYBRID_KEM_HKDF_INFO, 32)
  );

  // AES-256-GCM encrypt
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey, iv);
  const encrypted = Buffer.concat([cipher.update(seed), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const encryptedData = Buffer.concat([encrypted, authTag]);

  // Zeroize
  eph_sk.fill(0);
  x25519_ss.fill(0);
  mlkem_ss.fill(0);
  ikm.fill(0);
  derivedKey.fill(0);

  return {
    version: 3,
    encryptedSeed: encryptedData.toString('base64'),
    encryptedKey: Buffer.from(mlkem_ct).toString('base64'),
    x25519_eph_pub: Buffer.from(eph_pk).toString('base64'),
    iv: iv.toString('base64'),
    fingerprint: '',
    nextIndex: 0,
  };
}

function decryptSeed(file: EncryptedHdWalletFile): Buffer {
  const privateKeyJson = getPrivateKey();
  let priv: HybridKemPrivateKey;
  try {
    priv = JSON.parse(privateKeyJson);
  } catch {
    throw new Error('PQC: Failed to parse private key JSON for wallet seed decryption');
  }

  if (priv.version !== 3 || priv.algorithm !== 'X25519+ML-KEM-1024') {
    throw new Error(`PQC: Unsupported key version/algorithm: ${priv.version}/${priv.algorithm} — expected 3/X25519+ML-KEM-1024`);
  }

  // Decode all key material from base64 to raw bytes
  const x25519_sk = Buffer.from(priv.x25519_sk, 'base64');
  const mlkem_dk = new Uint8Array(Buffer.from(priv.mlkem_dk, 'base64'));
  const x25519_eph_pub = Buffer.from(file.x25519_eph_pub, 'base64');
  const mlkem_ct = new Uint8Array(Buffer.from(file.encryptedKey, 'base64'));

  // X25519 DH + ML-KEM decapsulate
  const x25519_ss = x25519.getSharedSecret(x25519_sk, x25519_eph_pub);
  const mlkem_ss = ml_kem1024.decapsulate(mlkem_ct, mlkem_dk);

  // HKDF-SHA256 — all raw bytes
  const ikm = Buffer.concat([Buffer.from(x25519_ss), Buffer.from(mlkem_ss)]);
  const salt = crypto.createHash('sha256')
    .update(Buffer.from(x25519_eph_pub))
    .update(Buffer.from(mlkem_ct))
    .digest();
  const derivedKey = Buffer.from(
    crypto.hkdfSync('sha256', ikm, salt, HYBRID_KEM_HKDF_INFO, 32)
  );

  // AES-256-GCM decrypt
  const data = Buffer.from(file.encryptedSeed, 'base64');
  const authTag = data.subarray(-16);
  const ciphertext = data.subarray(0, -16);

  const decipher = crypto.createDecipheriv('aes-256-gcm', derivedKey, Buffer.from(file.iv, 'base64'));
  decipher.setAuthTag(authTag);

  const result = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  // Zeroize all sensitive material
  x25519_sk.fill(0);
  x25519_ss.fill(0);
  mlkem_ss.fill(0);
  ikm.fill(0);
  derivedKey.fill(0);

  return result;
}

// ── HD Key Derivation ──

function deriveKeypairAtIndex(mnemonic: string, index: number): Keypair {
  // BIP-44 path for Solana: m/44'/501'/0'/{index}'
  const bip39 = require('bip39');
  const { derivePath } = require('ed25519-hd-key');
  const KP = getKeypairClass();

  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const path = `m/44'/501'/0'/${index}'`;
  const derived = derivePath(path, seed.toString('hex'));

  return KP.fromSeed(derived.key);
}

function computeFingerprint(mnemonic: string): string {
  const bip39 = require('bip39');
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  return crypto.createHash('sha256').update(seed.subarray(0, 32)).digest('hex').substring(0, 8);
}

// ── Used Address Tracking ──

function loadUsedAddresses(): UsedAddressesFile {
  try {
    if (fs.existsSync(USED_ADDRESSES_FILE)) {
      return JSON.parse(fs.readFileSync(USED_ADDRESSES_FILE, 'utf8'));
    }
  } catch {}
  return { addresses: {}, swept: [] };
}

function saveUsedAddresses(data: UsedAddressesFile): void {
  atomicWriteJson(USED_ADDRESSES_FILE, data, 0o640);
}

export function recordUsedAddress(index: number, address: string): void {
  const data = loadUsedAddresses();
  data.addresses[index] = address;
  saveUsedAddresses(data);
}

export function markAddressSwept(index: number): void {
  const data = loadUsedAddresses();
  if (!data.swept.includes(index)) {
    data.swept.push(index);
  }
  saveUsedAddresses(data);
}

export function getUsedAddresses(): UsedAddressesFile {
  return loadUsedAddresses();
}

// ── Quantum-Blind Check ──

/**
 * Perform quantum-blind check on a transaction.
 * Verifies that the sending address has not been publicly exposed on-chain
 * (i.e., no prior outgoing transactions that would reveal the public key).
 *
 * Returns a check result string: "pass" | "warn:reused" | "fail:exposed"
 */
export function quantumBlindCheck(fromIndex: number): string {
  const used = loadUsedAddresses();

  // If the address was previously used for sending (swept), it's exposed
  if (used.swept.includes(fromIndex)) {
    return 'fail:exposed';
  }

  // If the address exists in used but not swept, it may have received funds
  // but not sent — public key not yet on-chain
  if (used.addresses[fromIndex]) {
    return 'warn:reused';
  }

  return 'pass';
}

// ── Atomic file writes ──

function atomicWriteJson(filePath: string, data: unknown, mode: number): void {
  const dir = require('path').dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = filePath + '.tmp';
  const json = JSON.stringify(data, null, 2) + '\n';
  const fd = fs.openSync(tmp, 'w', mode);
  try {
    fs.writeSync(fd, json);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

// ── Public API ──

/**
 * Generate a new HD wallet, encrypt the mnemonic, and write to disk.
 * Idempotent: skips if wallet file already exists.
 */
export function generateWalletKeypair(): { publicKey: string; fingerprint: string } | null {
  if (fs.existsSync(WALLET_KEYPAIR_FILE)) {
    return null; // Already generated
  }

  const bip39 = require('bip39');
  const mnemonic: string = bip39.generateMnemonic(256); // 24 words
  const fingerprint = computeFingerprint(mnemonic);

  // Derive first keypair (index 0) for initial address
  const keypair = deriveKeypairAtIndex(mnemonic, 0);

  // Encrypt and write wallet file (root:shield 640)
  const encrypted = encryptSeed(Buffer.from(mnemonic));
  encrypted.fingerprint = fingerprint;
  encrypted.nextIndex = 1;
  atomicWriteJson(WALLET_KEYPAIR_FILE, encrypted, 0o640);

  // Write state file
  const now = new Date().toISOString();
  const state: WalletStateFile = {
    version: 2,
    publicKey: keypair.publicKey.toBase58(),
    fingerprint,
    currentIndex: 0,
    createdAt: now,
    updatedAt: now,
  };
  atomicWriteJson(WALLET_STATE_FILE, state, 0o640);

  // Record initial address
  recordUsedAddress(0, keypair.publicKey.toBase58());

  // Zero secret material
  keypair.secretKey.fill(0);

  console.log(`[wallet] Generated HD wallet (fingerprint: ${fingerprint}): ${state.publicKey}`);
  return { publicKey: state.publicKey, fingerprint };
}

/**
 * Derive the next fresh keypair (increments derivation index).
 * Used for quantum-blind transactions — each send uses a new address.
 */
export function deriveNextKeypair(): { keypair: Keypair; index: number } | null {
  if (!isWalletEnabled()) return null;

  try {
    const raw = fs.readFileSync(WALLET_KEYPAIR_FILE, 'utf8');
    const file: EncryptedHdWalletFile = JSON.parse(raw);
    if (file.version !== 3) return null;

    const mnemonicBuf = decryptSeed(file);
    const mnemonic = mnemonicBuf.toString('utf8');
    mnemonicBuf.fill(0);

    const index = file.nextIndex;
    const keypair = deriveKeypairAtIndex(mnemonic, index);

    // Increment nextIndex
    file.nextIndex = index + 1;
    atomicWriteJson(WALLET_KEYPAIR_FILE, file, 0o640);

    // Record address
    recordUsedAddress(index, keypair.publicKey.toBase58());

    // Update state
    const now = new Date().toISOString();
    const state: WalletStateFile = {
      version: 2,
      publicKey: keypair.publicKey.toBase58(),
      fingerprint: file.fingerprint,
      currentIndex: index,
      createdAt: now,
      updatedAt: now,
    };
    atomicWriteJson(WALLET_STATE_FILE, state, 0o640);

    return { keypair, index };
  } catch {
    return null;
  }
}

/**
 * Load the Solana keypair at a specific derivation index.
 * Returns null if no wallet exists or feature is disabled.
 */
export function loadWalletKeypair(index?: number): Keypair | null {
  if (!isWalletEnabled()) return null;

  try {
    const raw = fs.readFileSync(WALLET_KEYPAIR_FILE, 'utf8');
    const file = JSON.parse(raw);

    if (file.version === 3) {
      const mnemonicBuf = decryptSeed(file as EncryptedHdWalletFile);
      const mnemonic = mnemonicBuf.toString('utf8');
      mnemonicBuf.fill(0);

      const derivationIndex = index ?? (file as EncryptedHdWalletFile).nextIndex - 1;
      return deriveKeypairAtIndex(mnemonic, Math.max(0, derivationIndex));
    }

    // No legacy fallback — only v3 hybrid KEM wallets accepted
    return null;
  } catch {
    return null;
  }
}

/**
 * Get the wallet public key without loading the secret key into memory.
 */
export function getWalletPublicKey(): string | null {
  if (!isWalletEnabled()) return null;

  try {
    const raw = fs.readFileSync(WALLET_STATE_FILE, 'utf8');
    const state = JSON.parse(raw);
    return state.publicKey || null;
  } catch {
    return null;
  }
}

/**
 * Get the HD wallet fingerprint.
 */
export function getWalletFingerprint(): string | null {
  if (!isWalletEnabled()) return null;

  try {
    const raw = fs.readFileSync(WALLET_STATE_FILE, 'utf8');
    const state = JSON.parse(raw);
    return state.fingerprint || null;
  } catch {
    return null;
  }
}

/**
 * Get the current receiving address (base58) without loading secret key.
 */
export function getCurrentReceiveAddress(): string | null {
  return getWalletPublicKey();
}

/**
 * Get the current derivation index without loading secret key.
 */
export function getCurrentReceiveIndex(): number | null {
  if (!isWalletEnabled()) return null;
  try {
    const raw = fs.readFileSync(WALLET_STATE_FILE, 'utf8');
    const state: WalletStateFile = JSON.parse(raw);
    return state.currentIndex ?? null;
  } catch {
    return null;
  }
}

/**
 * Check if the HD wallet (v2) is active.
 */
export function isHdWalletActive(): boolean {
  if (!isWalletEnabled()) return false;
  try {
    const raw = fs.readFileSync(WALLET_KEYPAIR_FILE, 'utf8');
    const file = JSON.parse(raw);
    return file.version === 3;
  } catch {
    return false;
  }
}

/**
 * Advance to the next HD derivation address.
 * Used after a transaction is signed to rotate to a fresh quantum-blind address.
 */
export function advanceToNextAddress(): { publicKey: string; index: number } | null {
  const result = deriveNextKeypair();
  if (!result) return null;
  const publicKey = result.keypair.publicKey.toBase58();
  result.keypair.secretKey.fill(0);
  return { publicKey, index: result.index };
}

/**
 * Initialize the wallet on shield startup.
 */
export function initWalletIfEnabled(): void {
  if (!isWalletEnabled()) return;
  generateWalletKeypair();
}
