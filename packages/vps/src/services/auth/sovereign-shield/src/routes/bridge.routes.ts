// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Platform bridge postMessage API: dashboard hidden iframe ↔ shield security settings.

import type { Hono } from 'hono';
import fs from 'fs';
import crypto from 'crypto';
import BRIDGE_HTML from '../static/bridge-page.html';
import { db } from '../database';
import { SSH_AUTH_KEYS_PATH, PLATFORM_ZONE } from '../config';
import { getDeviceFingerprint, getClientIp } from '../auth/fingerprint';
import { createSession, validateSession, refreshSession, setSessionCookie, createSessionExchangeCode, createJwtExchangeCode } from '../auth/session';
import { verifyJwtToken, createJwtToken } from '../auth/jwt';
import { logAuditEvent } from '../application/audit/Audit';
import { checkApiRateLimit } from '../application/platform/RateLimiter';
import {
  getCurrentTier,
  executeTierSwitch,
  notifyPlatformPasskeyRemoved,
  notifyPlatformSettingsChange,
  notifyPlatformHeartbeatKeyReset,
} from '../application/gates/Tier';
import { readSettings, applyTierOverrides, toggleTerminal, toggleSsh, setDesktopViewMode, setUiMode, type DesktopViewMode, type UiMode } from '../application/platform/Settings';
import { killPorts, DEV_PORTS } from '../application/process/Process';
import { executeGitAction, type GitAction } from '../application/credentials/Git';
import { switchDeployment } from '../application/process/Deployment';
import { normalizeDeploymentModel } from '@vps/shared/constants';
import { getSshKeys } from './keys.routes';
import { parseCookies } from '../utils/cookie';
import { createConfirmation, validateConfirmation } from '../application/process/InfraConfirm';
import { cryptoAudit, readAuditLog, getChainHead } from '../application/audit/CryptoAudit';
import { verifyPopSignature } from '../auth/pop';
import { OPERATOR_TIMESTAMP_TOLERANCE_MS } from '../config';

/**
 * Register bridge routes on Hono app
 */
export function registerBridgeRoutes(app: Hono, hostname: string): void {

  /**
   * Generate internal JWT for file-api calls (same format as enforcer/agent-bridge).
   */
  function generateInternalJwt(): string | null {
    try {
      const jwtSecret = fs.readFileSync('/etc/ellul/jwt-secret', 'utf8').trim();
      if (!jwtSecret) return null;

      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const now = Math.floor(Date.now() / 1000);
      const payload = Buffer.from(JSON.stringify({
        purpose: 'internal',
        iat: now,
        exp: now + 300,
      })).toString('base64url');

      const sig = crypto.createHmac('sha256', jwtSecret)
        .update(`${header}.${payload}`)
        .digest('base64url');

      return `${header}.${payload}.${sig}`;
    } catch {
      return null;
    }
  }

  /**
   * Notify platform API about VPS events (volume_encrypted, volume_unlocked, etc.)
   * via the vps-event webhook.
   */
  async function notifyPlatformEvent(event: string): Promise<void> {
    try {
      const apiUrl = (fs.readFileSync('/etc/ellul/api-url', 'utf8').trim()) || `https://api.${PLATFORM_ZONE}`;
      const token = fs.readFileSync('/etc/ellul-bootstrap/ai-proxy-token', 'utf8').trim();
      if (!token) return;

      // Read nonce file (monotonic counter for replay protection)
      let nonce = 0;
      const nonceFile = '/etc/ellul/vps-event-nonce';
      try {
        nonce = parseInt(fs.readFileSync(nonceFile, 'utf8').trim(), 10) || 0;
      } catch {}
      nonce++;
      fs.writeFileSync(nonceFile, `${nonce}`);

      await fetch(`${apiUrl}/api/servers/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ event, nonce }),
      }).catch(() => {});
    } catch {}
  }

  /**
   * Bridge HTML page - hidden iframe for postMessage communication
   */
  app.get('/_auth/bridge', async (c) => {
    c.header('Cache-Control', 'no-store, no-cache, must-revalidate');
    c.header('Pragma', 'no-cache');
    const tier = getCurrentTier();
    return c.html(BRIDGE_HTML.replace('__SECURITY_TIER__', tier));
  });

  /**
   * Bridge API: Check session (JSON response, not redirect)
   */
  app.get('/_auth/bridge/session', async (c) => {
    const ip = getClientIp(c);

    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const cookies = parseCookies(c.req.header('cookie'));
    const sessionId = cookies.shield_session;

    if (!sessionId) {
      return c.json({ error: 'No session' }, 401);
    }

    const fingerprintData = getDeviceFingerprint(c);
    const result = validateSession(sessionId, ip, fingerprintData, '/_auth/bridge/session');

    if (!result.valid) {
      return c.json({ error: 'Invalid session', reason: result.reason }, 401);
    }

    // Refresh session
    const refresh = refreshSession(result.session!, ip, fingerprintData);
    if (refresh.rotated) {
      setSessionCookie(c, refresh.sessionId, hostname);
    }

    return c.json({ valid: true });
  });

  /**
   * Bridge API: Create a one-time exchange code for the current session.
   * Used by the console to pass auth to cross-origin iframes (chat, etc.)
   * without relying on SameSite=Lax cookies which are NOT sent in iframes.
   *
   * The code is single-use, 30s TTL, and consumed by forward_auth's
   * _shield_code URL parameter handler which sets the appropriate cookie
   * on the target domain and redirects to the clean URL.
   *
   * Both tiers:
   *   web_locked → exchange code maps to passkey session ID
   *   standard   → exchange code maps to the JWT string
   *
   * Auth: SESSION (tier-gate middleware validates session + PoP before handler runs).
   * The handler reads the validated auth context from tierGateAuth — never
   * re-parses cookies for the session identity (defense-in-depth).
   */
  app.post('/_auth/bridge/exchange-code', async (c) => {
    const ip = getClientIp(c);

    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    // Tier-gate middleware already validated session (web_locked) or JWT (standard)
    // before this handler runs. Read the validated auth context.
    const auth = (c as any).get('tierGateAuth') as { tier: string; sessionId?: string; userId?: string; jwtId?: string } | undefined;
    if (!auth) {
      return c.json({ error: 'No authenticated context' }, 401);
    }

    let code: string;

    if (auth.tier !== 'standard') {
      // Web locked: exchange code maps to passkey session ID
      if (!auth.sessionId) {
        return c.json({ error: 'No session' }, 401);
      }
      code = createSessionExchangeCode(auth.sessionId);
      logAuditEvent({ type: 'exchange_code_created', ip, sessionId: auth.sessionId });
    } else if (auth.tier === 'standard') {
      // Standard: exchange code maps to the JWT string.
      // Accept from cookie (browser) or Authorization header (native app bridge).
      const cookies = parseCookies(c.req.header('cookie'));
      const authHeader = c.req.header('authorization');
      const jwt = cookies['terminal_token'] || cookies['term_session'] ||
        (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined);
      if (!jwt) {
        return c.json({ error: 'No JWT' }, 401);
      }
      // Defense-in-depth: verify the JWT is actually valid before creating an exchange code.
      // tier-gate already verified it, but we're about to hand it to another domain.
      const verified = verifyJwtToken(c.req);
      if (!verified) {
        return c.json({ error: 'JWT validation failed' }, 401);
      }
      code = createJwtExchangeCode(jwt);
      logAuditEvent({ type: 'exchange_code_created', ip, details: { tier: 'standard', userId: auth.userId } });
    } else {
      return c.json({ error: 'Unknown tier' }, 400);
    }

    return c.json({ code });
  });

  /**
   * Bridge API: Get SSH keys (JSON response)
   */
  app.get('/_auth/bridge/keys', async (c) => {
    const ip = getClientIp(c);

    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const auth = await requireBridgeAuth(c, ip);
    if (!auth.valid) {
      return c.json({ error: auth.error }, (auth.status || 401) as any);
    }

    const keys = getSshKeys();
    return c.json(keys);
  });

  /**
   * Bridge API: Get passkeys (JSON response)
   */
  app.get('/_auth/bridge/passkeys', async (c) => {
    const ip = getClientIp(c);

    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const auth = await requireBridgeAuth(c, ip);
    if (!auth.valid) {
      return c.json({ error: auth.error }, (auth.status || 401) as any);
    }

    const passkeys = db.prepare('SELECT id, name, createdAt FROM credential').all() as Array<{
      id: string;
      name: string | null;
      createdAt: number;
    }>;
    return c.json(passkeys.map(p => ({
      id: p.id,
      name: p.name || 'Passkey',
      registeredAt: p.createdAt,
    })));
  });

  /**
   * Bridge API: Get current tier info and owner ID
   * SECURITY: Owner ID from immutable owner.lock is used by platform to verify ownership
   * SECURITY: Requires valid session for detailed info (keys, passkeys).
   *   Tier + ownerId are always included in the response body (even on 401)
   *   so the platform bridge can verify server security without a browser session.
   */
  app.get('/_auth/bridge/tier', async (c) => {
    const ip = getClientIp(c);

    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const tier = getCurrentTier();

    // Read owner ID from immutable lock file (Identity Pinning)
    let ownerId = null;
    try {
      ownerId = fs.readFileSync('/etc/ellul/owner.lock', 'utf8').trim();
    } catch {
      // owner.lock doesn't exist (shouldn't happen in production)
    }

    const cookies = parseCookies(c.req.header('cookie'));
    const sessionId = cookies.shield_session;

    if (!sessionId) {
      return c.json({ error: 'Authentication required', tier }, 401);
    }

    const fingerprintData = getDeviceFingerprint(c);
    const result = validateSession(sessionId, ip, fingerprintData, '/_auth/bridge/tier');

    if (!result.valid) {
      return c.json({ error: 'Session invalid or expired', tier }, 401);
    }

    const sshKeys = getSshKeys();
    const passkeys = db.prepare('SELECT id FROM credential').all();

    return c.json({
      tier,
      ownerId,
      sshKeyCount: sshKeys.length,
      passkeyCount: passkeys.length,
      sshKeys,
      passkeys: passkeys.map((p: any) => ({ id: p.id })),
    });
  });

  /**
   * Bridge API: Remove passkey
   */
  app.delete('/_auth/bridge/passkey/:credentialId', async (c) => {
    const ip = getClientIp(c);

    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const auth = await requireBridgeAuth(c, ip);
    if (!auth.valid) {
      return c.json({ error: auth.error }, (auth.status || 401) as any);
    }

    const credentialId = c.req.param('credentialId');

    // Don't allow removing the last passkey in Web Locked mode
    const tier = getCurrentTier();
    const passkeys = db.prepare('SELECT id FROM credential').all();
    if (tier !== 'standard' && passkeys.length <= 1) {
      return c.json({ error: 'Cannot remove the last passkey in Web Locked mode' }, 400);
    }

    // Get passkey name before deletion for notification
    const passkey = db.prepare('SELECT name FROM credential WHERE id = ?').get(credentialId) as { name: string | null } | undefined;
    const passkeyName = passkey?.name || 'Passkey';

    // Remove the passkey
    db.prepare('DELETE FROM credential WHERE id = ?').run(credentialId);

    logAuditEvent({
      type: 'passkey_removed',
      ip,
      details: { credentialId }
    });

    // Notify platform (fire-and-forget)
    notifyPlatformPasskeyRemoved(credentialId, passkeyName).catch(() => {});

    // Re-export bootstrap credentials after passkey deletion
    try {
      const { exportBootstrapCredentials } = require('../application/platform/BootstrapExport');
      exportBootstrapCredentials();
    } catch (e) { console.warn('[shield] Bootstrap export after passkey delete failed:', e); }

    return c.json({ success: true, credentialId });
  });

  /**
   * Bridge API: Upgrade from Standard to Web Locked
   */
  app.post('/_auth/bridge/upgrade-to-web-locked', async (c) => {
    const ip = getClientIp(c);

    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const auth = await requireBridgeAuth(c, ip);
    if (!auth.valid) {
      return c.json(
        { error: auth.error, ...(auth.requiresPasskey ? { requiresPasskey: true } : {}) },
        (auth.status || 401) as any,
      );
    }

    const currentTier = getCurrentTier();
    if (currentTier !== 'standard') {
      return c.json({ error: 'Can only upgrade to Web Locked from Standard tier' }, 400);
    }

    // Verify we have at least one passkey registered
    const passkeys = db.prepare('SELECT id FROM credential').all();
    if (passkeys.length === 0) {
      return c.json({ error: 'At least one passkey must be registered first' }, 400);
    }

    // Check for SSH keys as recovery backup
    const hasSSHKeys = fs.existsSync(SSH_AUTH_KEYS_PATH) &&
      fs.readFileSync(SSH_AUTH_KEYS_PATH, 'utf8').trim().length > 0;

    // If no SSH keys, require explicit acknowledgment of permanent lockout risk
    const body = await c.req.json().catch(() => ({})) as { acknowledgeNoRecovery?: boolean };
    if (!hasSSHKeys && !body.acknowledgeNoRecovery) {
      return c.json({
        error: 'No SSH keys configured',
        warning: 'PERMANENT LOCKOUT RISK: You have no SSH keys. If you lose your passkey device, you will permanently lose access to this server. There is NO recovery path.',
        requiresAcknowledgment: true,
        hint: 'Add an SSH key first, or set acknowledgeNoRecovery: true to proceed at your own risk',
      }, 400);
    }

    // Execute the tier upgrade
    try {
      await executeTierSwitch('web_locked', ip, c.req.header('user-agent') || 'unknown');
      return c.json({ success: true, tier: 'web_locked' });
    } catch (e) {
      return c.json({ error: (e as Error).message || 'Failed to upgrade to Web Locked' }, 500);
    }
  });

  /**
   * Bridge API: Downgrade from Web Locked to Standard
   * PoP is enforced by requireBridgeAuth (web_locked tier auto-verifies PoP).
   * Tier guard: rejects if Privacy Lock is active (immutable).
   */
  app.post('/_auth/bridge/downgrade-to-standard', async (c, next) => {
    // Tier policy guard — rejects if current tier is immutable
    const { isPrivacyLocked } = await import('../application/gates/TierPolicy');
    if (isPrivacyLocked()) {
      return c.json({
        error: 'Privacy Lock is permanent',
        code: 'TIER_IMMUTABLE',
        message: 'Volume encryption is active. Security tier cannot be reduced.',
      }, 403);
    }

    const ip = getClientIp(c);

    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const auth = await requireBridgeAuth(c, ip);
    if (!auth.valid) {
      return c.json(
        { error: auth.error, ...(auth.requiresPasskey ? { requiresPasskey: true } : {}) },
        (auth.status || 401) as any,
      );
    }

    const currentTier = getCurrentTier();
    if (currentTier === 'standard') {
      return c.json({ error: 'Can only downgrade to Standard from Web Locked tier' }, 400);
    }

    // Execute the tier downgrade
    try {
      await executeTierSwitch('standard', ip, c.req.header('user-agent') || 'unknown');
      return c.json({ success: true, tier: 'standard' });
    } catch (e) {
      return c.json({ error: (e as Error).message || 'Failed to downgrade to Standard' }, 500);
    }
  });

  /**
   * Bridge API: Switch security tier
   */
  app.post('/_auth/bridge/switch-tier', async (c) => {
    const ip = getClientIp(c);

    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const auth = await requireBridgeAuth(c, ip);
    if (!auth.valid) {
      return c.json(
        { error: auth.error, ...(auth.requiresPasskey ? { requiresPasskey: true } : {}) },
        (auth.status || 401) as any,
      );
    }

    const body = await c.req.json() as { targetTier?: string; acknowledgeNoRecovery?: boolean };
    const { targetTier } = body;

    if (!targetTier || !['standard', 'web_locked', 'private_locked'].includes(targetTier)) {
      return c.json({ error: 'Invalid target tier' }, 400);
    }

    // For web_locked without SSH, warn about permanent lockout risk
    if (targetTier === 'web_locked') {
      const keys = getSshKeys();
      if (keys.length === 0 && !body.acknowledgeNoRecovery) {
        return c.json({
          error: 'No SSH keys configured',
          warning: 'PERMANENT LOCKOUT RISK: You have no SSH keys. If you lose your passkey device, you will permanently lose access to this server. There is NO recovery path.',
          requiresAcknowledgment: true,
          hint: 'Add an SSH key first, or set acknowledgeNoRecovery: true to proceed at your own risk',
        }, 400);
      }
    }

    // Execute tier switch and notify platform
    try {
      await executeTierSwitch(targetTier as 'standard' | 'web_locked' | 'private_locked', ip, c.req.header('user-agent') || 'unknown');
      return c.json({ success: true, tier: targetTier });
    } catch (e) {
      return c.json({ error: (e as Error).message || 'Failed to switch tier' }, 500);
    }
  });

  // =========================================================================
  // Settings endpoints — PASSKEY-ONLY auth + PoP (no JWT, no bearer token)
  //
  // SECURITY: Settings changes require physical device attestation via WebAuthn.
  // On web_locked tier, PoP (Proof-of-Possession) is verified on every request
  // by tier-gate middleware — stolen session IDs alone cannot call these endpoints.
  // Architecturally impossible for AI agents to bypass.
  // =========================================================================

  /**
   * Bridge auth: business-rule checks for SESSION-classified routes.
   *
   * Session + PoP authentication is already enforced by tier-gate.middleware.ts
   * before any handler runs. This function only checks bridge-specific business
   * rules (e.g., "does the user have a passkey registered") and provides
   * user-friendly error messages that the generic middleware cannot provide.
   */
  async function requireBridgeAuth(c: any, ip: string): Promise<{ valid: boolean; error?: string; status?: number; requiresPasskey?: boolean }> {
    const tier = getCurrentTier();
    if (tier !== 'standard') {
      const passkeys = db.prepare('SELECT id FROM credential').all();
      if (passkeys.length === 0) {
        return { valid: false, error: 'Register a passkey to manage settings', status: 403, requiresPasskey: true };
      }
    }
    return { valid: true };
  }

  /**
   * Bridge API: Get local settings state
   */
  app.get('/_auth/bridge/settings', async (c) => {
    const ip = getClientIp(c);

    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const auth = await requireBridgeAuth(c, ip);
    if (!auth.valid) {
      return c.json(
        { error: auth.error, ...(auth.requiresPasskey ? { requiresPasskey: true } : {}) },
        (auth.status || 401) as any,
      );
    }

    const settings = readSettings();
    const effective = applyTierOverrides(settings);
    return c.json(effective);
  });

  /**
   * Bridge API: Toggle terminal
   */
  app.post('/_auth/bridge/toggle-terminal', async (c) => {
    const ip = getClientIp(c);

    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const auth = await requireBridgeAuth(c, ip);
    if (!auth.valid) {
      return c.json(
        { error: auth.error, ...(auth.requiresPasskey ? { requiresPasskey: true } : {}) },
        (auth.status || 401) as any,
      );
    }

    const body = await c.req.json().catch(() => ({})) as { enabled?: boolean };
    if (typeof body.enabled !== 'boolean') {
      return c.json({ error: 'enabled must be boolean' }, 400);
    }

    try {
      const result = toggleTerminal(body.enabled);
      logAuditEvent({ type: 'settings_changed', ip, details: { field: 'terminal', enabled: result.terminalEnabled } });
      cryptoAudit('setting_changed', 'passkey', { field: 'terminal', enabled: body.enabled });
      // Fire-and-forget webhook (non-blocking — heartbeat reconciles on failure)
      notifyPlatformSettingsChange(result, ip, c.req.header('user-agent') || 'unknown')
        .catch(e => console.warn('[shield] Settings webhook failed:', e.message));
      return c.json({ success: true, ...result });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  /**
   * Bridge API: Toggle SSH
   */
  app.post('/_auth/bridge/toggle-ssh', async (c) => {
    const ip = getClientIp(c);

    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const auth = await requireBridgeAuth(c, ip);
    if (!auth.valid) {
      return c.json(
        { error: auth.error, ...(auth.requiresPasskey ? { requiresPasskey: true } : {}) },
        (auth.status || 401) as any,
      );
    }

    const body = await c.req.json().catch(() => ({})) as { enabled?: boolean };
    if (typeof body.enabled !== 'boolean') {
      return c.json({ error: 'enabled must be boolean' }, 400);
    }

    try {
      const result = toggleSsh(body.enabled);
      logAuditEvent({ type: 'settings_changed', ip, details: { field: 'ssh', enabled: result.sshEnabled } });
      cryptoAudit('setting_changed', 'passkey', { field: 'ssh', enabled: body.enabled });
      // Fire-and-forget webhook (non-blocking — heartbeat reconciles on failure)
      notifyPlatformSettingsChange(result, ip, c.req.header('user-agent') || 'unknown')
        .catch(e => console.warn('[shield] Settings webhook failed:', e.message));
      return c.json({ success: true, ...result });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  /**
   * Bridge API: Set desktop view mode (focus/studio)
   * Pure UI preference — no system side effects, no webhook needed.
   */
  app.post('/_auth/bridge/set-view-mode', async (c) => {
    const ip = getClientIp(c);

    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const auth = await requireBridgeAuth(c, ip);
    if (!auth.valid) {
      return c.json(
        { error: auth.error, ...(auth.requiresPasskey ? { requiresPasskey: true } : {}) },
        (auth.status || 401) as any,
      );
    }

    const body = await c.req.json().catch(() => ({})) as { mode?: string };
    const validModes: DesktopViewMode[] = ['focus', 'studio'];
    if (!body.mode || !validModes.includes(body.mode as DesktopViewMode)) {
      return c.json({ error: `mode must be one of: ${validModes.join(', ')}` }, 400);
    }

    try {
      const result = setDesktopViewMode(body.mode as DesktopViewMode);
      return c.json({ success: true, ...result });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  /**
   * Bridge API: Set UI mode (lite/pro)
   * Pure UI preference — no system side effects, no webhook needed.
   */
  app.post('/_auth/bridge/set-ui-mode', async (c) => {
    const ip = getClientIp(c);

    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const auth = await requireBridgeAuth(c, ip);
    if (!auth.valid) {
      return c.json(
        { error: auth.error, ...(auth.requiresPasskey ? { requiresPasskey: true } : {}) },
        (auth.status || 401) as any,
      );
    }

    const body = await c.req.json().catch(() => ({})) as { mode?: string };
    const validModes: UiMode[] = ['lite', 'pro'];
    if (!body.mode || !validModes.includes(body.mode as UiMode)) {
      return c.json({ error: `mode must be one of: ${validModes.join(', ')}` }, 400);
    }

    try {
      const result = setUiMode(body.mode as UiMode);
      return c.json({ success: true, ...result });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  // =========================================================================
  //  OPERATIONS — Kill Ports, Git, Deployment
  //
  //  Bridge-routed operations (Phase 4). Previously dispatched via heartbeat
  //  response commands. Now executed directly on VPS via passkey-authenticated
  //  bridge endpoints. Dashboard gets instant feedback via postMessage.
  // =========================================================================

  /**
   * Bridge API: Kill processes on dev ports
   */
  app.post('/_auth/bridge/kill-ports', async (c) => {
    const ip = getClientIp(c);

    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const auth = await requireBridgeAuth(c, ip);
    if (!auth.valid) {
      return c.json(
        { error: auth.error, ...(auth.requiresPasskey ? { requiresPasskey: true } : {}) },
        (auth.status || 401) as any,
      );
    }

    const body = await c.req.json().catch(() => ({})) as { ports?: number[] };
    const ports = Array.isArray(body.ports) ? body.ports : DEV_PORTS;

    try {
      const result = killPorts(ports);
      logAuditEvent({ type: 'operation', ip, details: { action: 'kill_ports', ports, killed: result.killed, skipped: result.skipped } });
      cryptoAudit('ports_killed', 'passkey', { ports, killed: result.killed });
      return c.json({ success: true, ...result });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  /**
   * Bridge API: Execute git operation
   */
  app.post('/_auth/bridge/git-action', async (c) => {
    const ip = getClientIp(c);

    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const auth = await requireBridgeAuth(c, ip);
    if (!auth.valid) {
      return c.json(
        { error: auth.error, ...(auth.requiresPasskey ? { requiresPasskey: true } : {}) },
        (auth.status || 401) as any,
      );
    }

    const body = await c.req.json().catch(() => ({})) as { action?: string; sandboxId?: string };
    const validActions: GitAction[] = ['push', 'pull', 'force-push', 'setup', 'teardown'];
    if (!body.action || !validActions.includes(body.action as GitAction)) {
      return c.json({ error: `Invalid action. Must be one of: ${validActions.join(', ')}` }, 400);
    }

    try {
      const result = await executeGitAction(body.action as GitAction, body.sandboxId);
      logAuditEvent({ type: 'operation', ip, details: { action: 'git', gitAction: body.action, sandboxId: body.sandboxId } });
      cryptoAudit('git_action', 'passkey', { action: body.action, sandboxId: body.sandboxId });
      return c.json({ success: true, action: body.action, output: result.output });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  /**
   * Bridge API: Switch deployment model
   */
  app.post('/_auth/bridge/switch-deployment', async (c) => {
    const ip = getClientIp(c);

    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const auth = await requireBridgeAuth(c, ip);
    if (!auth.valid) {
      return c.json(
        { error: auth.error, ...(auth.requiresPasskey ? { requiresPasskey: true } : {}) },
        (auth.status || 401) as any,
      );
    }

    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const validModels = ['proxied', 'direct', 'cloudflare', 'gateway'];
    if (!body.model || typeof body.model !== 'string' || !validModels.includes(body.model) || !body.domain || typeof body.domain !== 'string') {
      return c.json({ error: 'model (proxied|direct) and domain are required' }, 400);
    }

    try {
      const result = await switchDeployment({
        model: normalizeDeploymentModel(body.model),
        domain: body.domain,
        serverId: typeof body.serverId === 'string' ? body.serverId : undefined,
        cfOriginCert: typeof body.cfOriginCert === 'string' ? body.cfOriginCert : undefined,
        cfOriginKey: typeof body.cfOriginKey === 'string' ? body.cfOriginKey : undefined,
        cfAppOriginCert: typeof body.cfAppOriginCert === 'string' ? body.cfAppOriginCert : undefined,
        cfAppOriginKey: typeof body.cfAppOriginKey === 'string' ? body.cfAppOriginKey : undefined,
      });
      if (!result.success) {
        return c.json({ error: result.error }, 500);
      }
      logAuditEvent({ type: 'operation', ip, details: { action: 'switch_deployment', model: body.model, domain: body.domain } });
      cryptoAudit('deployment_switched', 'passkey', { model: body.model, domain: body.domain });
      return c.json({ success: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  // =========================================================================
  //  INFRASTRUCTURE CONFIRMATION — Passkey-gated one-time tokens
  //
  //  Dangerous daemon operations (migrate/pack, migrate/pull) require a
  //  passkey-approved confirmation token. The dashboard obtains a token via
  //  this endpoint, then the platform API includes it in X-Infra-Confirm
  //  when calling the daemon. file-api validates via /_internal/validate-infra-token.
  // =========================================================================

  /**
   * Bridge API: Create infrastructure confirmation token
   */
  app.post('/_auth/bridge/confirm-infra', async (c) => {
    const ip = getClientIp(c);

    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const auth = await requireBridgeAuth(c, ip);
    if (!auth.valid) {
      return c.json(
        { error: auth.error, ...(auth.requiresPasskey ? { requiresPasskey: true } : {}) },
        (auth.status || 401) as any,
      );
    }

    const body = await c.req.json().catch(() => ({})) as { operation?: string };
    const validOperations = ['hibernate', 'migrate', 'maintenance'];
    if (!body.operation || !validOperations.includes(body.operation)) {
      return c.json({ error: `Invalid operation. Must be one of: ${validOperations.join(', ')}` }, 400);
    }

    const confirmation = createConfirmation(body.operation);
    logAuditEvent({ type: 'operation', ip, details: { action: 'infra_confirm', operation: body.operation } });
    cryptoAudit('infra_confirmed', 'passkey', { operation: body.operation });
    return c.json(confirmation);
  });

  // =========================================================================
  //  HEARTBEAT RESET — Manual recovery for broken heartbeat auth
  // =========================================================================

  /**
   * Bridge API: Regenerate Ed25519 heartbeat keypair
   * Use case: manual recovery when heartbeat auth is broken
   */
  app.post('/_auth/bridge/reset-heartbeat', async (c) => {
    const ip = getClientIp(c);

    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    const auth = await requireBridgeAuth(c, ip);
    if (!auth.valid) {
      return c.json(
        { error: auth.error, ...(auth.requiresPasskey ? { requiresPasskey: true } : {}) },
        (auth.status || 401) as any,
      );
    }

    try {
      const { execSync } = await import('child_process');

      // Regenerate Ed25519 keypair
      execSync('openssl genpkey -algorithm Ed25519 -out /etc/ellul-bootstrap/heartbeat.key', { timeout: 5_000 });
      execSync('openssl pkey -in /etc/ellul-bootstrap/heartbeat.key -pubout -out /etc/ellul-bootstrap/heartbeat.pub', { timeout: 5_000 });
      execSync('chmod 600 /etc/ellul-bootstrap/heartbeat.key && chmod 644 /etc/ellul-bootstrap/heartbeat.pub', { timeout: 5_000 });

      // Notify platform to clear stored public key (TOFU will re-register on next heartbeat)
      await notifyPlatformHeartbeatKeyReset();

      // Restart enforcer to pick up new keypair immediately
      execSync('systemctl restart ellul-enforcer 2>/dev/null || true', { timeout: 10_000 });

      logAuditEvent({ type: 'operation', ip, details: { action: 'heartbeat_key_reset' } });
      cryptoAudit('heartbeat_key_reset', 'passkey', {});
      return c.json({ success: true });
    } catch (e) {
      return c.json({ success: false, error: (e as Error).message }, 500);
    }
  });

  // =========================================================================
  //  AUDIT LOG — Cryptographic hash-chained audit trail
  // =========================================================================

  /**
   * Bridge API: Read cryptographic audit log
   * Returns hash-chained, Ed25519-signed audit entries for remote verification.
   * Query param `since` filters entries with seq > since (default 0).
   * Limited to last 100 entries.
   */
  app.get('/_auth/bridge/audit-log', async (c) => {
    const ip = getClientIp(c);

    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const auth = await requireBridgeAuth(c, ip);
    if (!auth.valid) {
      return c.json(
        { error: auth.error, ...(auth.requiresPasskey ? { requiresPasskey: true } : {}) },
        (auth.status || 401) as any,
      );
    }

    const sinceParam = c.req.query('since');
    const since = sinceParam ? parseInt(sinceParam, 10) || 0 : 0;

    const entries = readAuditLog(since, 100);
    const chainHeadValue = getChainHead();

    return c.json({ entries, chainHead: chainHeadValue });
  });

  // ============================================
  // LUKS + Volume operations (browser → VPS via bridge)
  // PRF key goes browser → bridge → file-api, never touches the platform API
  // ============================================

  /**
   * Bridge API: LUKS init — first-time volume encryption
   * Passkey + PoP required. PRF key in body.
   * Calls file-api on localhost:3002 with internal JWT.
   */
  app.post('/_auth/bridge/luks-init', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    const auth = await requireBridgeAuth(c, ip);
    if (!auth.valid) {
      return c.json(
        { error: auth.error, ...(auth.requiresPasskey ? { requiresPasskey: true } : {}) },
        (auth.status || 401) as any,
      );
    }

    const body = await c.req.json().catch(() => ({})) as {
      prfKey?: string; recoveryKey?: string; volumeDevice?: string;
    };
    if (!body.prfKey) return c.json({ error: 'Missing prfKey' }, 400);

    try {
      const internalJwt = generateInternalJwt();
      if (!internalJwt) return c.json({ error: 'Internal auth unavailable' }, 500);

      const resp = await fetch('http://127.0.0.1:3002/api/luks-init', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${internalJwt}`,
        },
        body: JSON.stringify(body),
      });
      const result = await resp.json() as Record<string, unknown>;

      if (result.success) {
        // Notify API via vps-event webhook
        await notifyPlatformEvent('volume_encrypted');
        logAuditEvent({ type: 'luks_init', ip, details: { message: 'LUKS volume initialized via bridge' } });
      }

      return c.json(result, resp.status as any);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  /**
   * Bridge API: LUKS unlock — wake with PRF key
   * Passkey + PoP required. PRF key in body.
   * Calls luks-unlock then restore-identity.
   */
  app.post('/_auth/bridge/luks-unlock', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    const auth = await requireBridgeAuth(c, ip);
    if (!auth.valid) {
      return c.json(
        { error: auth.error, ...(auth.requiresPasskey ? { requiresPasskey: true } : {}) },
        (auth.status || 401) as any,
      );
    }

    const body = await c.req.json().catch(() => ({})) as {
      prfKey?: string; volumeDevice?: string;
    };
    if (!body.prfKey) return c.json({ error: 'Missing prfKey' }, 400);

    try {
      const internalJwt = generateInternalJwt();
      if (!internalJwt) return c.json({ error: 'Internal auth unavailable' }, 500);

      // Step 1: LUKS unlock
      const unlockResp = await fetch('http://127.0.0.1:3002/api/luks-unlock', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${internalJwt}`,
        },
        body: JSON.stringify(body),
      });
      const unlockResult = await unlockResp.json() as Record<string, unknown>;
      if (!unlockResult.success) {
        return c.json(unlockResult, unlockResp.status as any);
      }

      // Step 2: Restore identity (passkey DB from volume backup)
      try {
        await fetch('http://127.0.0.1:3002/api/restore-identity', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${internalJwt}`,
          },
          body: '{}',
        });
      } catch { /* non-fatal — identity restore is best-effort */ }

      // Notify API via vps-event webhook
      await notifyPlatformEvent('volume_unlocked');
      logAuditEvent({ type: 'luks_unlock', ip, details: { message: 'LUKS volume unlocked via bridge' } });

      return c.json({ success: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  /**
   * Bridge API: Mount volume (remount after failed wake)
   * Passkey required.
   */
  app.post('/_auth/bridge/mount-volume', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    const auth = await requireBridgeAuth(c, ip);
    if (!auth.valid) {
      return c.json(
        { error: auth.error, ...(auth.requiresPasskey ? { requiresPasskey: true } : {}) },
        (auth.status || 401) as any,
      );
    }

    const body = await c.req.json().catch(() => ({})) as { volumeDevice?: string };
    if (!body.volumeDevice) return c.json({ error: 'Missing volumeDevice' }, 400);

    try {
      const internalJwt = generateInternalJwt();
      if (!internalJwt) return c.json({ error: 'Internal auth unavailable' }, 500);

      const resp = await fetch('http://127.0.0.1:3002/api/mount-volume', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${internalJwt}`,
        },
        body: JSON.stringify(body),
      });
      const result = await resp.json() as Record<string, unknown>;
      return c.json(result, resp.status as any);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  // ============================================
  // Agent watchdog operations (browser → VPS via bridge)
  // ============================================

  /**
   * Bridge API: Agent auth status
   * Passkey required. Proxies to watchdog on port 7710.
   */
  app.get('/_auth/bridge/agents/auth-status', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    const auth = await requireBridgeAuth(c, ip);
    if (!auth.valid) {
      return c.json(
        { error: auth.error, ...(auth.requiresPasskey ? { requiresPasskey: true } : {}) },
        (auth.status || 401) as any,
      );
    }

    try {
      const resp = await fetch('http://127.0.0.1:7710/agents/auth-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const result = await resp.json();
      return c.json(result, resp.status as any);
    } catch (e) {
      const msg = (e as Error).message;
      const isConnRefused = msg.includes('ECONNREFUSED') || msg.includes('fetch failed');
      if (isConnRefused) {
        return c.json({ error: 'Watchdog service not available', unavailable: true }, 503);
      }
      return c.json({ error: msg }, 500);
    }
  });

  /**
   * Bridge API: Agent interactive setup
   * Passkey required. Proxies to watchdog on port 7710.
   */
  app.post('/_auth/bridge/agents/interactive-setup', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    const auth = await requireBridgeAuth(c, ip);
    if (!auth.valid) {
      return c.json(
        { error: auth.error, ...(auth.requiresPasskey ? { requiresPasskey: true } : {}) },
        (auth.status || 401) as any,
      );
    }

    const body = await c.req.json().catch(() => ({}));

    try {
      const resp = await fetch('http://127.0.0.1:7710/agents/interactive-setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await resp.json();
      return c.json(result, resp.status as any);
    } catch (e) {
      const msg = (e as Error).message;
      const isConnRefused = msg.includes('ECONNREFUSED') || msg.includes('fetch failed');
      if (isConnRefused) {
        return c.json({ error: 'Watchdog service not available', unavailable: true }, 503);
      }
      return c.json({ error: msg }, 500);
    }
  });

  /**
   * Bridge API: start an interactive auth session (claude setup-token,
   * codex login, etc.) in a PTY on the server. Returns a sessionId the
   * client uses to stream output and post stdin.
   */
  app.post('/_auth/bridge/agents/auth/start', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);
    const auth = await requireBridgeAuth(c, ip);
    if (!auth.valid) {
      return c.json(
        { error: auth.error, ...(auth.requiresPasskey ? { requiresPasskey: true } : {}) },
        (auth.status || 401) as any,
      );
    }
    const body = await c.req.json().catch(() => ({}));
    try {
      const resp = await fetch('http://127.0.0.1:7700/api/internal/auth/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await resp.json();
      return c.json(result, resp.status as any);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
        return c.json({ error: 'Bridge service not available', unavailable: true }, 503);
      }
      return c.json({ error: msg }, 500);
    }
  });

  /**
   * Bridge API: SSE stream of stdout + process-exit events for an
   * interactive auth session. The session's output buffer is replayed
   * on subscribe, so a reconnecting client catches up to the CLI's
   * current prompt.
   */
  app.get('/_auth/bridge/agents/auth/:sessionId/events', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);
    const auth = await requireBridgeAuth(c, ip);
    if (!auth.valid) {
      return c.json(
        { error: auth.error, ...(auth.requiresPasskey ? { requiresPasskey: true } : {}) },
        (auth.status || 401) as any,
      );
    }
    const sessionId = c.req.param('sessionId');
    if (!/^[a-f0-9]{24}$/.test(sessionId)) return c.json({ error: 'Invalid sessionId' }, 400);

    const upstream = await fetch(
      `http://127.0.0.1:7700/api/internal/auth/events?id=${encodeURIComponent(sessionId)}`,
      { headers: { Accept: 'text/event-stream' } },
    ).catch((err: Error) => err);
    if (upstream instanceof Error) {
      const msg = upstream.message;
      if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
        return c.json({ error: 'Watchdog service not available', unavailable: true }, 503);
      }
      return c.json({ error: msg }, 500);
    }
    if (!upstream.body) return c.json({ error: 'No stream body' }, 500);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  });

  /**
   * Bridge API: write stdin to an in-flight auth session (paste token,
   * hit Enter to advance a prompt, etc.).
   */
  app.post('/_auth/bridge/agents/auth/:sessionId/input', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);
    const auth = await requireBridgeAuth(c, ip);
    if (!auth.valid) {
      return c.json(
        { error: auth.error, ...(auth.requiresPasskey ? { requiresPasskey: true } : {}) },
        (auth.status || 401) as any,
      );
    }
    const sessionId = c.req.param('sessionId');
    if (!/^[a-f0-9]{24}$/.test(sessionId)) return c.json({ error: 'Invalid sessionId' }, 400);
    const body = await c.req.json().catch(() => ({}));
    try {
      const resp = await fetch(
        `http://127.0.0.1:7700/api/internal/auth/input?id=${encodeURIComponent(sessionId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      const result = await resp.json();
      return c.json(result, resp.status as any);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
        return c.json({ error: 'Bridge service not available', unavailable: true }, 503);
      }
      return c.json({ error: msg }, 500);
    }
  });

  /**
   * Bridge API: terminate an auth session (user closed modal, error).
   */
  app.post('/_auth/bridge/agents/auth/:sessionId/cancel', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);
    const auth = await requireBridgeAuth(c, ip);
    if (!auth.valid) {
      return c.json(
        { error: auth.error, ...(auth.requiresPasskey ? { requiresPasskey: true } : {}) },
        (auth.status || 401) as any,
      );
    }
    const sessionId = c.req.param('sessionId');
    if (!/^[a-f0-9]{24}$/.test(sessionId)) return c.json({ error: 'Invalid sessionId' }, 400);
    try {
      const resp = await fetch(
        `http://127.0.0.1:7700/api/internal/auth/cancel?id=${encodeURIComponent(sessionId)}`,
        { method: 'POST' },
      );
      const result = await resp.json();
      return c.json(result, resp.status as any);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
        return c.json({ error: 'Bridge service not available', unavailable: true }, 503);
      }
      return c.json({ error: msg }, 500);
    }
  });

  /**
   * Bridge API: install a pre-generated claude OAT token directly. Skips
   * the PTY setup-token flow entirely — the user runs `claude setup-token`
   * locally (Anthropic's documented headless setup) and pastes the result.
   */
  app.post('/_auth/bridge/agents/auth/claude-token', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);
    const auth = await requireBridgeAuth(c, ip);
    if (!auth.valid) {
      return c.json(
        { error: auth.error, ...(auth.requiresPasskey ? { requiresPasskey: true } : {}) },
        (auth.status || 401) as any,
      );
    }
    const body = await c.req.json().catch(() => ({}));
    try {
      const resp = await fetch('http://127.0.0.1:7700/api/internal/auth/claude-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await resp.json();
      return c.json(result, resp.status as any);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
        return c.json({ error: 'Bridge service not available', unavailable: true }, 503);
      }
      return c.json({ error: msg }, 500);
    }
  });

  /**
   * Bridge API: Watchdog health
   * Passkey required. Proxies to watchdog on port 7710.
   */
  app.get('/_auth/bridge/watchdog/health', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    const auth = await requireBridgeAuth(c, ip);
    if (!auth.valid) {
      return c.json(
        { error: auth.error, ...(auth.requiresPasskey ? { requiresPasskey: true } : {}) },
        (auth.status || 401) as any,
      );
    }

    try {
      const resp = await fetch('http://127.0.0.1:7710/health', {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });
      const result = await resp.json();
      return c.json(result, resp.status as any);
    } catch (e) {
      const msg = (e as Error).message;
      const isConnRefused = msg.includes('ECONNREFUSED') || msg.includes('fetch failed');
      if (isConnRefused) {
        return c.json({ error: 'Watchdog service not available', unavailable: true }, 503);
      }
      return c.json({ error: msg }, 500);
    }
  });

  /**
   * Bridge API: Restart core services
   * Passkey required. Restarts enforcer + watchdog.
   */
  app.post('/_auth/bridge/restart-services', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    const auth = await requireBridgeAuth(c, ip);
    if (!auth.valid) {
      return c.json(
        { error: auth.error, ...(auth.requiresPasskey ? { requiresPasskey: true } : {}) },
        (auth.status || 401) as any,
      );
    }

    try {
      const { execSync } = await import('child_process');
      execSync('systemctl restart ellul-enforcer 2>/dev/null || true', { timeout: 10_000 });
      execSync('systemctl restart ellul-watchdog 2>/dev/null || true', { timeout: 10_000 });
      logAuditEvent({ type: 'operation', ip, details: { action: 'restart_services' } });
      cryptoAudit('services_restarted', 'passkey', { services: ['enforcer', 'watchdog'] });
      return c.json({ success: true });
    } catch (e) {
      return c.json({ success: false, error: (e as Error).message }, 500);
    }
  });

  /**
   * Internal API: Validate infrastructure confirmation token
   * Localhost-only — called by file-api to verify X-Infra-Confirm headers.
   * No passkey session required (already validated at token creation time).
   */
  app.post('/_internal/validate-infra-token', async (c) => {
    // Restrict to localhost only
    const ip = getClientIp(c);
    if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const body = await c.req.json().catch(() => ({})) as { token?: string; operation?: string };
    if (!body.token || !body.operation) {
      return c.json({ error: 'Missing token or operation' }, 400);
    }

    const valid = validateConfirmation(body.token, body.operation);
    if (!valid) {
      return c.json({ error: 'Invalid or expired confirmation token' }, 403);
    }

    return c.json({ valid: true });
  });

  // =========================================================================
  //  OPERATOR SIGNATURE VERIFICATION — for destructive/mutating git operations
  //
  //  Link, unlink, and disconnect modify the repo binding. These MUST require
  //  operator signature to prevent agent self-service. The operator private key
  //  exists ONLY in the CLI daemon's volatile RAM (separate OS process from the
  //  MCP agent subprocess). ptrace_scope=1 prevents cross-process memory reads.
  //  This makes agent invocation of these endpoints physically impossible.
  // =========================================================================

  async function requireOperatorSignature(
    c: any,
    signedPayload: string,
    ip: string,
  ): Promise<string | null> {
    const auth = c.get('tierGateAuth') as { sessionId?: string } | undefined;
    const sessionId = auth?.sessionId;
    if (!sessionId) return 'No session';

    const row = db.prepare('SELECT operator_public_key FROM sessions WHERE id = ?')
      .get(sessionId) as { operator_public_key: string | null } | undefined;
    if (!row?.operator_public_key) return 'No operator key bound to session';

    const opSig = c.req.header('x-operator-signature');
    const opTs = c.req.header('x-operator-timestamp');
    if (!opSig || !opTs) return 'Missing operator signature headers';

    const ts = parseInt(opTs, 10);
    if (isNaN(ts) || Math.abs(Date.now() - ts) > OPERATOR_TIMESTAMP_TOLERANCE_MS) {
      return 'Operator timestamp expired';
    }

    const fullPayload = signedPayload + '|' + opTs;
    const valid = await verifyPopSignature(row.operator_public_key, fullPayload, opSig);
    if (!valid) {
      logAuditEvent({ type: 'operator_sig_invalid', ip, details: { payload: signedPayload } });
      return 'Invalid operator signature';
    }
    return null;
  }

  // =========================================================================
  //  GIT PROXY — CLI-initiated git provider management
  //
  //  These routes proxy git API calls from the CLI through the VPS,
  //  authenticating to the platform API with the VPS's aiProxyToken.
  //  The CLI authenticates to the VPS via sovereign-shield session;
  //  the VPS then acts as a trusted intermediary to the API.
  // =========================================================================

  // Lazy-cached disk reads for apiProxyFetch (values are stable post-provisioning)
  let _apiProxyConfig: { apiUrl: string; serverId: string; token: string } | null = null;
  function getApiProxyConfig(): { apiUrl: string; serverId: string; token: string } {
    if (!_apiProxyConfig) {
      _apiProxyConfig = {
        apiUrl: fs.readFileSync('/etc/ellul/api-url', 'utf8').trim(),
        serverId: fs.readFileSync('/etc/ellul-bootstrap/server-id', 'utf8').trim(),
        token: fs.readFileSync('/etc/ellul-bootstrap/ai-proxy-token', 'utf8').trim(),
      };
    }
    return _apiProxyConfig;
  }

  /**
   * Proxy an API request using the VPS's bearer token.
   * Uses cached server-id, api-url, and ai-proxy-token.
   * Retries once on transient failures (502/503/504/timeout).
   * Invalidates cache and retries once on 401 (token rotation).
   */
  async function apiProxyFetch(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<{ status: number; data: any }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { apiUrl, serverId, token } = getApiProxyConfig();
      const url = `${apiUrl}${path.replace('{serverId}', serverId)}`;

      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (fetchErr) {
        // Network error or timeout — retry once after 1s
        if (attempt === 0) {
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        throw fetchErr;
      }

      // 401 = token may have rotated — invalidate cache and retry once
      if (res.status === 401 && attempt === 0) {
        _apiProxyConfig = null;
        continue;
      }

      // Transient server errors — retry once after 1s
      if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt === 0) {
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }

      const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      return { status: res.status, data };
    }

    // Should never reach here, but satisfy TypeScript
    return { status: 500, data: { error: 'Exhausted retries' } };
  }

  /**
   * Bridge API: Get API URL (for CLI to construct OAuth redirect)
   */
  app.get('/_auth/bridge/git-config', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    const auth = await requireBridgeAuth(c, ip);
    if (!auth.valid) {
      return c.json(
        { error: auth.error, ...(auth.requiresPasskey ? { requiresPasskey: true } : {}) },
        (auth.status || 401) as any,
      );
    }

    // OPERATOR SIGNATURE REQUIRED — prevents agent from initiating OAuth flows
    const configSigErr = await requireOperatorSignature(c, 'git-config', ip);
    if (configSigErr) {
      return c.json({ error: configSigErr }, 403);
    }

    try {
      const { apiUrl } = getApiProxyConfig();
      return c.json({ apiUrl });
    } catch {
      return c.json({ error: 'API URL not configured' }, 500);
    }
  });

  /**
   * Bridge API: List connected git providers
   */
  app.get('/_auth/bridge/git-connections', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    const auth = await requireBridgeAuth(c, ip);
    if (!auth.valid) {
      return c.json(
        { error: auth.error, ...(auth.requiresPasskey ? { requiresPasskey: true } : {}) },
        (auth.status || 401) as any,
      );
    }

    try {
      const { status, data } = await apiProxyFetch('GET', '/api/git/connections');
      return c.json(data, status as any);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  });

  /**
   * Bridge API: List repos from connected provider
   */
  app.get('/_auth/bridge/git-repos', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    const auth = await requireBridgeAuth(c, ip);
    if (!auth.valid) {
      return c.json(
        { error: auth.error, ...(auth.requiresPasskey ? { requiresPasskey: true } : {}) },
        (auth.status || 401) as any,
      );
    }

    const provider = c.req.query('provider');
    if (!provider) return c.json({ error: 'provider query param required' }, 400);

    const validRepoProviders = ['github', 'gitlab', 'bitbucket'];
    if (!validRepoProviders.includes(provider)) {
      return c.json({ error: 'Invalid provider' }, 400);
    }

    const search = c.req.query('search') || '';
    const qs = search ? `?search=${encodeURIComponent(search)}` : '';

    try {
      const { status, data } = await apiProxyFetch('GET', `/api/git/servers/{serverId}/repos/${provider}${qs}`);
      return c.json(data, status as any);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  });

  /**
   * Bridge API: Get all linked repos on this server
   */
  app.get('/_auth/bridge/git-links', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    const auth = await requireBridgeAuth(c, ip);
    if (!auth.valid) {
      return c.json(
        { error: auth.error, ...(auth.requiresPasskey ? { requiresPasskey: true } : {}) },
        (auth.status || 401) as any,
      );
    }

    try {
      const { status, data } = await apiProxyFetch('GET', '/api/git/servers/{serverId}/links');
      return c.json(data, status as any);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  });

  /**
   * Bridge API: Link repo to app — then auto-trigger git setup
   */
  app.post('/_auth/bridge/git-link', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    const auth = await requireBridgeAuth(c, ip);
    if (!auth.valid) {
      return c.json(
        { error: auth.error, ...(auth.requiresPasskey ? { requiresPasskey: true } : {}) },
        (auth.status || 401) as any,
      );
    }

    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    if (!body.provider || !body.repoFullName || !body.sandboxId) {
      return c.json({ error: 'provider, repoFullName, and sandboxId are required' }, 400);
    }

    // Idempotency: check if this app already has a linked repo
    try {
      const { status: linksStatus, data: linksData } = await apiProxyFetch('GET', '/api/git/servers/{serverId}/links');
      if (linksStatus < 400) {
        const existingLink = (linksData.links || []).find((l: any) => l.sandboxId === body.sandboxId);
        if (existingLink) {
          if (existingLink.repoFullName === body.repoFullName) {
            return c.json({ error: `${body.repoFullName} is already linked to ${body.sandboxId}` }, 409);
          }
          return c.json({
            error: `${body.sandboxId} is already linked to ${existingLink.repoFullName}. Unlink first with /git-unlink.`,
          }, 409);
        }
      }
    } catch {
      // Non-fatal — let the API handle duplicate detection as fallback
    }

    // OPERATOR SIGNATURE REQUIRED — agent cannot call this endpoint
    const linkSigErr = await requireOperatorSignature(
      c, `git-link|${body.sandboxId}|${body.repoFullName}`, ip,
    );
    if (linkSigErr) {
      return c.json({ error: linkSigErr }, 403);
    }

    try {
      const { status, data } = await apiProxyFetch('POST', '/api/git/servers/{serverId}/link', body);
      if (status >= 400) {
        return c.json(data, status as any);
      }

      // Auto-trigger git setup after successful link
      try {
        await executeGitAction('setup', body.sandboxId as string);
      } catch (setupErr) {
        // Setup failed — roll back the link to prevent inconsistent state
        try {
          await apiProxyFetch('DELETE', `/api/git/servers/{serverId}/link?app=${encodeURIComponent(body.sandboxId as string)}`);
          logAuditEvent({ type: 'operation', ip, details: {
            action: 'git_link_rolled_back', sandboxId: body.sandboxId, repo: body.repoFullName,
            setupError: (setupErr as Error).message,
          }});
        } catch {
          logAuditEvent({ type: 'operation', ip, details: {
            action: 'git_link_rollback_failed', sandboxId: body.sandboxId, repo: body.repoFullName,
            setupError: (setupErr as Error).message,
          }});
          return c.json({
            error: 'Git setup failed and rollback failed. Manually unlink and retry.',
            setupError: (setupErr as Error).message,
          }, 500);
        }
        return c.json({
          error: 'Git setup failed — link rolled back. Fix the issue and retry.',
          setupError: (setupErr as Error).message,
        }, 500);
      }

      logAuditEvent({ type: 'operation', ip, details: { action: 'git_link', sandboxId: body.sandboxId, repo: body.repoFullName } });
      cryptoAudit('git_link', 'passkey', { sandboxId: body.sandboxId, repo: body.repoFullName, provider: body.provider });
      return c.json(data, status as any);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  });

  /**
   * Bridge API: Unlink repo from app — then trigger git teardown
   */
  app.delete('/_auth/bridge/git-link', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    const auth = await requireBridgeAuth(c, ip);
    if (!auth.valid) {
      return c.json(
        { error: auth.error, ...(auth.requiresPasskey ? { requiresPasskey: true } : {}) },
        (auth.status || 401) as any,
      );
    }

    const sandboxId = c.req.query('sandboxId');
    if (!sandboxId) return c.json({ error: 'sandboxId query param required' }, 400);

    // OPERATOR SIGNATURE REQUIRED — agent cannot call this endpoint
    const unlinkSigErr = await requireOperatorSignature(c, `git-unlink|${sandboxId}`, ip);
    if (unlinkSigErr) {
      return c.json({ error: unlinkSigErr }, 403);
    }

    try {
      const { status, data } = await apiProxyFetch('DELETE', `/api/git/servers/{serverId}/link?app=${encodeURIComponent(sandboxId)}`);
      if (status >= 400) {
        return c.json(data, status as any);
      }

      // Trigger git teardown
      try {
        await executeGitAction('teardown', sandboxId);
      } catch {
        // Non-fatal — link already removed
      }

      logAuditEvent({ type: 'operation', ip, details: { action: 'git_unlink', sandboxId } });
      cryptoAudit('git_unlink', 'passkey', { sandboxId });
      return c.json(data, status as any);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  });

  /**
   * Bridge API: Disconnect git provider
   */
  app.delete('/_auth/bridge/git-disconnect/:provider', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    const auth = await requireBridgeAuth(c, ip);
    if (!auth.valid) {
      return c.json(
        { error: auth.error, ...(auth.requiresPasskey ? { requiresPasskey: true } : {}) },
        (auth.status || 401) as any,
      );
    }

    const provider = c.req.param('provider');
    const validProviders = ['github', 'gitlab', 'bitbucket'];
    if (!validProviders.includes(provider)) {
      return c.json({ error: 'Invalid provider' }, 400);
    }

    // OPERATOR SIGNATURE REQUIRED — agent cannot call this endpoint
    const disconnectSigErr = await requireOperatorSignature(c, `git-disconnect|${provider}`, ip);
    if (disconnectSigErr) {
      return c.json({ error: disconnectSigErr }, 403);
    }

    try {
      const { status, data } = await apiProxyFetch('DELETE', `/api/git/connections/${provider}`);
      logAuditEvent({ type: 'operation', ip, details: { action: 'git_disconnect', provider } });
      cryptoAudit('git_disconnect', 'passkey', { provider });
      return c.json(data, status as any);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  });

  // ============================================
  // AI Tools feature toggles (gbrain / gstack)
  // ============================================

  app.get('/_auth/bridge/features', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    const auth = await requireBridgeAuth(c, ip);
    if (!auth.valid) {
      return c.json(
        { error: auth.error, ...(auth.requiresPasskey ? { requiresPasskey: true } : {}) },
        (auth.status || 401) as any,
      );
    }

    try {
      const resp = await fetch('http://127.0.0.1:7700/api/internal/features', {
        headers: { 'Content-Type': 'application/json' },
      });
      const result = await resp.json();
      return c.json(result, resp.status as any);
    } catch (e) {
      const msg = (e as Error).message;
      const isConnRefused = msg.includes('ECONNREFUSED') || msg.includes('fetch failed');
      if (isConnRefused) {
        return c.json({ error: 'Agent bridge not available', unavailable: true }, 503);
      }
      return c.json({ error: msg }, 500);
    }
  });

  app.post('/_auth/bridge/features/toggle', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    const auth = await requireBridgeAuth(c, ip);
    if (!auth.valid) {
      return c.json(
        { error: auth.error, ...(auth.requiresPasskey ? { requiresPasskey: true } : {}) },
        (auth.status || 401) as any,
      );
    }

    const body = await c.req.json().catch(() => ({})) as { feature?: string; enabled?: boolean };
    if (!body.feature || typeof body.feature !== 'string') {
      return c.json({ error: 'Missing feature name' }, 400);
    }

    try {
      const resp = await fetch('http://127.0.0.1:7700/api/internal/features/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feature: body.feature, enabled: !!body.enabled }),
      });
      const result = await resp.json();
      logAuditEvent({ type: 'operation', ip, details: { action: 'feature_toggle', feature: body.feature, enabled: body.enabled } });
      return c.json(result, resp.status as any);
    } catch (e) {
      const msg = (e as Error).message;
      const isConnRefused = msg.includes('ECONNREFUSED') || msg.includes('fetch failed');
      if (isConnRefused) {
        return c.json({ error: 'Agent bridge not available', unavailable: true }, 503);
      }
      return c.json({ error: msg }, 500);
    }
  });

  app.post('/_auth/bridge/features/gbrain-wipe', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    const auth = await requireBridgeAuth(c, ip);
    if (!auth.valid) {
      return c.json(
        { error: auth.error, ...(auth.requiresPasskey ? { requiresPasskey: true } : {}) },
        (auth.status || 401) as any,
      );
    }

    try {
      const resp = await fetch('http://127.0.0.1:7700/api/internal/features/gbrain-wipe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const result = await resp.json();
      logAuditEvent({ type: 'operation', ip, details: { action: 'gbrain_wipe' } });
      return c.json(result, resp.status as any);
    } catch (e) {
      const msg = (e as Error).message;
      const isConnRefused = msg.includes('ECONNREFUSED') || msg.includes('fetch failed');
      if (isConnRefused) {
        return c.json({ error: 'Agent bridge not available', unavailable: true }, 503);
      }
      return c.json({ error: msg }, 500);
    }
  });

  app.post('/_auth/bridge/features/tool-provider', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    const auth = await requireBridgeAuth(c, ip);
    if (!auth.valid) {
      return c.json(
        { error: auth.error, ...(auth.requiresPasskey ? { requiresPasskey: true } : {}) },
        (auth.status || 401) as any,
      );
    }

    try {
      const body = await c.req.json();
      const resp = await fetch('http://127.0.0.1:7700/api/internal/features/tool-provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await resp.json();
      logAuditEvent({ type: 'operation', ip, details: { action: 'tool_provider_set', tool: body?.tool, provider: body?.provider } });
      return c.json(result, resp.status as any);
    } catch (e) {
      const msg = (e as Error).message;
      const isConnRefused = msg.includes('ECONNREFUSED') || msg.includes('fetch failed');
      if (isConnRefused) {
        return c.json({ error: 'Agent bridge not available', unavailable: true }, 503);
      }
      return c.json({ error: msg }, 500);
    }
  });

  app.post('/_auth/bridge/features/connector-key', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    const auth = await requireBridgeAuth(c, ip);
    if (!auth.valid) {
      return c.json(
        { error: auth.error, ...(auth.requiresPasskey ? { requiresPasskey: true } : {}) },
        (auth.status || 401) as any,
      );
    }

    try {
      const body = await c.req.json();
      const resp = await fetch('http://127.0.0.1:7700/api/internal/features/connector-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await resp.json();
      logAuditEvent({ type: 'operation', ip, details: { action: 'connector_save_key', provider: body?.provider } });
      return c.json(result, resp.status as any);
    } catch (e) {
      const msg = (e as Error).message;
      const isConnRefused = msg.includes('ECONNREFUSED') || msg.includes('fetch failed');
      if (isConnRefused) {
        return c.json({ error: 'Agent bridge not available', unavailable: true }, 503);
      }
      return c.json({ error: msg }, 500);
    }
  });

  app.post('/_auth/bridge/features/connector-key-remove', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    const auth = await requireBridgeAuth(c, ip);
    if (!auth.valid) {
      return c.json(
        { error: auth.error, ...(auth.requiresPasskey ? { requiresPasskey: true } : {}) },
        (auth.status || 401) as any,
      );
    }

    try {
      const body = await c.req.json();
      const resp = await fetch('http://127.0.0.1:7700/api/internal/features/connector-key-remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await resp.json();
      logAuditEvent({ type: 'operation', ip, details: { action: 'connector_remove_key', provider: body?.provider } });
      return c.json(result, resp.status as any);
    } catch (e) {
      const msg = (e as Error).message;
      const isConnRefused = msg.includes('ECONNREFUSED') || msg.includes('fetch failed');
      if (isConnRefused) {
        return c.json({ error: 'Agent bridge not available', unavailable: true }, 503);
      }
      return c.json({ error: msg }, 500);
    }
  });

  // =========================================================================
  //  DISPATCH — single endpoint for Tauri Android (replaces iframe bridge)
  // =========================================================================

  type D = Record<string, unknown>;
  type RouteSpec = {
    m: string;
    p: string | ((d: D) => string);
    b?: (d: D) => unknown;
    t?: (res: unknown, d: D) => unknown;
  };

  const enc = (v: unknown) => encodeURIComponent(String(v ?? ''));

  const DISPATCH_ROUTES: Record<string, RouteSpec> = {
    check_session:       { m: 'GET', p: '/_auth/bridge/session', t: (r: any) => ({ hasSession: r?.valid === true }) },
    session_keepalive:   { m: 'POST', p: '/_auth/session/keepalive' },
    get_auth_options:    { m: 'POST', p: '/_auth/login/options' },
    verify_auth:         { m: 'POST', p: '/_auth/login/verify', b: d => ({ assertion: d.assertion }) },
    get_registration_options: { m: 'POST', p: d => String(d.endpoint || '/_auth/upgrade-to-web-locked'), b: d => ({ name: d.name }) },
    verify_registration: { m: 'POST', p: d => String(d.endpoint || '/_auth/upgrade-to-web-locked/verify'), b: d => ({ attestation: d.attestation, name: d.name, prfEnabled: d.prfEnabled }) },
    get_ssh_keys:        { m: 'GET', p: '/_auth/bridge/keys', t: r => ({ keys: r }) },
    add_ssh_key:         { m: 'POST', p: '/_auth/keys', b: d => ({ name: d.name, publicKey: d.publicKey }) },
    remove_ssh_key:      { m: 'DELETE', p: d => `/_auth/keys/${enc(d.fingerprint)}`, t: (_, d) => ({ fingerprint: d.fingerprint }) },
    get_passkeys:        { m: 'GET', p: '/_auth/bridge/passkeys', t: r => ({ passkeys: r }) },
    remove_passkey:      { m: 'DELETE', p: d => `/_auth/bridge/passkey/${enc(d.credentialId)}`, t: (_, d) => ({ credentialId: d.credentialId }) },
    register_passkey:    { m: 'GET', p: '/_auth/bridge/passkeys', t: () => ({ requiresPopup: true, popupUrl: '/_auth/standard-upgrade', message: 'Open popup to register passkey' }) },
    upgrade_to_web_locked: { m: 'GET', p: '/_auth/bridge/passkeys', t: () => ({ requiresPopup: true, popupUrl: '/_auth/standard-upgrade', message: 'Open popup to register passkey' }) },
    get_current_tier:    { m: 'GET', p: '/_auth/bridge/tier' },
    downgrade_to_standard: { m: 'POST', p: '/_auth/bridge/downgrade-to-standard' },
    switch_to_web_locked: { m: 'POST', p: '/_auth/bridge/switch-tier', b: () => ({ targetTier: 'web_locked' }) },
    confirm_operation:   { m: 'POST', p: '/_auth/confirm-operation', b: d => ({ operation: d.operation }) },
    exchange_session:    { m: 'POST', p: '/_auth/session/exchange', b: d => ({ exchangeCode: d.exchangeCode }) },
    get_code_token:      { m: 'POST', p: '/_auth/code/authorize' },
    get_code_session:    { m: 'POST', p: '/_auth/code/session' },
    get_exchange_code:   { m: 'POST', p: '/_auth/bridge/exchange-code' },
    get_agent_token:     { m: 'POST', p: '/_auth/agent/authorize' },
    get_terminal_token:  { m: 'POST', p: '/_auth/terminal/authorize' },
    get_preview_token:   { m: 'POST', p: '/_auth/preview/authorize' },
    get_settings:        { m: 'GET', p: '/_auth/bridge/settings' },
    toggle_terminal:     { m: 'POST', p: '/_auth/bridge/toggle-terminal', b: d => ({ enabled: d.enabled }) },
    toggle_ssh:          { m: 'POST', p: '/_auth/bridge/toggle-ssh', b: d => ({ enabled: d.enabled }) },
    set_view_mode:       { m: 'POST', p: '/_auth/bridge/set-view-mode', b: d => ({ mode: d.mode }) },
    set_ui_mode:         { m: 'POST', p: '/_auth/bridge/set-ui-mode', b: d => ({ mode: d.mode }) },
    set_secret:          { m: 'POST', p: '/_auth/secrets', b: d => ({ ...d }) },
    delete_secret:       { m: 'DELETE', p: d => `/_auth/secrets/${enc(d.name)}${d.sandboxId ? '?sandboxId=' + enc(d.sandboxId) : ''}` },
    list_secrets:        { m: 'GET', p: d => { const p = new URLSearchParams(); if (d.sandboxId) p.set('sandboxId', String(d.sandboxId)); if (d.env) p.set('env', String(d.env)); const q = p.toString(); return '/_auth/secrets' + (q ? '?' + q : ''); } },
    read_secret_values:  { m: 'GET', p: d => { const p = new URLSearchParams(); if (d.sandboxId) p.set('sandboxId', String(d.sandboxId)); if (d.env) p.set('env', String(d.env)); const q = p.toString(); return '/_auth/secrets/values' + (q ? '?' + q : ''); } },
    set_secrets_bulk:    { m: 'POST', p: '/_auth/secrets/bulk', b: d => ({ secrets: d.secrets, ...(d.sandboxId ? { sandboxId: d.sandboxId } : {}) }) },
    authorize_git_link:  { m: 'POST', p: '/_auth/git/authorize-link', b: d => ({ repoFullName: d.repoFullName, provider: d.provider }) },
    authorize_git_unlink: { m: 'POST', p: '/_auth/git/authorize-unlink', b: () => ({}) },
    kill_ports:          { m: 'POST', p: '/_auth/bridge/kill-ports', b: d => ({ ports: d.ports }) },
    git_action:          { m: 'POST', p: '/_auth/bridge/git-action', b: d => ({ action: d.action, sandboxId: d.sandboxId }) },
    switch_deployment:   { m: 'POST', p: '/_auth/bridge/switch-deployment', b: d => ({ ...d }) },
    confirm_infra:       { m: 'POST', p: '/_auth/bridge/confirm-infra', b: d => ({ operation: d.operation }) },
    reset_heartbeat:     { m: 'POST', p: '/_auth/bridge/reset-heartbeat' },
    db_status:           { m: 'GET', p: '/_auth/db/status' },
    db_info:             { m: 'GET', p: d => `/_auth/db/info?sandboxId=${enc(d.sandboxId)}` },
    db_provision:        { m: 'POST', p: '/_auth/db/provision', b: d => ({ sandboxId: d.sandboxId }) },
    db_delete:           { m: 'POST', p: '/_auth/db/delete', b: d => ({ sandboxId: d.sandboxId }) },
    db_list:             { m: 'GET', p: d => `/_auth/db/list?sandboxId=${enc(d.sandboxId)}` },
    db_schema:           { m: 'GET', p: d => `/_auth/db/schema?sandboxId=${enc(d.sandboxId)}&database=${enc(d.database)}` },
    db_query:            { m: 'POST', p: '/_auth/db/query', b: d => ({ sandboxId: d.sandboxId, sql: d.sql, database: d.database }) },
    db_execute:          { m: 'POST', p: '/_auth/db/execute', b: d => ({ sandboxId: d.sandboxId, sql: d.sql, database: d.database }) },
    db_create:           { m: 'POST', p: '/_auth/db/create', b: d => ({ sandboxId: d.sandboxId, label: d.label }) },
    db_drop:             { m: 'POST', p: '/_auth/db/drop', b: d => ({ sandboxId: d.sandboxId, label: d.label }) },
    db_assign:           { m: 'POST', p: '/_auth/db/assign', b: d => ({ sandboxId: d.sandboxId, label: d.label, role: d.role }) },
    db_backups:          { m: 'GET', p: d => `/_auth/db/backups?sandboxId=${enc(d.sandboxId)}` },
    db_backup:           { m: 'POST', p: '/_auth/db/backup', b: d => ({ sandboxId: d.sandboxId }) },
    db_restore:          { m: 'POST', p: '/_auth/db/restore', b: d => ({ sandboxId: d.sandboxId, file: d.file }) },
    cross_project_list:  { m: 'GET', p: '/_auth/cross-project-access' },
    cross_project_grant: { m: 'POST', p: '/_auth/cross-project-access', b: d => ({ sandboxId: d.sandboxId, sharedSandboxId: d.sharedSandboxId, sharePreview: !!d.sharePreview }) },
    cross_project_revoke: { m: 'DELETE', p: '/_auth/cross-project-access', b: d => ({ sandboxId: d.sandboxId, sharedSandboxId: d.sharedSandboxId }) },
    audit_log:           { m: 'GET', p: '/_auth/audit' },
    audit_verify:        { m: 'GET', p: '/_auth/audit/verify' },
    secrets_exposures:   { m: 'GET', p: d => `/_auth/secrets/exposures?sandboxId=${enc(d.sandboxId)}` },
    secrets_classify:    { m: 'PUT', p: '/_auth/secrets/classify', b: d => ({ keyName: d.name, kind: d.kind, sandboxId: d.sandboxId }) },
    secrets_acknowledge: { m: 'POST', p: '/_auth/secrets/acknowledge', b: d => ({ keyName: d.name, sandboxId: d.sandboxId }) },
    guardrail_rules:     { m: 'GET', p: '/_auth/guardrail/rules' },
    guardrail_proposals: { m: 'GET', p: '/_auth/guardrail/proposals' },
    guardrail_toggle:    { m: 'PATCH', p: d => `/_auth/guardrail/rules/${enc(d.id)}/toggle`, b: d => ({ enabled: d.enabled }) },
    guardrail_delete:    { m: 'DELETE', p: d => `/_auth/guardrail/rules/${enc(d.id)}` },
    guardrail_create:    { m: 'POST', p: '/_auth/guardrail/rules', b: d => d.rule as D },
    guardrail_proposal_approve: { m: 'POST', p: d => `/_auth/guardrail/proposals/${enc(d.id)}/approve` },
    guardrail_proposal_deny:    { m: 'POST', p: d => `/_auth/guardrail/proposals/${enc(d.id)}/deny` },
    watchdog_health:     { m: 'GET', p: '/_auth/bridge/watchdog/health' },
    agents_auth_status:  { m: 'GET', p: '/_auth/bridge/agents/auth-status' },
    restart_services:    { m: 'POST', p: '/_auth/bridge/restart-services' },
    permission_list_pending: { m: 'GET', p: d => `/_auth/permissions/pending${d.threadId ? '?threadId=' + enc(d.threadId) : ''}` },
    permission_get:      { m: 'GET', p: d => `/_auth/permissions/${enc(d.id)}` },
    permission_history:  { m: 'GET', p: d => `/_auth/permissions/history?threadId=${enc(d.threadId)}` },
    permission_mark_seen: { m: 'POST', p: d => `/_auth/permissions/${enc(d.id)}/seen` },
    gate_respond:        { m: 'POST', p: '/_auth/gates/respond', b: d => { const b: D = { requestId: d.gateRequestId, action: d.action, operatorSignature: d.operatorSignature, operatorTimestamp: d.operatorTimestamp }; if (d.metadata !== undefined) b.metadata = d.metadata; if (d.intentSignature) b.intentSignature = d.intentSignature; if (d.intentNonce) b.intentNonce = d.intentNonce; if (d.intentType) b.intentType = d.intentType; return b; } },
    gate_revoke:         { m: 'POST', p: '/_auth/gates/revoke', b: d => ({ gate: d.gate, project: d.project, operatorSignature: d.operatorSignature, operatorTimestamp: d.operatorTimestamp }) },
    gate_set_permission: { m: 'POST', p: '/_auth/gates/permissions', b: d => ({ gate: d.gate, project: d.project, policy: d.policy, operatorSignature: d.operatorSignature, operatorTimestamp: d.operatorTimestamp }) },
    gate_operator_status: { m: 'GET', p: '/_auth/gates/operator-status' },
    gate_bind_nonce:     { m: 'GET', p: '/_auth/gates/bind-nonce' },
    gate_bind_operator:  { m: 'POST', p: '/_auth/gates/bind-operator', b: d => ({ ...d }) },
    context_mode_get:    { m: 'GET', p: d => `/_auth/context-mode?project=${enc(d.project)}` },
    context_mode_set:    { m: 'POST', p: '/_auth/context-mode', b: d => ({ project: d.project, mode: d.mode, operatorSignature: d.operatorSignature, operatorTimestamp: d.operatorTimestamp }) },
    tool_permission_set: { m: 'POST', p: '/_auth/tool-permissions', b: d => ({ connectionId: d.connectionId, toolName: d.toolName, permission: d.permission, operatorSignature: d.operatorSignature, operatorTimestamp: d.operatorTimestamp }) },
    tool_permission_reset: { m: 'POST', p: '/_auth/tool-permissions/reset', b: d => ({ connectionId: d.connectionId, toolName: d.toolName, operatorSignature: d.operatorSignature, operatorTimestamp: d.operatorTimestamp }) },
    intent_nonce:        { m: 'GET', p: d => { let qs = `action=${enc(d.action)}`; if (typeof d.resource === 'string' && d.resource) qs += `&resource=${enc(d.resource)}`; return `/_auth/intent/nonce?${qs}`; } },
    features_get:        { m: 'GET', p: '/_auth/bridge/features' },
    features_toggle:     { m: 'POST', p: '/_auth/bridge/features/toggle', b: d => ({ feature: d.feature, enabled: !!d.enabled }) },
    gbrain_wipe:         { m: 'POST', p: '/_auth/bridge/features/gbrain-wipe' },
    tool_provider_set:   { m: 'POST', p: '/_auth/bridge/features/tool-provider', b: d => ({ tool: d.tool, provider: d.provider }) },
    connector_save_key:  { m: 'POST', p: '/_auth/bridge/features/connector-key', b: d => ({ provider: d.provider, apiKey: d.apiKey }) },
    connector_remove_key: { m: 'POST', p: '/_auth/bridge/features/connector-key-remove', b: d => ({ provider: d.provider }) },
    inject_token:        { m: 'GET', p: '/_auth/bridge/session', t: () => ({ ok: true }) },
  };

  async function dispatchInternal(
    app: Hono,
    c: any,
    method: string,
    path: string,
    body?: string,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    const cookie = c.req.header('cookie');
    if (cookie) headers['Cookie'] = cookie;
    if (body) headers['Content-Type'] = 'application/json';
    for (const h of ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip', 'user-agent']) {
      const v = c.req.header(h);
      if (v) headers[h] = v;
    }
    if (extraHeaders) Object.assign(headers, extraHeaders);
    return app.request(path, { method, headers, body: body || undefined });
  }

  app.post('/_auth/bridge/dispatch', async (c) => {
    let parsed: any;
    try { parsed = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    const { type, ...data } = parsed;
    if (!type || typeof type !== 'string') return c.json({ error: 'Missing type' }, 400);

    // STS-requiring gate routes: mint token then forward
    if (type === 'gate_list_active' || type === 'gate_request') {
      if (!data.project || typeof data.project !== 'string') {
        return c.json({ error: `${type}: project required` }, 400);
      }
      const stsRes = await dispatchInternal(app, c, 'POST', '/_auth/sts/token', JSON.stringify({ slug: data.project }));
      if (!stsRes.ok) {
        const stsErr = await stsRes.json().catch(() => ({}));
        return c.json(stsErr, stsRes.status as any);
      }
      const stsData = await stsRes.json() as { token: string };

      if (type === 'gate_list_active') {
        const res = await dispatchInternal(app, c, 'GET', '/_auth/gates/active', undefined, { 'X-STS-Token': stsData.token });
        return c.json(await res.json(), res.status as any);
      }
      if (type === 'gate_request') {
        if (!data.gate || typeof data.gate !== 'string') return c.json({ error: 'gate_request: gate required' }, 400);
        const body = JSON.stringify({ gate: data.gate, reason: typeof data.reason === 'string' ? data.reason : '' });
        const res = await dispatchInternal(app, c, 'POST', '/_auth/gates/request', body, { 'X-STS-Token': stsData.token });
        return c.json(await res.json(), res.status as any);
      }
    }

    // code_api_proxy: forward to file-api on localhost via internal JWT
    if (type === 'code_api_proxy') {
      const { method = 'GET', path: reqPath, body: reqBody } = data as { method?: string; path?: string; body?: unknown };
      if (!reqPath || typeof reqPath !== 'string') return c.json({ error: 'code_api_proxy: path required' }, 400);
      const internalJwt = createJwtToken({ purpose: 'internal' }, 60);
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${internalJwt}`,
        'Accept': 'application/json',
      };
      if (reqBody) headers['Content-Type'] = 'application/json';
      try {
        const res = await fetch(`http://127.0.0.1:3002${reqPath}`, {
          method: String(method).toUpperCase(),
          headers,
          body: reqBody ? JSON.stringify(reqBody) : undefined,
        });
        const json = await res.json().catch(() => ({}));
        return c.json(json, res.status as any);
      } catch (e) {
        return c.json({ error: (e as Error).message }, 502);
      }
    }

    const route = DISPATCH_ROUTES[type];
    if (!route) return c.json({ error: `Unknown type: ${type}`, success: false }, 400);

    const path = typeof route.p === 'function' ? route.p(data) : route.p;
    const body = route.b ? JSON.stringify(route.b(data)) : undefined;
    const res = await dispatchInternal(app, c, route.m, path, body);
    const json = await res.json().catch(() => ({}));

    if (!res.ok) return c.json(json, res.status as any);
    return c.json(route.t ? route.t(json, data) : json);
  });

  // =========================================================================
  //  TAURI TOKEN LOGIN — creates shield session from verified platform JWT
  //  Used by Tauri Android where native passkey ceremony is unavailable.
  //  Security: JWT is platform-signed (proves server ownership), session
  //  gets full PoP binding via shield_set_session on the client side.
  // =========================================================================

  app.post('/_auth/tauri/token-login', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) return c.json({ error: 'Too many requests' }, 429);

    const jwt = verifyJwtToken(c.req);
    if (!jwt) return c.json({ error: 'Invalid or expired token' }, 401);

    const session = createSession('jwt-tauri-user', ip, null);
    setSessionCookie(c, session.id, hostname);

    return c.json({ success: true, sessionId: session.id, expiresAt: session.expires_at });
  });

  // =========================================================================
  //  INTERNAL — localhost-only endpoints (no session required)
  // =========================================================================

  /**
   * POST /_internal/git-setup
   * Localhost-only — called by file-api to trigger git credential sync + setup.
   * Used as a fallback when the bridge WebSocket setup didn't run.
   * SECURITY: Blocked on web_locked tier — git setup must go through passkey bridge.
   */
  app.post('/_internal/git-setup', async (c) => {
    // Auth: IPC token + ACL (enforcer only). No IP check needed —
    // requireInternalTokenMiddleware already validates the caller is an
    // authorized service with a valid per-service token.

    const tier = getCurrentTier();
    if (tier !== 'standard') {
      return c.json({ error: 'Web locked tier requires passkey authentication for git setup' }, 403);
    }

    const body = await c.req.json().catch(() => ({})) as { sandboxId?: string };
    if (!body.sandboxId) {
      return c.json({ error: 'Missing sandboxId' }, 400);
    }

    try {
      const result = await executeGitAction('setup', body.sandboxId);
      return c.json({ success: true, output: result.output });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });
}
