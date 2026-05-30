// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Shared constants for VPS services.

import * as fs from 'fs';

// Derive service user from /etc/default/ellul (set during provisioning)
function getServiceUser(): string {
  try {
    const content = fs.readFileSync('/etc/default/ellul', 'utf8');
    const match = content.match(/PS_USER=(\w+)/);
    if (match?.[1]) return match[1];
  } catch {}
  return 'dev';
}

export const SVC_USER = getServiceUser();
export const SVC_HOME = `/home/${SVC_USER}`;

// File paths
export const TIER_FILE = '/etc/ellul/security-tier';
export const SERVER_ID_FILE = '/etc/ellul-bootstrap/server-id';
export const API_URL_FILE = '/etc/ellul/api-url';
export const DOMAIN_FILE = '/etc/ellul/domain';
export const OWNER_LOCK_FILE = '/etc/ellul/owner.lock';
export const JWT_SECRET_FILE = '/etc/ellul/jwt-secret';
export const SHIELD_MARKER = '/etc/ellul/.sovereign-shield-active';
export const SSH_AUTH_KEYS_PATH = `${SVC_HOME}/.ssh/authorized_keys`;

// Mutable data lives in shield-data/ (owned by $SVC_USER, isolated from root config)
export const SHIELD_DATA_DIR = '/etc/ellul/shield-data';
export const DB_PATH = `${SHIELD_DATA_DIR}/local-auth.db`;
export const AUTH_SECRET_FILE = `${SHIELD_DATA_DIR}/.sovereign-auth-secret`;
export const AUTH_SECRETS_FILE = `${SHIELD_DATA_DIR}/auth-secrets.json`;
export const SETUP_TOKEN_FILE = `${SHIELD_DATA_DIR}/.sovereign-setup-token`;
export const SETUP_EXPIRY_FILE = `${SHIELD_DATA_DIR}/.sovereign-setup-expiry`;

// ── Agent manifest bootstrap state ──────────────────────────────────
export const AGENT_BOOTSTRAP_VERSION = '0.0.0';
export const AGENT_BOOTSTRAP_MANIFEST_VERSION = 0;
export const AGENT_BOOTSTRAP_AUTO_UPDATE = true;

export const AGENT_INSTALLED_FILE = `${SHIELD_DATA_DIR}/.agent-versions.json`;
export const AGENT_MANIFEST_VERSION_FILE = `${SHIELD_DATA_DIR}/.agent-manifest-version`;
export const AGENT_AUTO_UPDATE_FILE = `${SHIELD_DATA_DIR}/.agent-auto-update`;
export const AGENT_PENDING_COMMIT_FILE = `${SHIELD_DATA_DIR}/.agent-pending-commit.json`;
export const AGENT_PENDING_MANIFEST_FILE = `${SHIELD_DATA_DIR}/.agent-pending-manifest.json`;

// Seed for .agent-versions.json: only ellul-env at sentinel; other components discovered on first manifest apply.
export const AGENT_BOOTSTRAP_INSTALLED_JSON = JSON.stringify({
  'ellul-env': AGENT_BOOTSTRAP_VERSION,
});
export const TERMINAL_DISABLED_FILE = `${SHIELD_DATA_DIR}/.terminal-disabled`;

// Deployment models (VPS-internal: binary distinction)
// The API uses a three-value enum ("cloudflare" | "gateway" | "direct") for DNS routing.
// On the VPS, "cloudflare" and "gateway" produce identical Caddy configs, so we collapse
// them to "proxied" at the VPS boundary. metadata.json stores the API value; VPS normalizes on read.
export type VpsDeploymentModel = 'proxied' | 'direct' | 'localhost';

/** Normalize API deployment model to VPS binary model. */
export function normalizeDeploymentModel(apiModel: string): VpsDeploymentModel {
  if (apiModel === 'direct') return 'direct';
  if (apiModel === 'localhost') return 'localhost';
  return 'proxied';
}

// Security tiers — progressive: standard → web_locked → private_locked
export const TIERS = {
  STANDARD: 'standard',
  WEB_LOCKED: 'web_locked',
  PRIVATE_LOCKED: 'private_locked',
} as const;

export type SecurityTier = typeof TIERS[keyof typeof TIERS];

// web_locked + private_locked both require passkey auth.
export function isLockedTier(tier: string | null | undefined): boolean {
  return tier === TIERS.WEB_LOCKED || tier === TIERS.PRIVATE_LOCKED;
}

export function isPrivateLocked(tier: string | null | undefined): boolean {
  return tier === TIERS.PRIVATE_LOCKED;
}

// Per-project preview port range (each project gets a dedicated port)
export const PREVIEW_PORT_MIN = 4000;
export const PREVIEW_PORT_MAX = 4099;

// Session/Token TTLs
export const SESSION_TTL_MS = 4 * 60 * 60 * 1000;        // 4 hours idle timeout
export const ABSOLUTE_MAX_MS = 24 * 60 * 60 * 1000;      // 24 hours absolute expiry
export const ROTATION_INTERVAL_MS = 15 * 60 * 1000;      // 15 minutes session rotation
export const STEP_UP_THRESHOLD_MS = 5 * 60 * 1000;       // 5 minutes step-up
export const TERMINAL_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours for terminal tokens
export const CODE_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;    // 24 hours for code tokens
export const AGENT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;   // 24 hours for agent tokens

// Ports reserved for ellul internal services — never assign to user apps
export const RESERVED_PORTS = new Set([
  22, 80, 443, 2019, 3000, 3002, 3003, 3005,
  7681, 7682, 7683, 7684, 7685, 7686, 7687, 7688, 7689, 7690, 7700, 7701,
  // Preview port range (4000-4099) — reserved for per-project preview ports
  ...Array.from({ length: PREVIEW_PORT_MAX - PREVIEW_PORT_MIN + 1 }, (_, i) => PREVIEW_PORT_MIN + i),
]);

// Preview resource limits: admission caps, idle eviction, reconciler recovery.
export const PREVIEW_LIMITS = {
  // Default cap; resolvePreviewMaxConcurrent derives from RAM via memory-budget.
  MAX_CONCURRENT: 2,
  IDLE_EVICT_AFTER_MS: 15 * 60 * 1000,
  RECONCILE_INTERVAL_MS: 10 * 1000,
  DELETE_STOP_TIMEOUT_MS: 20 * 1000,
  DELETE_RETRY_ATTEMPTS: 4,
  DELETE_RETRY_BASE_BACKOFF_MS: 250,
  // Loadavg backpressure: reject starts when 1-min > nCPU × this.
  LOAD_MULTIPLIER: 1.5,
  // Soft threshold: evict LRU when MemAvailable below N% of physical.
  PRESSURE_EVICT_THRESHOLD_PERCENT: 15,
  PRESSURE_CRITICAL_FLOOR_MB: 128,
  // Android-only hard floor: below this % MemAvailable the reconciler may evict
  // EVEN the actively-viewed preview, skipping the 2-tick confirm + full
  // startup grace. Android has no cgroup memory caps, so one ballooning
  // dev-server can thrash the device until the kernel OOM-kills the WebView
  // renderer (whole-app crash). A re-startable preview is the better loss.
  PRESSURE_CRITICAL_PERCENT: 8,
  PRESSURE_CRITICAL_STARTUP_GRACE_MS: 20 * 1000,
  // 90s covers Next/Turbopack cold, JVM warmup, Maven/Gradle dep resolve, Rails.
  // Override via PREVIEW_PORT_BIND_TIMEOUT_MS env.
  PORT_BIND_TIMEOUT_MS: 90 * 1000,
  // Poll /proc/meminfo after eviction until victim's reclaim completes.
  DRAIN_TIMEOUT_MS: 5 * 1000,
  DRAIN_POLL_INTERVAL_MS: 100,
  // Absorbs meminfo vs cgroup-charge drift during drain.
  DRAIN_HEADROOM_MB: 96,
  PORT_BIND_POLL_INTERVAL_MS: 500,
  /** Per-unit health-result cache TTL. Avoids hammering systemctl/ss. */
  HEALTH_CACHE_TTL_MS: 2000,
  /** Max proc tree recursion depth for isDescendantOf. */
  ANCESTOR_DEPTH: 16,
  /** Background auto-repair cap per preview before surfacing to UI. */
  MAX_REPAIR_ATTEMPTS: 3,
} as const;

// Precedence: PREVIEW_MAX_CONCURRENT env → memory-budget derivation → PREVIEW_LIMITS default.
// Inline mirror of computeMemoryBudget to avoid circular import; coherence suite pins them.
export function resolvePreviewMaxConcurrent(
  defaultValue: number = PREVIEW_LIMITS.MAX_CONCURRENT,
  physicalMB?: number,
): number {
  const raw = process.env['PREVIEW_MAX_CONCURRENT'];
  if (raw) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (typeof physicalMB === 'number' && Number.isFinite(physicalMB) && physicalMB > 0) {
    const phys = Math.max(1, Math.floor(physicalMB));
    const slicePercent = phys <= 1024 ? 50 : phys <= 2048 ? 60 : 70;
    const budget = Math.max(64, Math.floor(phys * (slicePercent / 100)));
    const tier = phys <= 4400 ? 2 : phys <= 8400 ? 3 : phys <= 16384 ? 4 : 6;
    const ideal = Math.floor(budget / tier);
    const cap = Math.min(budget, 4096, Math.max(1280, ideal));
    return Math.max(1, Math.min(tier, Math.floor(budget / cap)));
  }
  return defaultValue;
}

export function resolvePreviewIdleEvictMs(
  defaultValue: number = PREVIEW_LIMITS.IDLE_EVICT_AFTER_MS,
): number {
  const raw = process.env['PREVIEW_IDLE_EVICT_MS'];
  if (!raw) return defaultValue;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : defaultValue;
}

export function resolvePortBindTimeoutMs(
  defaultValue: number = PREVIEW_LIMITS.PORT_BIND_TIMEOUT_MS,
): number {
  const raw = process.env['PREVIEW_PORT_BIND_TIMEOUT_MS'];
  if (!raw) return defaultValue;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : defaultValue;
}

// Rate limiting
export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;      // 15 minutes
export const RATE_LIMIT_MAX_ATTEMPTS = 5;
export const LOCKOUT_DURATION_MS = 60 * 60 * 1000;       // 1 hour lockout
