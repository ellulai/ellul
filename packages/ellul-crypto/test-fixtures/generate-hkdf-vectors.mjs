#!/usr/bin/env node
// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Generate deterministic HKDF combiner test vectors for cross-platform verification.
 *
 * Run once: node generate-hkdf-vectors.mjs
 * Output:   hkdf-combiner-vectors.json (committed alongside this script)
 *
 * The hybrid KEM combiner uses:
 *   HKDF-SHA256(
 *     IKM  = x25519_ss || mlkem_ss,        (64 bytes, raw)
 *     salt = SHA-256(eph_pub || ct),        (32 bytes)
 *     info = "ellul-hybrid-kem-v1",       (UTF-8)
 *     L    = 32
 *   )
 *
 * ALL inputs are raw bytes, never base64/hex strings.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const INFO = "ellul-hybrid-kem-v1";
const MLKEM_CT_LEN = 1568;

function hexEncode(buf) {
  return Buffer.from(buf).toString("hex");
}

function computeVector({ x25519_ss, mlkem_ss, x25519_eph_pub, mlkem_ct, label }) {
  // salt = SHA-256(eph_pub || ct)
  const salt = crypto.createHash("sha256")
    .update(x25519_eph_pub)
    .update(mlkem_ct)
    .digest();

  // IKM = x25519_ss || mlkem_ss
  const ikm = Buffer.concat([x25519_ss, mlkem_ss]);

  // HKDF-SHA256
  const derivedKey = Buffer.from(
    crypto.hkdfSync("sha256", ikm, salt, INFO, 32)
  );

  return {
    label,
    x25519_ss: hexEncode(x25519_ss),
    mlkem_ss: hexEncode(mlkem_ss),
    x25519_eph_pub: hexEncode(x25519_eph_pub),
    mlkem_ct: hexEncode(mlkem_ct),
    expected_salt: hexEncode(salt),
    expected_derived_key: hexEncode(derivedKey),
  };
}

// Vector 1: all zeros
const v1 = computeVector({
  label: "all-zeros",
  x25519_ss: Buffer.alloc(32, 0x00),
  mlkem_ss: Buffer.alloc(32, 0x00),
  x25519_eph_pub: Buffer.alloc(32, 0x00),
  mlkem_ct: Buffer.alloc(MLKEM_CT_LEN, 0x00),
});

// Vector 2: incrementing bytes
const v2_x25519_ss = Buffer.from(Array.from({ length: 32 }, (_, i) => i));           // 0x00..0x1f
const v2_mlkem_ss = Buffer.from(Array.from({ length: 32 }, (_, i) => 0x20 + i));     // 0x20..0x3f
const v2_eph_pub = Buffer.from(Array.from({ length: 32 }, (_, i) => 0x40 + i));      // 0x40..0x5f
const v2_ct_head = Buffer.from(Array.from({ length: 32 }, (_, i) => 0x60 + i));      // 0x60..0x7f
const v2_ct = Buffer.concat([v2_ct_head, Buffer.alloc(MLKEM_CT_LEN - 32, 0x00)]);

const v2 = computeVector({
  label: "incrementing",
  x25519_ss: v2_x25519_ss,
  mlkem_ss: v2_mlkem_ss,
  x25519_eph_pub: v2_eph_pub,
  mlkem_ct: v2_ct,
});

// Vector 3: all 0xff
const v3 = computeVector({
  label: "all-ff",
  x25519_ss: Buffer.alloc(32, 0xff),
  mlkem_ss: Buffer.alloc(32, 0xff),
  x25519_eph_pub: Buffer.alloc(32, 0xff),
  mlkem_ct: Buffer.alloc(MLKEM_CT_LEN, 0xff),
});

const fixture = {
  description: "HKDF combiner test vectors for hybrid X25519+ML-KEM-1024 KEM",
  algorithm: "HKDF-SHA256",
  info: INFO,
  vectors: [v1, v2, v3],
};

const outPath = path.join(__dirname, "hkdf-combiner-vectors.json");
fs.writeFileSync(outPath, JSON.stringify(fixture, null, 2) + "\n");
console.log(`Wrote ${outPath}`);
