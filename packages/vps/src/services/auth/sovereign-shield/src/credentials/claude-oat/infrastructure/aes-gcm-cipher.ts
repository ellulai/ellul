// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

/**
 * AES-256-GCM credential cipher with HKDF-SHA256 key derivation.
 *
 * The wrap key is derived from:
 *   - /etc/ellul-bootstrap/server-id (per-VPS identity, on boot partition)
 *   - <SHIELD_DATA_DIR>/.claude-oat-wrap-secret (per-VPS random, root:shield 600)
 *
 * Combined via HKDF with the domain-separation info string
 * "ellul:claude-oat:wrap:v1". A backup of /etc/ellul/shield-data alone
 * cannot decrypt the token without the boot partition secret.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import type { CredentialCipher } from "../application/ports";
import type { WrappedCredential } from "../domain/credential";

const WRAP_SECRET_MODE = 0o600;
const HKDF_INFO = "ellul:claude-oat:wrap:v1";
const KEY_LENGTH = 32;

export interface CipherConfig {
  readonly wrapSecretPath: string;
  readonly serverIdPath: string;
  readonly dataDir: string;
}

export class AesGcmCipher implements CredentialCipher {
  private readonly key: Buffer;

  constructor(config: CipherConfig) {
    AesGcmCipher.ensureWrapSecret(config);
    this.key = AesGcmCipher.deriveKey(config);
  }

  wrap(plaintext: string, createdAt: string): WrappedCredential {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, nonce);
    const ct = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return {
      wrappedToken: ct.toString("base64"),
      nonce: nonce.toString("base64"),
      authTag: authTag.toString("base64"),
      tokenFingerprint: AesGcmCipher.fingerprint(plaintext),
      createdAt,
      lastVerifiedAt: null,
    };
  }

  unwrap(cred: WrappedCredential): string {
    const nonce = Buffer.from(cred.nonce, "base64");
    const ct = Buffer.from(cred.wrappedToken, "base64");
    const authTag = Buffer.from(cred.authTag, "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, nonce);
    decipher.setAuthTag(authTag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    const plaintext = pt.toString("utf8");
    if (AesGcmCipher.fingerprint(plaintext) !== cred.tokenFingerprint) {
      throw new Error("claude-oat: wrapped credential fingerprint mismatch");
    }
    return plaintext;
  }

  /** SHA-256 of plaintext, hex, first 16 chars. Audit-friendly. */
  static fingerprint(plaintext: string): string {
    return crypto
      .createHash("sha256")
      .update(plaintext, "utf8")
      .digest("hex")
      .slice(0, 16);
  }

  private static ensureWrapSecret(config: CipherConfig): void {
    if (fs.existsSync(config.wrapSecretPath)) return;
    fs.mkdirSync(config.dataDir, { recursive: true });
    const secret = crypto.randomBytes(32);
    const tmp = `${config.wrapSecretPath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, secret, { mode: WRAP_SECRET_MODE });
    fs.renameSync(tmp, config.wrapSecretPath);
  }

  private static deriveKey(config: CipherConfig): Buffer {
    const wrapSecret = fs.readFileSync(config.wrapSecretPath);
    let serverId = "ellul-no-server-id";
    try {
      serverId =
        fs.readFileSync(config.serverIdPath, "utf8").trim() || serverId;
    } catch {
      // SERVER_ID_FILE may not exist on a freshly-provisioned dev box.
      // Per-VPS uniqueness is still preserved via the wrap secret.
    }
    return Buffer.from(
      crypto.hkdfSync(
        "sha256",
        wrapSecret,
        Buffer.from(serverId, "utf8"),
        HKDF_INFO,
        KEY_LENGTH,
      ),
    );
  }
}
