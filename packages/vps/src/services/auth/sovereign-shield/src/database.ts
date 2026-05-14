// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Sovereign Shield Database
 *
 * SQLite initialization and schema creation.
 */

import Database from "better-sqlite3";
import fs from "fs";
import { DB_PATH } from "./config";
import { setDatabase as setAuditDb } from "./application/audit/Audit";
import { setDatabase as setRateLimiterDb } from "./application/platform/RateLimiter";
import { setDatabase as setTierDb } from "./application/gates/Tier";
import { setDatabase as setSessionPolicyDb } from "./application/platform/SessionPolicy";
import { setPermissionDb } from "./application/gates/Permission";

// Initialize SQLite with WAL mode for better concurrency
export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
// Enforce foreign key integrity — required for ON DELETE CASCADE on the
// sandbox-scoped security tables (env_exposures, env_classifications,
// cross_project_access). Without this pragma SQLite parses FK clauses but
// does not enforce them, silently leaving orphan rows on sandbox deletion.
db.pragma("foreign_keys = ON");

// Lock down DB file permissions — Node.js default umask (0o022) creates as 644,
// but local-auth.db contains passkey credentials and session tokens.
try { fs.chmodSync(DB_PATH, 0o600); } catch {}
try { fs.chmodSync(DB_PATH + '-wal', 0o600); } catch {}
try { fs.chmodSync(DB_PATH + '-shm', 0o600); } catch {}

// Inject database into services
setAuditDb(db);
setRateLimiterDb(db);
setTierDb(db);
setSessionPolicyDb(db);
setPermissionDb(db);

// Create core tables
db.exec(`
  CREATE TABLE IF NOT EXISTS credential (
    id TEXT PRIMARY KEY,
    credentialId TEXT NOT NULL UNIQUE,
    publicKey TEXT NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0,
    transports TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    aaguid TEXT,
    device_type TEXT,
    backed_up INTEGER DEFAULT 0,
    attestation_fmt TEXT,
    name TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    credential_id TEXT NOT NULL,
    ip TEXT NOT NULL,
    fingerprint TEXT,
    fingerprint_status TEXT DEFAULT 'pending',
    fingerprint_components TEXT,
    fingerprint_bound_at INTEGER,
    country_code TEXT,
    created_at INTEGER NOT NULL,
    last_activity INTEGER NOT NULL,
    last_rotation INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    absolute_expiry INTEGER NOT NULL,
    pop_bound_at INTEGER,
    pop_sw_active INTEGER DEFAULT 0,
    pop_hmac_key TEXT,
    pop_prf_bound INTEGER DEFAULT 0,
    intent_public_key TEXT,
    intent_slhdsa_public_key TEXT,
    operator_public_key TEXT,
    operator_bind_nonce TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_credential ON sessions(credential_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_fingerprint_status ON sessions(fingerprint_status);

  CREATE TABLE IF NOT EXISTS intent_nonces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    nonce TEXT NOT NULL UNIQUE,
    action TEXT NOT NULL,
    resource TEXT,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_intent_nonces_expires ON intent_nonces(expires_at);

  CREATE TABLE IF NOT EXISTS used_signing_addresses (
    address TEXT PRIMARY KEY,
    derivation_index INTEGER NOT NULL,
    first_signed_at INTEGER NOT NULL,
    tx_id TEXT NOT NULL,
    swept_to TEXT,
    drain_verified INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_used_addr_index ON used_signing_addresses(derivation_index);

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    event TEXT NOT NULL,
    ip TEXT,
    fingerprint TEXT,
    credential_id TEXT,
    session_id TEXT,
    -- First-class sandbox scope for security events. NULL for server-wide
    -- events (auth ceremonies, session rotations). Populated by the typed
    -- security-audit writer; freeform logAuditEvent callers may also set
    -- it explicitly. CHECK constraint enforces the canonical slug shape.
    sandbox_id TEXT CHECK (sandbox_id IS NULL OR sandbox_id GLOB 'sbx-[a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9]'),
    details TEXT,
    prev_hash TEXT,
    hash TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
  CREATE INDEX IF NOT EXISTS idx_audit_sandbox ON audit_log(sandbox_id) WHERE sandbox_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS auth_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    success INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_attempts_ip_time ON auth_attempts(ip, timestamp);

  -- Recovery codes table
  CREATE TABLE IF NOT EXISTS recovery_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    used INTEGER DEFAULT 0,
    used_at INTEGER,
    used_ip TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS recovery_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    success INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_recovery_attempts_ip ON recovery_attempts(ip, timestamp);

  CREATE TABLE IF NOT EXISTS recovery_sessions (
    token TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ip TEXT NOT NULL,
    fingerprint TEXT,
    used INTEGER DEFAULT 0
  );

  -- PoP nonces table for replay attack prevention (persisted across restarts)
  CREATE TABLE IF NOT EXISTS pop_nonces (
    nonce_key TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pop_nonces_expires ON pop_nonces(expires_at);

  -- Confirmation nonces graveyard — ensures single-use confirmation tokens
  -- survive service restarts (previously in-memory Map, now persisted)
  CREATE TABLE IF NOT EXISTS confirmation_nonces (
    nonce TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_confirmation_nonces_expires ON confirmation_nonces(expires_at);

  -- Terminal sessions (persisted so they survive service restarts)
  CREATE TABLE IF NOT EXISTS term_sessions (
    id TEXT PRIMARY KEY,
    ip TEXT NOT NULL,
    shield_session_id TEXT NOT NULL,
    tier TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_term_sessions_expires ON term_sessions(expires_at);

  -- Preview tokens (short-lived, single-use, for cross-site dev preview auth)
  CREATE TABLE IF NOT EXISTS preview_tokens (
    token TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_preview_tokens_expires ON preview_tokens(expires_at);

  -- Preview sessions (longer-lived, set as __Host-preview_session cookie on ellul.app)
  CREATE TABLE IF NOT EXISTS preview_sessions (
    id TEXT PRIMARY KEY,
    ip TEXT NOT NULL,
    shield_session_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_preview_sessions_expires ON preview_sessions(expires_at);
`);

// Session policy — per-tier TTL overrides (configurable session windows)
db.exec(`
  CREATE TABLE IF NOT EXISTS session_policy (
    billing_tier TEXT PRIMARY KEY,
    session_ttl_ms INTEGER NOT NULL,
    absolute_max_ms INTEGER NOT NULL,
    idle_timeout_ms INTEGER NOT NULL DEFAULT ${15 * 60 * 1000},
    max_concurrent_sessions INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
  );

  -- Seed defaults if empty (idempotent — INSERT OR IGNORE)
  INSERT OR IGNORE INTO session_policy (billing_tier, session_ttl_ms, absolute_max_ms, idle_timeout_ms, max_concurrent_sessions, updated_at)
  VALUES
    ('free',       ${4 * 60 * 60 * 1000},  ${24 * 60 * 60 * 1000}, ${15 * 60 * 1000}, 1, ${Date.now()}),
    ('paid',       ${12 * 60 * 60 * 1000}, ${24 * 60 * 60 * 1000}, ${60 * 60 * 1000}, 3, ${Date.now()});
`);

// ════════════════════════════════════════════════════════════════════════════
// Canonical security scope — `sandboxes` table
// ════════════════════════════════════════════════════════════════════════════
//
// Every sandbox that ever exists on this VPS gets a row here. The table is
// the FK parent for all sandbox-scoped security tables (env_exposures,
// env_classifications, cross_project_access). Deleting a sandbox row
// CASCADEs through every security surface in one transaction — no orphan
// secrets, no stale gate grants, no dangling cross-project rules.
//
// The slug shape is enforced by CHECK constraint so malformed ids cannot
// enter the DB even if a caller bypasses the shared scope module.
db.exec(`
  CREATE TABLE IF NOT EXISTS sandboxes (
    id         TEXT PRIMARY KEY CHECK (id GLOB 'sbx-[a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9]'),
    created_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_sandboxes_deleted ON sandboxes(deleted_at)
    WHERE deleted_at IS NOT NULL;
`);

// ════════════════════════════════════════════════════════════════════════════
// Sandbox-scoped security tables
// ════════════════════════════════════════════════════════════════════════════
//
// Every scope column is:
//   * CHECK-constrained to the canonical slug pattern (defense in depth —
//     catches malformed ids even if the service layer is bypassed).
//   * REFERENCES sandboxes(id) ON DELETE CASCADE (single-transaction reap
//     on sandbox deletion; no orphan rows).
//
// Greenfield: `app_name` columns have been renamed to `sandbox_id`. No
// data migration — nothing is live.
db.exec(`
  -- Track which secrets the agent has seen through env gate.
  -- Scope column is the sandbox slug; CHECK enforces shape and the FK
  -- cascades when the parent sandbox row is deleted.
  CREATE TABLE IF NOT EXISTS env_exposures (
    sandbox_id  TEXT NOT NULL CHECK (sandbox_id GLOB 'sbx-[a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9]')
                REFERENCES sandboxes(id) ON DELETE CASCADE,
    key_name    TEXT NOT NULL,
    value_hash  TEXT NOT NULL,
    exposed_at  INTEGER NOT NULL,
    thread_id   TEXT NOT NULL,
    acknowledged_at INTEGER,
    PRIMARY KEY (sandbox_id, key_name)
  );

  -- Per-variable classification (secret/plain). Same sandbox-scoping and
  -- CASCADE as env_exposures.
  CREATE TABLE IF NOT EXISTS env_classifications (
    sandbox_id  TEXT NOT NULL CHECK (sandbox_id GLOB 'sbx-[a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9]')
                REFERENCES sandboxes(id) ON DELETE CASCADE,
    key_name    TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'secret',
    PRIMARY KEY (sandbox_id, key_name)
  );

  -- Cross-project read access rules — which sandbox can read which.
  -- Enforcement lives in the namespace-script mount layer (see the
  -- .shared/NAME rsync snapshots); this table is the source of truth.
  CREATE TABLE IF NOT EXISTS cross_project_access (
    sandbox_id         TEXT NOT NULL CHECK (sandbox_id GLOB 'sbx-[a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9]')
                       REFERENCES sandboxes(id) ON DELETE CASCADE,
    shared_sandbox_id  TEXT NOT NULL CHECK (shared_sandbox_id GLOB 'sbx-[a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9]')
                       REFERENCES sandboxes(id) ON DELETE CASCADE,
    granted_at         INTEGER NOT NULL,
    share_preview      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (sandbox_id, shared_sandbox_id),
    CHECK (sandbox_id != shared_sandbox_id)
  );
`);

// Phase 6: CLI Device Trust — trusted CLI instances registered during passkey ceremony
db.exec(`
  CREATE TABLE IF NOT EXISTS cli_devices (
    id              TEXT PRIMARY KEY,
    credential_id   TEXT NOT NULL,
    pop_hmac_key    TEXT UNIQUE,
    device_name     TEXT NOT NULL,
    registered_at   INTEGER NOT NULL,
    last_used_at    INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL,
    revoked_at      INTEGER,
    ip_registered   TEXT NOT NULL,
    ip_last_used    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_cli_devices_credential ON cli_devices(credential_id);
  CREATE INDEX IF NOT EXISTS idx_cli_devices_hmac_key ON cli_devices(pop_hmac_key);
`);

// ════════════════════════════════════════════════════════════════════════════
// Permission Requests — Enterprise-grade HITL (Human-in-the-Loop) authz
// ════════════════════════════════════════════════════════════════════════════
//
// Server-authoritative permission lifecycle. Every gate prompt that reaches a
// human is a row here. Agent-bridge creates the row; the grant/deny endpoints
// validate status transitions; the inbox + SSE endpoints read it. The table
// is the single source of truth for "what permission is pending, granted, or
// denied" — any other store (in-memory maps, JSON files) is a cache of this.
//
// Status transitions (enforced in service layer):
//   pending → granted | denied | revoked | expired | superseded
//   granted → revoked | expired
//
// `request_hash` is a deterministic digest over (gate, thread_id, sandbox_id,
// args_hash) used for idempotent create — if an agent re-issues the same
// request while one is still pending, we return the existing id instead of
// creating a duplicate.
db.exec(`
  CREATE TABLE IF NOT EXISTS permission_requests (
    id              TEXT PRIMARY KEY,
    gate            TEXT NOT NULL,
    thread_id       TEXT NOT NULL,
    sandbox_id      TEXT CHECK (sandbox_id IS NULL OR sandbox_id GLOB 'sbx-[a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9]')
                    REFERENCES sandboxes(id) ON DELETE CASCADE,
    requested_by    TEXT NOT NULL,
    scope_json      TEXT,
    reason          TEXT,
    request_hash    TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','granted','denied','revoked','expired','superseded')),
    resolution_json TEXT,
    credential_id   TEXT,
    session_id      TEXT,
    created_at      INTEGER NOT NULL,
    last_seen_at    INTEGER,
    resolved_at     INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_permreq_status_thread  ON permission_requests(status, thread_id);
  CREATE INDEX IF NOT EXISTS idx_permreq_status_sandbox ON permission_requests(status, sandbox_id);
  CREATE INDEX IF NOT EXISTS idx_permreq_created        ON permission_requests(created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_permreq_pending_hash
    ON permission_requests(request_hash) WHERE status = 'pending';
`);


// ════════════════════════════════════════════════════════════════════════════
// Per-device PoP bindings
// ════════════════════════════════════════════════════════════════════════════
//
// `sessions.pop_hmac_key` stores a single key per session, so a user on a
// second browser or after IDB eviction on the same browser hits a permanent
// "bound but local key missing" state. The hardening in commit f08f0a50
// removed the force-rebind escape hatch from that state (correctly — a cookie
// must not be able to override device binding), which meant those users were
// forced into full passkey re-auth on every nudge.
//
// `device_bindings` makes PoP multi-device-native: each (session_id, device_id)
// pair owns its own HMAC key. Multiple browsers/tabs can bind additively
// under the same session without displacing each other. Loss of local state
// on one device no longer invalidates the others.
//
// `wrapped_hmac` + `prf_salt` back the PRF-based recovery flow. At bind time
// the client performs a WebAuthn get() with the prf extension, derives a
// key-wrapping key from the PRF output + salt, encrypts the HMAC key, and
// ships `wrapped_hmac` here. On IDB loss, the client presents the passkey
// again (one biometric tap), receives `wrapped_hmac` + `prf_salt`, derives
// the same KEK, and restores the HMAC key. Security level is identical to
// the initial bind — possession of the passkey is proven via WebAuthn
// assertion; the PRF output never touches the server.
//
// `sessions.pop_hmac_key` remains populated with the most-recently-bound
// device's key so existing verification paths (confirm, workflow, token)
// keep working unchanged. New paths that want per-device resolution SHOULD
// query device_bindings by (session_id, device_id).
db.exec(`
  CREATE TABLE IF NOT EXISTS device_bindings (
    session_id          TEXT NOT NULL,
    device_id           TEXT NOT NULL,
    pop_hmac_key        TEXT NOT NULL,
    wrapped_hmac        TEXT,
    prf_salt            TEXT,
    attestation_aaguid  TEXT,
    credential_id       TEXT,
    created_at          INTEGER NOT NULL,
    last_seen_at        INTEGER NOT NULL,
    PRIMARY KEY (session_id, device_id)
  );
  CREATE INDEX IF NOT EXISTS idx_device_bindings_session ON device_bindings(session_id);
  CREATE INDEX IF NOT EXISTS idx_device_bindings_hmac    ON device_bindings(pop_hmac_key);
`);

// One-time migration: copy any pre-existing sessions.pop_hmac_key values into
// device_bindings under the synthetic device_id 'legacy-v1'. These rows act
// as compatibility shims — the next successful bind on each device writes a
// real (session_id, device_id) row and the legacy row is left in place until
// the session expires. Idempotent: INSERT OR IGNORE guards against re-run.
db.exec(`
  INSERT OR IGNORE INTO device_bindings
    (session_id, device_id, pop_hmac_key, created_at, last_seen_at)
  SELECT id, 'legacy-v1', pop_hmac_key,
         COALESCE(pop_bound_at, created_at),
         COALESCE(last_activity, created_at)
  FROM sessions
  WHERE pop_hmac_key IS NOT NULL;
`);
