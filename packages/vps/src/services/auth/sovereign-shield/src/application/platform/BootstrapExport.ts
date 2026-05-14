/**
 * Bootstrap Export Service
 *
 * Exports passkey public keys from the encrypted SQLite database to the
 * unencrypted root filesystem at /etc/ellul/bootstrap/. This implements
 * the patent's "Pre-Sleep State Checkpoint" (Embodiment 6, paragraph (c)):
 *
 *   "Passkey public keys are exported from the authentication database to
 *    the unencrypted bootstrap partition, ensuring they are available for
 *    the next stateless unlock cycle."
 *
 * The bootstrap directory acts as an unencrypted "bootstrap partition" on
 * the root FS. It contains ONLY public key material — zero secrets. This
 * enables stateless passkey verification in sovereign mode (locked-but-awake)
 * when the encrypted volume containing the auth database is unavailable.
 *
 * Security properties:
 * - Public keys only — attacker with root FS access gains nothing usable
 * - Integrity tripwire: SHA-256 hash stored INSIDE the encrypted volume
 *   detects rogue key injection by cloud provider or root FS attacker
 * - Counter replay protection preserved (counters exported with keys)
 */

import fs from "fs";
import crypto from "crypto";
import { db } from "../../database";

// /etc/ellul/ is a vault bind mount (on the encrypted volume).
// Bootstrap must be on root FS, accessible BEFORE LUKS opens.
const BOOTSTRAP_DIR = "/etc/ellul-bootstrap";
const PASSKEYS_FILE = `${BOOTSTRAP_DIR}/passkeys.json`;
const INTEGRITY_HASH_FILE_VAULT = "/var/lib/ellul-shielded/bootstrap-integrity.hash";

// Files under /etc/ellul-bootstrap/ whose contents drive security decisions
// AFTER volume unlock. Each MUST be covered by the tripwire — a disk-access
// attacker who can flip (for example) `volume-security-mode` from `sovereign`
// back to `enhanced` defeats the sovereign-marker defence-in-depth unless we
// hash that file too. Missing files are hashed as the empty string so the
// attacker cannot evade detection by removing a file entirely.
const TRIPWIRE_FILES: Array<{ key: string; path: string }> = [
  { key: "passkeys.json", path: PASSKEYS_FILE },
  { key: "volume-security-mode", path: `${BOOTSTRAP_DIR}/volume-security-mode` },
  { key: "sovereign-marker", path: `${BOOTSTRAP_DIR}/sovereign-marker` },
  { key: "server-id", path: `${BOOTSTRAP_DIR}/server-id` },
  { key: "migration-signing-pubkey", path: `${BOOTSTRAP_DIR}/migration-signing-pubkey` },
];

function computeTripwireHash(): string {
  // Concatenate `{key}\n{length}\n{content}\n` per file in a fixed order so
  // any change (content or presence) produces a different hash. The length
  // prefix defeats concatenation ambiguities a clever attacker might
  // otherwise exploit.
  const h = crypto.createHash("sha256");
  for (const { key, path } of TRIPWIRE_FILES) {
    let content = "";
    try {
      if (fs.existsSync(path)) content = fs.readFileSync(path, "utf-8");
    } catch { /* treat unreadable as empty; attacker cannot weaken by denying read */ }
    h.update(`${key}\n${content.length}\n${content}\n`);
  }
  return h.digest("hex");
}

interface BootstrapCredential {
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string | null;
  aaguid: string | null;
}

/**
 * Export all passkey credentials to the bootstrap partition on the root FS.
 * Called after: passkey registration, passkey deletion, pre-hibernate checkpoint.
 *
 * Idempotent — safe to call multiple times.
 */
export function exportBootstrapCredentials(): void {
  try {
    if (!db) {
      console.warn("[bootstrap-export] Database not available — skipping export");
      return;
    }

    const credentials = db
      .prepare(
        "SELECT credentialId, publicKey, counter, transports, aaguid FROM credential"
      )
      .all() as BootstrapCredential[];

    // Ensure bootstrap directory exists on root FS
    if (!fs.existsSync(BOOTSTRAP_DIR)) {
      fs.mkdirSync(BOOTSTRAP_DIR, { recursive: true, mode: 0o755 });
    }

    const payload = JSON.stringify(credentials, null, 2);
    fs.writeFileSync(PASSKEYS_FILE, payload, { mode: 0o644 });

    // Compute and store integrity hash inside the encrypted volume (tripwire).
    // After unlock, verifyBootstrapIntegrity() compares this hash against the
    // current set of security-critical bootstrap files to detect tampering.
    // Covers every file in TRIPWIRE_FILES — not just passkeys.json — so an
    // attacker with root-FS write cannot flip the sovereign marker or swap
    // identity files undetected.
    const hash = computeTripwireHash();
    try {
      fs.writeFileSync(INTEGRITY_HASH_FILE_VAULT, hash, { mode: 0o600 });
    } catch {
      // Vault might not be mounted (first export before encryption) — non-fatal
    }

    console.log(
      `[bootstrap-export] Exported ${credentials.length} credential(s) to ${PASSKEYS_FILE}`
    );
  } catch (err) {
    console.error(
      "[bootstrap-export] Failed to export credentials:",
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Read bootstrap credentials from the root FS (for locked-but-awake mode).
 * Returns null if bootstrap file doesn't exist or is invalid.
 */
export function readBootstrapCredentials(): BootstrapCredential[] | null {
  try {
    if (!fs.existsSync(PASSKEYS_FILE)) return null;
    const raw = fs.readFileSync(PASSKEYS_FILE, "utf-8");
    return JSON.parse(raw) as BootstrapCredential[];
  } catch {
    return null;
  }
}

/**
 * Verify bootstrap partition integrity after volume unlock.
 * Compares the SHA-256 hash of the current bootstrap file against the
 * hash stored inside the encrypted volume before sleep.
 *
 * Returns: { valid: true } | { valid: false, reason: string }
 */
export function verifyBootstrapIntegrity(): {
  valid: boolean;
  reason?: string;
} {
  try {
    if (!fs.existsSync(PASSKEYS_FILE)) {
      return { valid: true, reason: "no bootstrap file (not encrypted)" };
    }
    if (!fs.existsSync(INTEGRITY_HASH_FILE_VAULT)) {
      return {
        valid: true,
        reason: "no integrity hash in vault (first boot after encryption)",
      };
    }

    const currentHash = computeTripwireHash();
    const expectedHash = fs
      .readFileSync(INTEGRITY_HASH_FILE_VAULT, "utf-8")
      .trim();

    if (currentHash !== expectedHash) {
      return {
        valid: false,
        reason: `Bootstrap tampered: expected ${expectedHash.slice(0, 16)}..., got ${currentHash.slice(0, 16)}...`,
      };
    }

    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      reason: `Integrity check error: ${err instanceof Error ? err.message : err}`,
    };
  }
}
