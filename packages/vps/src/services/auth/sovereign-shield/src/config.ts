// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Sovereign Shield Configuration
 *
 * All constants, file paths, and security configuration.
 */

import * as fs from "fs";

// Derive service user from ELLUL_SVC_USER env (set by systemd unit) or /etc/default/ellul
// After Phase 1 (shield-runner separation), sovereign-shield runs as shield-runner
// but still needs to know $SVC_USER for runuser operations (git, project access).
export function getServiceUser(): string {
  // Prefer env var (set by systemd Environment= directive)
  if (process.env.ELLUL_SVC_USER) return process.env.ELLUL_SVC_USER;
  try {
    const content = fs.readFileSync("/etc/default/ellul", "utf8");
    const match = content.match(/PS_USER=(\w+)/);
    if (match?.[1]) return match[1];
  } catch {}
  return "dev";
}

export const SVC_USER = getServiceUser();
export const SVC_HOME = `/home/${SVC_USER}`;

// Internal service token for authenticating internal API calls. Generated
// fresh on each sovereign-shield start; per-service tokens are derived via HMAC.
export const INTERNAL_TOKEN_PATH = "/run/shield/internal.token";

// File paths
// Mutable data lives in shield-data/ (owned by $SVC_USER, isolated from root config)
export const SHIELD_DATA_DIR = "/etc/ellul/shield-data";
export const DB_PATH = `${SHIELD_DATA_DIR}/local-auth.db`;
export const SETUP_TOKEN_FILE = `${SHIELD_DATA_DIR}/.sovereign-setup-token`;
export const AUTH_SECRET_FILE = `${SHIELD_DATA_DIR}/.sovereign-auth-secret`;
export const AUTH_SECRETS_FILE = `${SHIELD_DATA_DIR}/auth-secrets.json`;
export const PENDING_SSH_BLOCK_FILE = `${SHIELD_DATA_DIR}/.pending-ssh-block`;
export const PENDING_TIER_NOTIFICATION_FILE = `${SHIELD_DATA_DIR}/.pending-tier-notification`;
export const SOVEREIGN_KEYS_FILE = `${SHIELD_DATA_DIR}/.sovereign-keys`;
export const DOMAIN_FILE = "/etc/ellul/domain";
export const SETUP_EXPIRY_FILE = `${SHIELD_DATA_DIR}/.sovereign-setup-expiry`;
export const TERMINAL_DISABLED_FILE = `${SHIELD_DATA_DIR}/.terminal-disabled`;
export const TIER_FILE = "/etc/ellul/security-tier";
export const SHIELD_MARKER = "/etc/ellul/.sovereign-shield-active";
export const ATTESTATION_POLICY_FILE = "/etc/ellul/attestation-policy.json";
export const JWT_SECRET_FILE = "/etc/ellul/jwt-secret";
// Root-owned authorized_keys (0600 root:root) — agent cannot read, write, or list.
// sshd reads via AuthorizedKeysCommand (root-owned script, 0700) — not AuthorizedKeysFile.
export const SSH_AUTH_KEYS_PATH = `/etc/ssh/authorized_keys/${SVC_USER}`;
export const SERVER_ID_FILE = "/etc/ellul-bootstrap/server-id";
export const AI_PROXY_TOKEN_FILE = "/etc/ellul-bootstrap/ai-proxy-token";
export const API_URL_FILE = "/etc/ellul/api-url";
export const ORIGIN_TAG_FILE = "/etc/ellul/origin-tag";

// Service configuration
export const PORT = 3005;
export const RP_NAME = "ellul";

/**
 * One-time backfill for VPSes provisioned before the zone/origin files existed.
 * Derives the new required files from /etc/ellul/domain + /etc/ellul/dev-domain
 * so older VPSes can upgrade without a manual ops step.
 *
 * Safety rails:
 *   - Idempotent: no-op if the target files are already present.
 *   - Refuses to derive unless the domain + dev-domain match the Ellul zones
 *     (/etc/ellul/domain ends with .ellul.ai, dev-domain ends with .ellul.app).
 *     Any other shape means the VPS has been manually retargeted and this
 *     auto-derivation would guess wrong; we fall through to the readRequiredFile
 *     throws below, which surfaces the misconfiguration loudly.
 */
function backfillZoneFilesIfMissing(): void {
  let domain = "";
  let devDomain = "";
  try {
    domain = fs.readFileSync("/etc/ellul/domain", "utf8").trim();
    devDomain = fs.readFileSync("/etc/ellul/dev-domain", "utf8").trim();
  } catch {
    return;
  }
  if (!domain || !devDomain) return;

  // Require the pre-existing Ellul shape. Any other shape → refuse to guess.
  if (!domain.endsWith(".ellul.ai") || !devDomain.endsWith(".ellul.app")) {
    return;
  }

  const platformZone = "ellul.ai";
  const appZone = "ellul.app";
  const shortId = (domain.split(".")[0] ?? "").replace(/-(srv|dc|code|dcode)$/, "");
  const consoleOrigin = `https://console.${platformZone}`;

  const write = (p: string, v: string) => {
    if (!fs.existsSync(p)) {
      try { fs.writeFileSync(p, v + "\n", { mode: 0o644 }); } catch {}
    }
  };
  write("/etc/ellul/platform-zone", platformZone);
  write("/etc/ellul/app-zone", appZone);
  write("/etc/ellul/rp-id", platformZone);
  write("/etc/ellul/console-origin", consoleOrigin);

  if (!fs.existsSync("/etc/ellul/allowed-origins")) {
    const origins = [
      `https://${domain}`,
      shortId ? `https://${shortId}-srv.${platformZone}` : null,
      shortId ? `https://${shortId}-dc.${platformZone}` : null,
      consoleOrigin,
    ].filter((v): v is string => !!v).join("\n");
    try {
      fs.writeFileSync("/etc/ellul/allowed-origins", origins + "\n", { mode: 0o644 });
    } catch {}
  }
}
backfillZoneFilesIfMissing();

function readRequiredFile(path: string, purpose: string): string {
  let value: string;
  try {
    value = fs.readFileSync(path, "utf8").trim();
  } catch (err) {
    throw new Error(
      `sovereign-shield: required config file ${path} (${purpose}) is missing. ` +
        `Boot-config must write this file at provisioning. Err: ${(err as Error).message}`,
    );
  }
  if (value.length === 0) {
    throw new Error(
      `sovereign-shield: required config file ${path} (${purpose}) is empty.`,
    );
  }
  return value;
}

// WebAuthn RP ID — the registrable root of the VPS's primary domain.
// Written by boot-config at provisioning. MUST exist; no silent fallback — a missing
// file indicates a provisioning bug and would cause passkeys to bind to the wrong origin.
//
// Example values:
//   - {shortId}-srv.ellul.ai → RP ID = "ellul.ai"
//   - acme.com               → RP ID = "acme.com"
//
// Migration note: existing VPSes provisioned before this change must be backfilled
// with a one-off command that writes /etc/ellul/rp-id derived from their current domain,
// BEFORE this shield version is deployed to them.
export const SHARED_RP_ID = readRequiredFile(
  "/etc/ellul/rp-id",
  "WebAuthn RP ID",
);

// Origin of the console/dashboard that embeds the shield bridge iframe.
// Written by boot-config. MUST exist; a missing value would break the bridge postMessage contract.
export const CONSOLE_ORIGIN = readRequiredFile(
  "/etc/ellul/console-origin",
  "console origin",
);

// Registrable root zone for platform (internal) hostnames.
// Written by boot-config. Examples: "ellul.ai".
export const PLATFORM_ZONE = readRequiredFile(
  "/etc/ellul/platform-zone",
  "platform zone",
);

// Registrable root zone for app (dev preview / deployed app) hostnames.
// Written by boot-config. Examples: "ellul.app".
export const APP_ZONE = readRequiredFile(
  "/etc/ellul/app-zone",
  "app zone",
);

// Allowed origins for WebAuthn ceremonies on this VPS.
//
// Storage model (two files, no mutations to either after initial write):
//   /etc/ellul/allowed-origins   — platform defaults (primary host, -dc variant,
//                                    console). Written ONCE by boot-config.
//   /etc/ellul/custom-domain     — customer custom domain (single hostname).
//                                    Written by the reconfigure-caddy-domain
//                                    enforcer handler when the user adds/removes
//                                    a custom domain.
//
// readAllowedOrigins() merges the two sources at request time. No append/grep
// text mutations → no marker drift, no partial writes, fully atomic.
export function readAllowedOrigins(): string[] {
  const raw = readRequiredFile(
    "/etc/ellul/allowed-origins",
    "WebAuthn allowed origins",
  );
  const origins = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (origins.length === 0) {
    throw new Error(
      "sovereign-shield: /etc/ellul/allowed-origins contains no origins",
    );
  }

  // Merge the optional custom domain, if one is bound to this VPS.
  const customDomain = readCustomDomain();
  if (customDomain) origins.push(`https://${customDomain}`);

  // Merge the dev-preview domain (*-dev.ellul.app). Browsers making cross-origin
  // calls from the console iframe to the dev preview URL send that Origin;
  // origin-allowlist middleware uses this list to validate. The file is
  // written by boot-config at provisioning — required, no silent fallback.
  origins.push(`https://${readDevDomain()}`);

  return origins;
}

/**
 * Read the optional custom domain bound to this VPS. Returns null if none.
 * Result is NOT cached — the file is small (one line) and re-reads are cheap,
 * and callers need to see updates written by the reconfigure-caddy-domain
 * command handler without restarting shield.
 */
export function readCustomDomain(): string | null {
  try {
    const v = fs.readFileSync("/etc/ellul/custom-domain", "utf8").trim();
    return v || null;
  } catch {
    return null;
  }
}

/**
 * Read the dev-preview domain ({shortId}-dev.ellul.app) bound to this VPS.
 * Written by boot-config at provisioning — always present. Throws if missing
 * or empty; that is a provisioning bug, not a runtime condition.
 */
export function readDevDomain(): string {
  return readRequiredFile("/etc/ellul/dev-domain", "dev-preview domain");
}

/**
 * Preview origins manifest — source of truth for domains/patterns the
 * origin-allowlist middleware accepts on cross-origin authenticated requests
 * to preview URLs.
 *
 * Storage model:
 *   /etc/ellul/preview-origins.json — written by boot-config at provisioning.
 *   Shape: { "origins": ["https://host.example", …],
 *            "patterns": ["*.ellul.app", …] }
 *
 * The file is required. Missing or malformed file throws — that's a
 * provisioning bug, not a runtime condition to tolerate. Not cached: file
 * is small and callers need to see updates from reconfigure-caddy-domain
 * without a shield restart.
 */
export interface PreviewOriginsManifest {
  origins: string[];
  patterns: string[];
}

export function readPreviewOriginsManifest(): PreviewOriginsManifest {
  const raw = readRequiredFile(
    "/etc/ellul/preview-origins.json",
    "preview origins manifest",
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `sovereign-shield: /etc/ellul/preview-origins.json is not valid JSON: ${(err as Error).message}`,
    );
  }
  const origins = Array.isArray((parsed as { origins?: unknown[] })?.origins)
    ? ((parsed as { origins: unknown[] }).origins.filter(
        (v): v is string => typeof v === "string" && v.length > 0,
      ) as string[])
    : [];
  const patterns = Array.isArray((parsed as { patterns?: unknown[] })?.patterns)
    ? ((parsed as { patterns: unknown[] }).patterns.filter(
        (v): v is string => typeof v === "string" && v.length > 0,
      ) as string[])
    : [];
  return { origins, patterns };
}

/**
 * Resolve the WebAuthn RP ID for a given origin hostname.
 *
 *   acme.com              → acme.com (exact custom-domain match)
 *   {shortId}-srv.ellul.ai → ellul.ai (SHARED_RP_ID, a registrable suffix)
 *   console.ellul.ai      → ellul.ai (same)
 *
 * RP ID MUST be either the full origin hostname or a registrable suffix of it,
 * per WebAuthn spec. Returning the wrong value causes the browser to reject
 * the ceremony with `SecurityError`. This helper is the single source of truth;
 * every login / registration / PoP bind route calls it with the incoming Host.
 */
export function resolveRpId(originHost: string): string {
  const host = originHost.toLowerCase().trim();
  if (!host) return SHARED_RP_ID;

  // Custom domain: exact match. The customer owns the whole eTLD+1; RP ID
  // is the hostname itself (or its registrable root if they used a subdomain,
  // but we register the custom hostname verbatim so the exact form is correct).
  const customDomain = readCustomDomain();
  if (customDomain && host === customDomain.toLowerCase()) {
    return customDomain;
  }

  // Platform: SHARED_RP_ID is a registrable suffix of any {*}.ellul.ai host.
  // Validate: require the request host to actually end with that suffix.
  if (host === SHARED_RP_ID || host.endsWith(`.${SHARED_RP_ID}`)) {
    return SHARED_RP_ID;
  }

  // Unknown origin — fall back to SHARED_RP_ID. The ceremony will fail in the
  // browser if the suffix doesn't match, surfacing the config mismatch loudly.
  // (Alternative would be to throw here, but that would break legitimate edge
  // cases like IP-literal access during debugging.)
  return SHARED_RP_ID;
}

// Session security constants
export const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours idle timeout
export const ABSOLUTE_MAX_MS = 24 * 60 * 60 * 1000; // 24 hours absolute expiry
export const ROTATION_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes session rotation
export const STEP_UP_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes for step-up auth
export const CHALLENGE_TTL_MS = 60 * 1000; // 60 second challenge expiry

// Rate limiting
export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const RATE_LIMIT_MAX_ATTEMPTS = 5;
export const LOCKOUT_DURATION_MS = 60 * 60 * 1000;

// Gate constants
export const GATE_PENDING_TTL_MS = 5 * 60 * 1000; // 5 min pending request expiry
export const GATE_GRANT_TIMED_DEFAULT_MS = 5 * 60 * 1000; // 5 min default timed grant
export const GATE_GRANT_SESSION_MS = 4 * 60 * 60 * 1000; // 4 hour session grant
export const GATE_GRANT_ALWAYS_MS = 24 * 60 * 60 * 1000; // 24 hour "always" grant
export const GATE_STATE_FILE = `${SHIELD_DATA_DIR}/gate-state.json`;

// Wallet (feature-flagged — entire subsystem disabled unless WALLET_FEATURE_FILE exists)
export const WALLET_FEATURE_FILE = "/etc/ellul/features/wallet";
export const WALLET_KEYPAIR_FILE = `${SHIELD_DATA_DIR}/wallet-keypair.json`;
export const WALLET_STATE_FILE = `${SHIELD_DATA_DIR}/wallet-state.json`;
export const WALLET_SPEND_DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 min
export const WALLET_MAX_LAMPORTS_PER_GRANT = 10_000_000_000; // 10 SOL hard cap

// HD Wallet — Quantum-Blind Transaction Enforcement (QBTE)
export const WALLET_SEED_FILE = `${SHIELD_DATA_DIR}/wallet-seed.json`;
export const WALLET_HD_STATE_FILE = `${SHIELD_DATA_DIR}/wallet-hd-state.json`;
export const SOLANA_BIP44_PATH_PREFIX = "m/44'/501'";
export const SOLANA_RENT_EXEMPT_MINIMUM = 890_880; // Minimum lamports for system account
export const SOLANA_ESTIMATED_FEE_PER_INSTRUCTION = 5_000; // Conservative per-instruction fee
export const WALLET_MAX_DERIVATION_INDEX = 2_147_483_647; // 2^31 - 1 (hardened range)

// Exec constants
export const EXEC_MAX_SYNC_SIZE = 50 * 1024 * 1024; // full-sync upload limit
export const EXEC_DEV_PORT_BASE = 3100; // dev server port range start
export const EXEC_DEV_PORT_RANGE = 900; // dev server port range size

// PoP (Proof of Possession) constants
export const POP_TIMESTAMP_TOLERANCE_MS = 30 * 1000; // 30 seconds clock drift tolerance
export const SERVER_STARTUP_TIME = Date.now(); // Track server startup for replay attack prevention

// CLI Device Trust constants
export const DEVICE_TRUST_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days device trust window
export const DEVICE_CHALLENGE_TTL_MS = 30 * 1000; // 30 seconds challenge expiry
export const DEVICE_MAX_PER_CREDENTIAL = 10; // max registered devices per credential
// 60s tolerance (not 30s) — developer machines (WSL2, VMs waking from sleep) drift 30-45s easily.
// Zero replay risk: the 32-byte challenge is atomically consumed, so timestamp is a freshness check only.
export const DEVICE_AUTH_TIMESTAMP_TOLERANCE_MS = 60 * 1000;

// Operator signature timestamp tolerance (gate control operations)
export const OPERATOR_TIMESTAMP_TOLERANCE_MS = 30 * 1000; // 30s freshness

// TPM attestation (feature-flagged)
export const TPM_FEATURE_FILE = "/etc/ellul/features/tpm";
export const TPM_CERT_DIR = "/etc/ellul/tpm";

// Sensitive actions requiring step-up auth
export const SENSITIVE_ACTIONS = [
  "/_auth/delete-credential",
  "/_auth/add-credential",
  "/_auth/bridge/switch-tier",
  "/_auth/bridge/downgrade-to-standard",
  "/_auth/bridge/upgrade-to-web-locked",
  "/_auth/recovery/regenerate",
  "/_auth/confirm-operation",
  "/_auth/device/", // device revocation requires step-up
] as const;

// Known trusted authenticator AAGUIDs (hardware-backed or reputable password managers)
export const TRUSTED_AAGUIDS: Record<string, string> = {
  // Apple
  "fbfc3007-154e-4ecc-8c0b-6e020557d7bd": "Apple Passwords",
  "dd4ec289-e01d-41c9-bb89-70fa845d4bf2": "iCloud Keychain (Managed)",
  "00000000-0000-0000-0000-000000000000": "Apple Platform Authenticator",
  // Google
  "adce0002-35bc-c60a-648b-0b25f1f05503": "Chrome on Mac",
  "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4": "Google Password Manager",
  // YubiKey (FW 5.1)
  "cb69481e-8ff7-4039-93ec-0a2729a154a8": "YubiKey 5 Series",
  "fa2b99dc-9e39-4257-8f92-4a30d23c4118": "YubiKey 5 NFC",
  // YubiKey (FW 5.2+)
  "ee882879-721c-4913-9775-3dfcce97072a": "YubiKey 5 Series",
  "2fc0579f-8113-47ea-b116-bb5a8db9202a": "YubiKey 5 NFC",
  "c5ef55ff-ad9a-4b9f-b580-adebafe026d0": "YubiKey 5Ci",
  // YubiKey FIPS
  "73bb0cd4-e502-49b8-9c6f-b59445bf720b": "YubiKey 5 FIPS Series",
  "c1f9a0bc-1dd2-404a-b27f-8e29047a43fd": "YubiKey 5 NFC FIPS",
  "85203421-48f9-4355-9bc8-8a53846e5083": "YubiKey 5Ci FIPS",
  // Password Managers
  "bada5566-a7aa-401f-bd96-45619a55120d": "1Password",
  "d548826e-79b4-db40-a3d8-11116f7e8349": "Bitwarden",
  "531126d6-e717-415c-9320-3d9aa6981239": "Dashlane",
  "b84e4048-15dc-4dd0-8640-f4f60813c8af": "NordPass",
  "0ea242b4-43c4-4a1b-8b17-dd6d0b6baec6": "Keeper",
  // Windows Hello
  "9ddd1817-af5a-4672-a2b9-3e3dd95000a9": "Windows Hello",
  "6028b017-b1d4-4c02-b4b3-afcdafc96bb2": "Windows Hello",
  "08987058-cadc-4b81-b6e1-30de50dcbe96": "Windows Hello",
};

// Headers used for stable device fingerprinting (low-entropy, always sent)
export const STABLE_FINGERPRINT_HEADERS = [
  "user-agent",
  "sec-ch-ua", // Always sent (low-entropy)
  "sec-ch-ua-mobile", // Always sent (low-entropy)
  "sec-ch-ua-platform", // Always sent (low-entropy)
] as const;

// Security tiers
export type SecurityTier = "standard" | "web_locked" | "private_locked";

// Hono context variable type declarations
// These are set by middleware and read by route handlers via c.get()/c.set()
declare module "hono" {
  interface ContextVariableMap {
    product: import("./middleware/product-gate.middleware").Product;
    billingTier: import("./middleware/product-gate.middleware").BillingTier;
    tierGateAuth: {
      tier: "web_locked" | "private_locked" | "standard";
      sessionId?: string;
      credentialId?: string;
      userId?: string;
      jwtId?: string;
    };
    popVerified: boolean;
    /** STS-verified project slug. Set by tier-gate middleware when X-STS-Token header is present. */
    stsProject: string | undefined;
    /** Cryptographically verified service identity from per-service IPC token. Set by internal-auth middleware. */
    verifiedService: string;
  }
}
