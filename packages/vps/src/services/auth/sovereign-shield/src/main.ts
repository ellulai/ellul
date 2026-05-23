// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Sovereign Shield - Main Entry Point
 *
 * WebAuthn/Passkey authentication service for ellul VPS.
 * Runs on port 3005 and provides:
 *
 * - Passkey registration and authentication
 * - Session management with PoP (Proof of Possession)
 * - Forward auth for Caddy reverse proxy
 * - Security tier management (standard, web_locked)
 * - SSH key management
 * - Break-glass recovery system
 * - Platform bridge API for dashboard integration
 */

import fs from 'fs';
import { Hono } from 'hono';
import { setVaultKey } from './auth/secrets';
import { serve } from '@hono/node-server';
import { PORT, RP_NAME, DOMAIN_FILE, API_URL_FILE, SVC_HOME, INTERNAL_TOKEN_PATH } from './config';
import { registerAllRoutes } from './routes';
import { cleanupPreviewData } from './routes/preview.routes';
import { cleanupExpiredSessions } from './auth/session';
import { cleanupExpiredNonces } from './auth/pop';
import { getCurrentTier, retryPendingTierNotification } from './application/gates/Tier';
import {
  decryptEnvelope,
  setGitCredentialEncrypted,
  deleteGitCredential,
  migrateGitSecretsFromEnvFile,
  type HybridKemEncryptedEnvelope,
} from './application/vault/Secrets';
import { syncSecretsFromApi } from './application/credentials/Git';
import { buildAppSuffix } from './application/credentials/GitCredentials';
import { initSettings } from './application/platform/Settings';
import { initGatePermissions } from './application/gates/GatePermissions';
import { restoreGateState } from './application/gates/Gate';
import { expireStale as expireStalePermissions } from './application/gates/Permission';
import { initPermissionMetrics } from './application/gates/PermissionMetrics';
import { initInternalToken } from './application/credentials/InternalToken';
import { SHIELD_DATA_DIR, SERVER_ID_FILE } from './config';
import {
  buildClaudeOatModule,
  buildClaudeOatPorts,
  HttpAnthropicProbeClient,
  ProbeLoop,
} from './credentials/claude-oat/public';
import type { ClaudeOatModule } from './credentials/claude-oat/public';
import { cleanupExpiredTempRoles, cleanupOrphanedTempRoles } from './application/database/Database';
import { sweepOrphanedProjects } from './application/process/ProjectGc';
import { initRuleStore } from './application/guardrails/GuardrailSync';
import { syncCrossProjectConfigOnStartup, reconcileSharedSnapshots, listAllCrossProjectAccess } from './application/organization/CrossProject';
import { isWalletEnabled } from './application/wallets/WalletFeature';
// Wallet imports are LAZY — @solana/web3.js is an external dependency that
// may not be installed. Top-level import would crash the entire shield service.
// Import database to ensure initialization and migrations run
import { db } from './database';
// Start credential reconciliation (safety net for VPS→API sync failures)
import './application/credentials/CredentialReconciliation';
import { initDebugLog, dbg } from './application/audit/DebugLog';

initDebugLog();

// On Android, the engine pipes the vault encryption key via stdin before
// closing the write end. Read synchronously before any route handler
// triggers loadAuthSecrets(). On VPS this is a no-op (stdin is /dev/null).
if (process.env.ELLUL_PLATFORM === 'android') {
  try {
    const key = fs.readFileSync(0, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(key)) {
      setVaultKey(key);
      console.log('[shield] Vault encryption key loaded from engine');
    }
  } catch {}
}

// Read domain from file or use default
let hostname = 'localhost';
try {
  const domainFromFile = fs.readFileSync(DOMAIN_FILE, 'utf8').trim();
  if (domainFromFile) {
    hostname = domainFromFile;
  }
} catch {
  console.log('[shield] No domain file found, using localhost');
}

const app = new Hono();

// ── Locked-But-Awake State (Patent Embodiment 6) ──
// When the encrypted volume is pending unlock (sovereign mode), shield starts
// with minimal functionality. Only unlock + health endpoints are active.
// The state is detected via runtime markers in /run/ (tmpfs, cleared on reboot).
const LUKS_PENDING_MARKER = '/run/ellul-luks-pending';
const LUKS_DECRYPTED_MARKER = '/run/ellul-decrypted';

let _lockedButAwake = fs.existsSync(LUKS_PENDING_MARKER) && !fs.existsSync(LUKS_DECRYPTED_MARKER);

export function isLockedButAwake(): boolean { return _lockedButAwake; }
export function clearLockedButAwake(): void {
  _lockedButAwake = false;
  console.log('[shield] Locked-but-awake state cleared — full service mode');
}

if (_lockedButAwake) {
  console.log('[shield] LOCKED-BUT-AWAKE: Volume encrypted, awaiting user PRF unlock');
  console.log('[shield] Only unlock and health endpoints are active (HTTP 423 for all others)');
}

// NOTE: No Hono CORS middleware here — Caddy handles all CORS headers for external
// requests. Adding CORS at both layers causes duplicate Access-Control-Allow-Origin
// headers, which browsers reject (breaking cookie-based auth flows).

// Build the Claude OAT credential module BEFORE route registration so the
// routes layer can capture a reference. Composition root for the bounded
// context: infrastructure adapters injected into application commands,
// exposed as a single typed surface. See
// src/credentials/claude-oat/{domain,application,infrastructure,interface}.
const claudeOatPorts = buildClaudeOatPorts({
  dataDir: SHIELD_DATA_DIR,
  serverIdPath: SERVER_ID_FILE,
});
const claudeOatModule: ClaudeOatModule = buildClaudeOatModule(claudeOatPorts);
const claudeOatProbe = new ProbeLoop(
  claudeOatModule,
  new HttpAnthropicProbeClient(),
);

// Register all routes
registerAllRoutes(app, {
  hostname,
  rpName: RP_NAME,
  claudeOat: claudeOatModule,
});

// Start server
console.log(`[shield] Starting Sovereign Shield on port ${PORT}...`);
console.log(`[shield] Hostname: ${hostname}`);
console.log(`[shield] RP Name: ${RP_NAME}`);

serve({
  fetch: app.fetch,
  port: PORT,
  hostname: '127.0.0.1',
}, (info) => {
  console.log(`[shield] Sovereign Shield running on http://127.0.0.1:${info.port}`);

  // Generate and write internal service token (Phase 2: internal endpoint auth)
  // Fresh token on every start — services re-read on 401
  initInternalToken();

  // Initialize local settings file on boot (tier-based defaults)
  initSettings();

  // Initialize gate permissions file
  initGatePermissions();

  // Initialize guardrail rule store (local SQLite, seeds defaults on first boot)
  initRuleStore();

  // Restore persisted gate grants (app-level only, with remaining TTL)
  restoreGateState();

  // Materialize cross-project access config from DB so the namespace
  // script can read it immediately (setgid inherits shield-ipc group).
  syncCrossProjectConfigOnStartup();

  // Reconcile shared snapshots for all readers — heals any .shared/
  // directories that were empty due to prior EACCES failures.
  try {
    const readers = new Set(listAllCrossProjectAccess().map((r) => r.sandboxId));
    for (const reader of readers) {
      try { reconcileSharedSnapshots(reader); } catch { /* best-effort per reader */ }
    }
  } catch { /* cross-project not yet provisioned */ }

  // Greenfield Claude OAT credential subsystem.
  //
  // The module was built at top-level (before route registration so the
  // routes layer can hold a reference). Here we just kick off the probe
  // loop — the SOLE state-mutation signal for credential transitions.
  // Bridge's report-401 endpoint is audit-only. See
  // docs/v2/security/14-claude-oat-credentials.md.
  claudeOatProbe.start();

  // Permission metrics — subscribes to permissionBus events for
  // counters + histograms exposed at /_auth/permissions/metrics.
  initPermissionMetrics();

  // Periodic sweep of stale pending permission requests (15-min TTL).
  // A request can sit in the inbox across sessions, but not forever — if a
  // human hasn't reviewed it in 15 minutes the agent's assumption is dead.
  const PERMISSION_REQUEST_TTL_MS = 15 * 60 * 1000;
  const permissionSweepTimer = setInterval(() => {
    try { expireStalePermissions(PERMISSION_REQUEST_TTL_MS); } catch {}
  }, 60 * 1000);
  if (permissionSweepTimer.unref) permissionSweepTimer.unref();

  // Background audit chain integrity sweep. `verifyAuditIntegrity` walks
  // the full audit_log hash chain; on mismatch we emit a loud
  // `audit_chain_broken` event (itself hash-chained) and log to stderr
  // so operator alerting picks it up. Runs hourly — tamper detection
  // latency upper-bounded to 60 min, well inside any realistic
  // forensics-response window.
  const AUDIT_VERIFY_INTERVAL_MS = 60 * 60 * 1000;
  const auditVerifyTimer = setInterval(() => {
    try {
      // Lazy require to avoid circular init order with database.ts.
      const { verifyAuditIntegrity, logAuditEvent } = require('./application/audit/Audit');
      const result = verifyAuditIntegrity();
      if (!result.valid) {
        console.error(
          `[shield] AUDIT CHAIN BROKEN — ${result.errors.length} error(s) across ${result.total} rows`,
          JSON.stringify(result.errors.slice(0, 5)),
        );
        logAuditEvent({
          type: 'audit_chain_broken',
          details: {
            total: result.total,
            errorCount: result.errors.length,
            firstErrorId: result.errors[0]?.id ?? null,
            reason: result.errors[0]?.error ?? null,
          },
        });
      }
    } catch (err) {
      console.error('[shield] audit verifier sweep failed:', (err as Error).message);
    }
  }, AUDIT_VERIFY_INTERVAL_MS);
  if (auditVerifyTimer.unref) auditVerifyTimer.unref();

  // Initialize wallet subsystem (feature-flagged, lazy import)
  if (isWalletEnabled()) {
    try {
      const { initWalletLedger } = require('./application/wallets/WalletLedger');
      const { initWalletIfEnabled } = require('./application/wallets/WalletKeypair');
      initWalletLedger(db);
      initWalletIfEnabled();
      console.log('[shield] Wallet subsystem initialized');
    } catch (err) {
      console.warn('[shield] Wallet subsystem unavailable (missing dependency):', err instanceof Error ? err.message : String(err));
    }
  }

  // Migrate git secrets from env file to memory (one-time, removes from disk)
  migrateGitSecretsFromEnvFile();

  // Periodic cleanup of expired shield sessions (every 60 seconds)
  setInterval(cleanupExpiredSessions, 60 * 1000);

  // Periodic cleanup of expired preview tokens/sessions (every 5 minutes)
  setInterval(cleanupPreviewData, 5 * 60 * 1000);

  // Periodic cleanup of expired PoP nonces (every 60 seconds)
  setInterval(cleanupExpiredNonces, 60 * 1000);

  // Startup: clean up orphaned temp migrate roles from previous crash
  cleanupOrphanedTempRoles();

  // Startup: regenerate the main Caddyfile from the bundled caddy-gen
  // handlers so any upstream fixes (e.g. the localhost → 127.0.0.1
  // migration) land on the next core-runtime update without having to
  // ship a separate caddy-gen binary. Non-destructive: detects the
  // current deployment model and domain tuple from /etc/ellul/* and
  // feeds them through `generateCaddyfileContent`. Writes a new file
  // only if the content differs from what's on disk, then reloads
  // Caddy via the admin socket. Any failure is logged and skipped —
  // the existing Caddyfile continues to serve.
  void regenerateCaddyfileOnStartup();

  // Periodic cleanup of expired database temp migrate roles (every 60 seconds)
  setInterval(cleanupExpiredTempRoles, 60 * 1000);

  // Project GC: reclaim orphaned root-owned dirs that consume entitlement slots.
  // Startup sweep after 60s (wait for services to stabilize) + hourly interval.
  setTimeout(sweepOrphanedProjects, 60_000);
  setInterval(sweepOrphanedProjects, 60 * 60 * 1000);

  // Sync all secrets from API on startup (loads __GIT_PROVIDER, __GIT_REPO_URL, etc.)
  // Must run before refreshGitToken since token refresh only gets __GIT_TOKEN.
  setTimeout(syncSecretsFromApi, 5_000);

  // Git token refresh — pull encrypted token from API every 30 minutes
  setTimeout(refreshGitToken, 10_000); // Initial pull after 10s startup delay
  setInterval(refreshGitToken, 30 * 60 * 1000);

  // Retry any pending tier notification that failed during a previous switch.
  // Runs on startup (catches crash-during-notify) + every 60s until delivered.
  void retryPendingTierNotification();
  setInterval(() => void retryPendingTierNotification(), 60 * 1000);
});

// ── Caddyfile auto-regeneration on shield startup ──

/**
 * Regenerate /etc/caddy/Caddyfile from the bundled caddy-gen handlers,
 * if the resulting content differs from what's on disk. Reloads Caddy
 * on change.
 *
 * Why this lives in shield's startup path: shield restarts on every
 * core-runtime update, so adding a regen step here is the cheapest
 * fleet-wide way to propagate Caddyfile fixes — the alternative would
 * be to bundle `ellul-caddy-gen` into the release manifest and wire
 * it into agent-sync's apply phase, which is a bigger change.
 *
 * Used to recover from the `localhost:3002` vs `127.0.0.1:3002` IPv4/
 * IPv6 mismatch that bricked /api/apps routing across the fleet:
 * /etc/hosts resolves `localhost` to ::1 first, internal services
 * only bind to 127.0.0.1, and Caddy's `dial tcp [::1]:<port>` always
 * returns connection refused. The fix was shipped in handlers.ts, but
 * without this regen step the on-disk Caddyfile would keep the stale
 * content until the next manual provisioning run.
 *
 * All failures are logged, never thrown — shield startup must not
 * depend on Caddy reachability.
 */
async function regenerateCaddyfileOnStartup(): Promise<void> {
  const CADDYFILE_PATH = '/etc/caddy/Caddyfile';
  const DEV_DOMAIN_PATH = '/etc/ellul/dev-domain';
  const CODE_DOMAIN_PATH = '/etc/ellul/code-domain';
  const ORIGIN_TAG_PATH = '/etc/ellul/origin-tag';
  const DEPLOYMENT_MODEL_PATH = '/etc/ellul/deployment-model';
  const FIREWALL_MODE_PATH = '/etc/ellul/firewall-mode';
  try {
    // Lazy-import so the startup path stays fast and shield's package graph
    // stays layered.
    const { generateCaddyfileContent } = await import('@vps/services/gateway/caddy-gen/caddyfile');
    const { reloadCaddy } = await import('@vps/shared/caddy');

    const read = (p: string): string | undefined => {
      try { return fs.readFileSync(p, 'utf8').trim() || undefined; } catch { return undefined; }
    };
    const mainDomain = read(DOMAIN_FILE);
    if (!mainDomain) {
      // FAIL-CLOSED: no domain at all means we can't generate ANY route.
      // Write a lockdown Caddyfile that rejects everything with 503.
      // This prevents unauthenticated access when provisioning is incomplete.
      console.error('[shield] caddyfile-regen: no domain file — writing lockdown Caddyfile');
      const lockdownContent = [
        `{ admin unix//run/caddy/admin.sock|0660 }`,
        `:443 { respond "Service unavailable — provisioning incomplete" 503 }`,
        ``,
      ].join('\n');
      try {
        const { reloadCaddy: lockdownReload } = await import('@vps/shared/caddy');
        fs.writeFileSync(CADDYFILE_PATH, lockdownContent);
        // 664 = group-writable so subsequent shield regens (same service,
        // running as shield-runner in the caddy group) succeed. 644 is
        // what we had before and broke self-heal: shield could write the
        // lockdown once (the file didn't exist yet) but could never
        // overwrite it with the real Caddyfile after provisioning
        // completed. See main.ts/regen and provisioning/caddy-main.sh.
        try { fs.chmodSync(CADDYFILE_PATH, 0o664); } catch {}
        await lockdownReload().catch(() => {});
        console.error('[shield] caddyfile-regen: lockdown Caddyfile applied — all requests return 503');
      } catch {}
      return;
    }
    // code-domain: read from file if available, else derive from main domain.
    // The enforcer derives it as: -srv. → -code., -dc. → -dcode.
    // Shield must use the same derivation so the Caddyfile is generated
    // deterministically regardless of whether the file was written.
    let codeDomain = read(CODE_DOMAIN_PATH);
    if (!codeDomain) {
      codeDomain = mainDomain.replace(/-srv\./, '-code.').replace(/-dc\./, '-dcode.');
    }
    // dev-domain: read from file if available, else derive from main domain.
    let devDomain = read(DEV_DOMAIN_PATH);
    if (!devDomain) {
      // -srv.ellul.ai → -dev.ellul.app (different TLD)
      const tag = mainDomain.split('-srv.')[0] || mainDomain.split('.')[0];
      const appZone = read('/etc/ellul/app-zone');
      if (tag && appZone) devDomain = `${tag}-dev.${appZone}`;
    }
    if (!codeDomain || !devDomain) {
      console.error(`[shield] caddyfile-regen: cannot derive domains (code=${codeDomain}, dev=${devDomain}) — writing lockdown Caddyfile`);
      return;
    }
    const originTag = read(ORIGIN_TAG_PATH);
    // Deployment model lives in its OWN file (deployment-model). It is
    // distinct from firewall-mode, which is the ironclad trust level
    // (full_ironclad/partial_ironclad/relaxed/governance) — those values
    // are NOT deployment models and silently fell through to "direct"
    // here for years, breaking caddyfile-regen on every paid VPS.
    // Boot-config writes deployment-model normalized to proxied|direct.
    // For older fleets that boot the new binary before boot-config has
    // written the file, decide ONLY on explicit "direct" — every other
    // value (including ironclad strings) yields proxied. proxied is the
    // safer functional default: a CF-fronted VPS with proxied yields a
    // working Caddyfile; with direct it loses the *.app wildcard block
    // and breaks preview. Both modes are security-equivalent (mTLS in
    // proxied vs ACME cert in direct — Caddy auth still gates traffic).
    const deploymentModelRaw = read(DEPLOYMENT_MODEL_PATH) || read(FIREWALL_MODE_PATH);
    const isLocalhost = deploymentModelRaw === 'localhost';
    const deploymentModel: 'proxied' | 'direct' | 'localhost' =
      isLocalhost ? 'localhost' : deploymentModelRaw === 'direct' ? 'direct' : 'proxied';

    const { PLATFORM_ZONE, APP_ZONE, CONSOLE_ORIGIN } = await import('./config');
    let customDomain: string | undefined;
    try {
      const cd = fs.readFileSync('/etc/ellul/custom-domain', 'utf8').trim();
      if (cd) customDomain = cd;
    } catch {}

    const newContent = generateCaddyfileContent({
      deploymentModel,
      mainDomain,
      codeDomain,
      devDomain,
      platformZone: PLATFORM_ZONE,
      appZone: APP_ZONE,
      consoleOrigin: CONSOLE_ORIGIN,
      customDomain,
      originTag,
      ...(isLocalhost && { highPorts: process.env.ELLUL_PLATFORM === 'android', canDeploy: false }),
    });

    let current = '';
    try { current = fs.readFileSync(CADDYFILE_PATH, 'utf8'); } catch {}
    if (current === newContent) {
      console.log('[shield] caddyfile-regen: already up-to-date');
      return;
    }

    fs.writeFileSync(CADDYFILE_PATH, newContent);
    // 664 keeps the file writable by the caddy group on subsequent
    // regens (shield-runner is SupplementaryGroups=caddy). 644 was the
    // root cause of `caddyfile-regen: skipped — EACCES` — initial
    // provisioning wrote root-owned 644, shield-runner fell into
    // "other" with read-only, every later regen silently failed.
    try { fs.chmodSync(CADDYFILE_PATH, 0o664); } catch {}
    console.log('[shield] caddyfile-regen: wrote updated Caddyfile');

    try {
      await reloadCaddy();
      console.log('[shield] caddyfile-regen: Caddy reloaded');
    } catch (err) {
      console.warn('[shield] caddyfile-regen: reload failed —', (err as Error).message);
    }
  } catch (err) {
    const msg = (err as Error).message;
    // EACCES specifically means the on-disk Caddyfile is owned/moded
    // such that shield-runner can't rewrite it. Dump the current mode
    // and ownership so the operator can tell whether it's the file
    // (should be caddy:caddy 664) or the dir (should be caddy:caddy 2770)
    // that's wrong. Silent "skipped" was swallowing this for every boot.
    if (msg.includes('EACCES')) {
      try {
        const s = fs.statSync('/etc/caddy/Caddyfile');
        console.error(
          `[shield] caddyfile-regen: EACCES on write — file mode=${(s.mode & 0o7777).toString(8)} uid=${s.uid} gid=${s.gid}. ` +
          `Expected caddy:caddy 664 (see caddy-main.sh provisioning). ` +
          `Running regen as shield-runner (SupplementaryGroups=caddy). ` +
          `Fix: chown caddy:caddy /etc/caddy/Caddyfile && chmod 664 /etc/caddy/Caddyfile`,
        );
      } catch {
        console.error(`[shield] caddyfile-regen: EACCES on write and stat also failed — ${msg}`);
      }
    } else {
      console.warn('[shield] caddyfile-regen: skipped —', msg);
    }
  }
}

// ── Git Token Refresh ──

/**
 * Pull encrypted GitHub installation token from API and write to env file.
 * The VPS initiates this — no secrets flow through the heartbeat.
 */
async function refreshGitToken(): Promise<void> {
  try {
    // Read API URL and bearer token
    let apiUrl: string;
    let bearerToken: string | null = null;

    try {
      apiUrl = fs.readFileSync(API_URL_FILE, 'utf8').trim();
    } catch {
      return; // No API URL configured — skip silently
    }

    // Read ELLUL_AI_TOKEN from file (bashrc sources this via $(cat ...) which regex can't parse)
    try {
      bearerToken = fs.readFileSync('/etc/ellul-bootstrap/ai-proxy-token', 'utf8').trim();
    } catch {}

    if (!bearerToken) return; // No token — skip

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    try {
      const res = await fetch(`${apiUrl}/api/servers/git-token`, {
        headers: { Authorization: `Bearer ${bearerToken}` },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) return;

      const data = await res.json() as any;

      if (data.noToken) {
        // No linked repo — remove stale git token if present
        deleteGitCredential('__GIT_TOKEN');
        return;
      }

      if (data._pqc === 3 && data.x25519_eph_pub && data.mlkem_ct && data.iv && data.encryptedData) {
        const envelope: HybridKemEncryptedEnvelope = {
          _e2ee: true,
          _pqc: 3,
          x25519_eph_pub: data.x25519_eph_pub,
          mlkem_ct: data.mlkem_ct,
          iv: data.iv,
          encryptedData: data.encryptedData,
        };
        setGitCredentialEncrypted('__GIT_TOKEN', envelope);

        // Also refresh per-app token so the active app's __GIT_TOKEN__APPNAME
        // stays fresh (the per-app key takes priority over the base key in lookup)
        try {
          const activeApp = fs.readFileSync('/etc/ellul/shield-data/.active-git-app', 'utf8').trim();
          if (activeApp && activeApp !== 'null' && activeApp !== 'default') {
            const suffix = buildAppSuffix(activeApp);
            setGitCredentialEncrypted(`__GIT_TOKEN${suffix}`, envelope);
          }
        } catch {
          // No active git app — only base token refreshed
        }

        console.log('[shield] Git token refreshed');
      }
    } catch (err: any) {
      clearTimeout(timeout);
      if (err.name !== 'AbortError') {
        console.warn('[shield] Git token refresh failed:', err.message);
      }
    }
  } catch (err: any) {
    console.warn('[shield] Git token refresh error:', err.message);
  }
}

// Graceful shutdown — drain active proxy streams before exit
let shuttingDown = false;

function gracefulShutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shield] ${signal} received — shutting down gracefully...`);
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
