// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Forward auth (Caddy), session management, PoP binding.

import fs from 'fs';
import type { Hono } from 'hono';
import { db } from '../database';
import { getCurrentTier } from '../application/gates/Tier';
import { logAuditEvent } from '../application/audit/Audit';
import { verifyJwtToken } from '../auth/jwt';
import { getDeviceFingerprint, getClientIp, isNavigationRequest } from '../auth/fingerprint';
import {
  validateSession,
  refreshSession,
  setSessionCookie,
  clearSessionCookie,
  consumeExchangeCode,
  type Session,
} from '../auth/session';
import {
  verifyPopSignature,
  verifyForwardAuthPoP,
  SESSION_POP_JS,
  SESSION_POP_SW_JS,
  TERMINAL_INIT_JS,
  TERMINAL_WRAPPER_HTML,
  SESSION_POP_MAP,
  SESSION_POP_SW_MAP,
  TERMINAL_INIT_MAP,
} from '../auth/pop';
import { POP_CLIENT_MANIFEST } from '../../pop-client-manifest';
import { parseCookies } from '../utils/cookie';
import { generateCspNonce, getCspHeader } from '../utils/csp';
import { validatePreviewCredentials } from './preview.routes';
import crypto from 'crypto';
import { getTokenForService } from '../application/credentials/InternalToken';
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  storeChallenge,
  getChallenge,
  buildAllowCredentials,
  type CredentialRecord,
} from '../auth/webauthn';
import { RP_NAME as _RP_NAME, readAllowedOrigins, resolveRpId, APP_ZONE } from '../config';

/**
 * Device id shape check — 16+ lowercase hex chars, or 'legacy-v1' for the
 * pre-per-device migration shim. Anything else is rejected to keep the
 * (session_id, device_id) primary key well-formed.
 */
function isValidDeviceId(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  if (v === 'legacy-v1') return true;
  return /^[0-9a-f]{16,64}$/.test(v);
}

const BRIDGE_PORT = 7700;

// HMAC-signed so file-api can reject crafted X-Auth-* headers that bypass Caddy.
// Key = file-api internal token (rotated 30min). Message = "user|tier|session|timestamp".
function setForwardAuthHeaders(
  c: { header: (name: string, value: string) => void },
  user: string,
  tier: string,
  session: string,
): void {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message = `${user}|${tier}|${session}|${timestamp}`;
  const hmacKey = getTokenForService('file-api');
  const hmac = crypto.createHmac('sha256', hmacKey).update(message).digest('hex');

  c.header('X-Auth-User', user);
  c.header('X-Auth-Tier', tier);
  c.header('X-Auth-Session', session);
  c.header('X-Auth-Timestamp', timestamp);
  c.header('X-Auth-HMAC', hmac);
}

// Fire-and-forget; bridge may be offline.
function notifyBridgeSessionRevoked(sessionId?: string, reason = 'owner_revoked'): void {
  fetch(`http://127.0.0.1:${BRIDGE_PORT}/api/internal/session-revoked`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Token': getTokenForService('agent-bridge'),
    },
    body: JSON.stringify({ sessionId, reason }),
  }).catch(() => {});
}

export function registerSessionRoutes(app: Hono, hostname: string): void {
  // Tier-aware forward auth (Caddy).
  app.get('/api/auth/session', async (c) => {
    // Stale 401s cause reload loops until force-refresh.
    c.header('Cache-Control', 'no-store');

    const tier = getCurrentTier();
    const forwardedUri = c.req.header('x-forwarded-uri') || '/';

    // Terminal gate: require _term_token (initial) or _term_auth cookie. term-proxy does real auth.
    if (forwardedUri.startsWith('/term/') || forwardedUri.startsWith('/ttyd/') || forwardedUri.startsWith('/terminal/')) {
      let hasTermToken = false;
      try {
        const uriParams = new URLSearchParams(forwardedUri.split('?')[1] || '');
        hasTermToken = uriParams.has('_term_token');
      } catch {}

      const reqCookies = parseCookies(c.req.header('cookie'));
      const hasTermAuth = !!reqCookies._term_auth;

      if (!hasTermToken && !hasTermAuth) {
        const acceptHeader = c.req.header('accept') || '';
        const isWsUpgrade = c.req.header('upgrade')?.toLowerCase() === 'websocket';
        // ttyd's internal /token endpoint sets no Accept header — detect by path.
        const isTtydTokenRefresh = forwardedUri.match(/\/term\/[^/]+\/token$/);
        const isApiRequest = isWsUpgrade ||
          isTtydTokenRefresh ||
          acceptHeader.includes('application/json') ||
          c.req.header('x-requested-with') === 'XMLHttpRequest';

        if (isApiRequest) {
          return c.json({ error: 'Terminal authentication required' }, 401);
        }

        const wrapperUrl = `https://${hostname}/_auth/terminal/wrapper?target=${encodeURIComponent(forwardedUri)}`;
        return c.redirect(wrapperUrl, 302);
      }

      setForwardAuthHeaders(c, 'terminal-user', tier, reqCookies.shield_session || 'term-proxy');
      return c.json({ authenticated: true, tier, method: 'terminal_gated' }, 200);
    }

    const cookies = parseCookies(c.req.header('cookie'));
    const forwardedHost = c.req.header('x-forwarded-host') || hostname;
    const forwardedProto = c.req.header('x-forwarded-proto') || 'https';
    const originalUrl = `${forwardedProto}://${forwardedHost}${forwardedUri}`;

    // Dev domain (ellul.app): preview token/session (JWT cookies don't flow .ellul.ai → .ellul.app).
    const isDevDomainRequest = forwardedHost.endsWith(`.${APP_ZONE}`);
    if (isDevDomainRequest) {
      const previewSessionId = cookies['__Host-preview_session'];

      let previewToken: string | undefined;
      try {
        const uriParams = new URLSearchParams(forwardedUri.split('?')[1] || '');
        previewToken = uriParams.get('_preview_token') || undefined;
      } catch {}

      if (previewSessionId || previewToken) {
        const validateData = validatePreviewCredentials({
          previewSessionId: previewSessionId || undefined,
          token: previewToken || undefined,
          ip: getClientIp(c),
        });

        if (validateData.valid) {
          // If this was a token (not cookie), set the __Host-preview_session cookie
          // and redirect to clean URL
          if (previewToken && validateData.previewSessionId) {
            const maxAge = Math.floor((validateData.expiresAt - Date.now()) / 1000);
            // __Host + SameSite=None + Partitioned (CHIPS): required for cross-site iframe
            // (console.ellul.ai → *.ellul.app), ITP-exempt on Safari 17+/Chrome 114+.
            c.header('Set-Cookie',
              `__Host-preview_session=${validateData.previewSessionId}; Path=/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=${maxAge}`
            );

            const acceptHeader = c.req.header('accept') || '';
            const isApiRequest = acceptHeader.includes('application/json') ||
              c.req.header('x-requested-with') === 'XMLHttpRequest';

            if (!isApiRequest) {
              const urlObj = new URL(originalUrl);
              urlObj.searchParams.delete('_preview_token');
              return c.redirect(urlObj.toString(), 302);
            }
          }

          setForwardAuthHeaders(c, 'preview-user', tier, previewSessionId || validateData.previewSessionId || 'preview');
          return c.json({ authenticated: true, tier, method: 'preview' }, 200);
        }
      }

      const acceptHeader = c.req.header('accept') || '';
      const isApiRequest = acceptHeader.includes('application/json') ||
        c.req.header('x-requested-with') === 'XMLHttpRequest' ||
        c.req.header('upgrade')?.toLowerCase() === 'websocket';

      if (isApiRequest) {
        return c.json({
          error: 'Preview authentication required',
          loginUrl: `https://${hostname}/_auth/login?redirect=${encodeURIComponent(originalUrl)}`,
        }, 401);
      }

      return c.redirect(
        `https://${hostname}/_auth/login?redirect=${encodeURIComponent(originalUrl)}`,
        302
      );
    }

    // Code subdomain: code_session, X-Code-Token, or JWT — runs before tier split.
    const isCodeSubdomain = forwardedHost.includes('-code.') || forwardedHost.startsWith('code.');

    if (isCodeSubdomain) {
      const codeTokenHeader = c.req.header('x-code-token');
      if (codeTokenHeader) {
        try {
          const validateRes = await fetch('http://127.0.0.1:3005/_auth/code/validate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: codeTokenHeader })
          });
          const validateData = await validateRes.json() as { valid?: boolean; sessionId?: string; tier?: string };

          if (validateData.valid) {
            // SECURITY: require tier from validation; never fall back to getCurrentTier() (downgrade).
            const validatedTier = validateData.tier;
            if (validatedTier !== 'standard' && validatedTier !== 'web_locked' && validatedTier !== 'private_locked') {
              console.error('[shield] SECURITY: Code token validation returned invalid/missing tier:', validatedTier);
              return c.json({ error: 'Security verification failed' }, 500);
            }
            setForwardAuthHeaders(c, validateData.sessionId || 'code-user', validatedTier, 'code-token');
            return c.json({ authenticated: true, tier: validatedTier }, 200);
          }
        } catch (e) {
          // SECURITY: hard deny on validation error — falling through would let web_locked auth via JWT.
          console.error('[shield] SECURITY: Code token validation failed:', (e as Error).message);
          return c.json({ error: 'Code session validation unavailable' }, 503);
        }
      }

      let codeSessionId = cookies['__Host-code_session'] || cookies.code_session;
      let codeSessionFromUrl = false;

      if (!codeSessionId) {
        try {
          const uriParams = new URLSearchParams(forwardedUri.split('?')[1] || '');
          const urlCodeSession = uriParams.get('_code_session');
          if (urlCodeSession) {
            codeSessionId = urlCodeSession;
            codeSessionFromUrl = true;
          }
        } catch {}
      }

      if (codeSessionId) {
        try {
          const validateRes = await fetch('http://127.0.0.1:3005/_auth/code/session/validate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ codeSessionId, ip: getClientIp(c) })
          });
          const validateData = await validateRes.json() as { valid?: boolean; credentialId?: string; tier?: string };

          if (validateData.valid) {
            const validatedTier = validateData.tier;
            if (validatedTier !== 'standard' && validatedTier !== 'web_locked' && validatedTier !== 'private_locked') {
              console.error('[shield] SECURITY: Code session validation returned invalid/missing tier:', validatedTier);
              return c.json({ error: 'Security verification failed' }, 500);
            }

            if (codeSessionFromUrl) {
              c.header('Set-Cookie', `__Host-code_session=${codeSessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=1800`);

              const acceptHeader = c.req.header('accept') || '';
              const isApiRequest = acceptHeader.includes('application/json') ||
                c.req.header('x-requested-with') === 'XMLHttpRequest' ||
                forwardedUri.startsWith('/api/');

              if (!isApiRequest) {
                const urlObj = new URL(originalUrl);
                urlObj.searchParams.delete('_code_session');
                return c.redirect(urlObj.toString(), 302);
              }
            }

            setForwardAuthHeaders(c, validateData.credentialId || 'code-user', validatedTier, codeSessionId);
            return c.json({ authenticated: true, tier: validatedTier }, 200);
          }
        } catch (e) {
          console.error('[shield] SECURITY: Code session validation failed:', (e as Error).message);
          return c.json({ error: 'Code session validation unavailable' }, 503);
        }
      }

      // JWT fallback is standard-tier only; web_locked MUST use code session (passkey-issued).
      if (tier === 'standard') {
        const jwtPayload = verifyJwtToken(c.req);
        if (jwtPayload) {
          setForwardAuthHeaders(c, jwtPayload.sub || 'user', 'standard', jwtPayload.jti || 'jwt');
          return c.json({ authenticated: true, tier: 'standard' }, 200);
        }
      }

      const codeAuthUrl = `https://${hostname}/_auth/code/redirect?target=${encodeURIComponent(originalUrl)}`;

      const acceptHeader = c.req.header('accept') || '';
      const isWsUpgrade = c.req.header('upgrade')?.toLowerCase() === 'websocket';
      const isApiRequest = isWsUpgrade ||
        forwardedUri === '/ws' ||
        acceptHeader.includes('application/json') ||
        c.req.header('x-requested-with') === 'XMLHttpRequest' ||
        forwardedUri.startsWith('/api/') ||
        forwardedUri.includes('/apps') ||
        forwardedUri.includes('/status') ||
        forwardedUri.includes('/tree') ||
        forwardedUri.includes('/preview');

      if (isApiRequest) {
        return c.json({
          error: 'Code session required',
          codeAuthUrl,
          hint: 'Get a code session via /_auth/code/session endpoint first'
        }, 401);
      }
      return c.redirect(codeAuthUrl, 302);
    }

    // Standard tier on main domain: JWT required; no anonymous fallback.
    if (tier === 'standard') {
      const jwtPayload = verifyJwtToken(c.req);
      if (jwtPayload) {
        setForwardAuthHeaders(c, jwtPayload.sub || 'user', 'standard', jwtPayload.jti || 'jwt');
        return c.json({ authenticated: true, tier: 'standard' }, 200);
      }

      // No JWT — check one-time exchange code (SameSite=Lax cookies don't flow to iframe).
      try {
        const uriParams = new URLSearchParams(forwardedUri.split('?')[1] || '');
        const exchangeCode = uriParams.get('_shield_code');
        if (exchangeCode) {
          const exchangeData = consumeExchangeCode(exchangeCode);
          if (exchangeData && exchangeData.tier === 'standard' && exchangeData.jwt) {
            const cookieHost = forwardedHost || hostname;
            c.header('Set-Cookie',
              `terminal_token=${exchangeData.jwt}; Domain=.${cookieHost.split('.').slice(-2).join('.')}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`
            );

            const urlObj = new URL(originalUrl);
            urlObj.searchParams.delete('_shield_code');
            const cleanUrl = urlObj.toString();

            return c.redirect(cleanUrl, 302);
          }
        }
      } catch {}

      return c.json({ error: 'Authentication required' }, 401);
    }

    // Web Locked: passkey + PoP.
    let sessionId = cookies.shield_session;
    let sessionFromUrl = false;

    // Exchange codes: single-use, 30s TTL — avoid session-ID leakage via history/referer/logs.
    if (!sessionId) {
      try {
        const uriParams = new URLSearchParams(forwardedUri.split('?')[1] || '');
        const exchangeCode = uriParams.get('_shield_code');
        if (exchangeCode) {
          const exchangeData = consumeExchangeCode(exchangeCode);
          // Defense-in-depth: explicitly reject standard-tier codes on this branch.
          if (exchangeData && exchangeData.tier !== 'standard' && exchangeData.sessionId) {
            sessionId = exchangeData.sessionId;
            sessionFromUrl = true;
          }
        }
      } catch {}
    }

    const loginUrl = `https://${hostname}/_auth/login?redirect=${encodeURIComponent(originalUrl)}`;

    const acceptHeader = c.req.header('accept') || '';
    // /_auth/chat is the only /_auth/* that serves HTML; all others are JSON APIs (must not 302).
    const forwardedPath = forwardedUri.split('?')[0];
    const AUTH_HTML_PAGES = ['/_auth/chat'];
    const isAuthApiPath = forwardedUri.startsWith('/_auth/') && !AUTH_HTML_PAGES.includes(forwardedPath!);
    const isApiRequest = acceptHeader.includes('application/json') ||
      c.req.header('x-requested-with') === 'XMLHttpRequest' ||
      forwardedUri.startsWith('/api/') ||
      isAuthApiPath ||
      forwardedUri.includes('/context') ||
      forwardedUri.includes('/apps') ||
      forwardedUri.includes('/status') ||
      forwardedUri.includes('/tree') ||
      forwardedUri.includes('/preview');

    if (!sessionId) {
      if (isApiRequest) {
        return c.json({ error: 'Authentication required', loginUrl }, 401);
      }
      return c.redirect(loginUrl, 302);
    }

    const ip = getClientIp(c);
    const fingerprintData = getDeviceFingerprint(c);
    const path = c.req.header('x-forwarded-uri') || '';

    const result = validateSession(sessionId, ip, fingerprintData, path);
    if (!result.valid) {
      if (result.reason === 'step_up_required') {
        if (isApiRequest) {
          return c.json({
            error: 'Step-up authentication required',
            loginUrl: `https://${hostname}/_auth/login?reason=step_up&redirect=${encodeURIComponent(originalUrl)}`
          }, 401);
        }
        return c.redirect(`https://${hostname}/_auth/login?reason=step_up&redirect=${encodeURIComponent(originalUrl)}`, 302);
      }

      // H5: PoP binding incomplete — session valid but not yet initialized (don't clear).
      if (result.reason === 'session_not_ready') {
        if (isApiRequest) {
          return c.json({
            error: 'Session initializing',
            reason: 'pop_binding_required',
            hint: result.hint || 'Please wait for security initialization to complete',
            retry: true,
          }, 401);
        }
        // Navigation: allow page load — PoP binds via session-pop.js after.
        setForwardAuthHeaders(c, result.session?.credential_id || 'passkey-user', getCurrentTier(), sessionId);
        return c.json({ authenticated: true }, 200);
      }

      clearSessionCookie(c, hostname);
      if (isApiRequest) {
        return c.json({ error: 'Session expired', reason: result.reason, loginUrl }, 401);
      }
      return c.redirect(loginUrl, 302);
    }

    // Must use verifyForwardAuthPoP (not verifyRequestPoP): c.req.url/method here point at
    // /api/auth/session, not the original request. Forwarded headers are signature-covered.
    const isWebSocketUpgrade = c.req.header('upgrade')?.toLowerCase() === 'websocket';
    const isTtydToken = /\/term\/[^/]+\/token$/.test(path);
    const hasSw = !!result.session!.pop_sw_active;
    const isShieldEndpoint = path.startsWith('/_auth/');

    const secFetchMode = c.req.header('sec-fetch-mode');
    const secFetchSite = c.req.header('sec-fetch-site');
    const isGenuineNavigation = secFetchMode === 'navigate' &&
      (secFetchSite === 'same-origin' || secFetchSite === 'same-site' || secFetchSite === 'none');
    const isStaticAssetUrl = /\.(css|js|map|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot)$/i.test(path);

    // Skip PoP where browser can't sign: WS upgrade, ttyd /token, shield-direct (tier-gate
    // re-enforces there), and without SW: real navigations + static assets + requests with
    // no PoP headers at all (cross-origin fetch wrapper can't sign, pre-init timing).
    const hasAnyPopHeader = !!(c.req.header('x-pop-timestamp') || c.req.header('x-pop-signature'));
    const skipPoP = isWebSocketUpgrade || isTtydToken || isShieldEndpoint ||
      (!hasSw && (isGenuineNavigation || isStaticAssetUrl || !hasAnyPopHeader));

    if (result.session!.pop_hmac_key && !skipPoP) {
      const popResult = await verifyForwardAuthPoP(c, result.session!);
      if (!popResult.valid) {
        logAuditEvent({
          type: 'pop_validation_failed',
          ip,
          fingerprint: fingerprintData.hash,
          sessionId,
          details: { reason: popResult.reason, path }
        });
        // Do NOT delete session on bad signature — usually stale-client (SW race, old IDB key).
        // Only nonce replay (below) proves an attack; prior nuke-on-sig-fail caused permanent wedges.
        if (popResult.reason === 'nonce_reused') {
          db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
          clearSessionCookie(c, hostname);
        }
        if (isApiRequest) {
          return c.json({ error: 'Session security verification failed', loginUrl }, 401);
        }
        return c.redirect(loginUrl, 302);
      }
    }

    // Only allow ID rotation on redirect-bound paths: Caddy forward_auth drops Set-Cookie on 200,
    // so rotating without cookie-update would stale → 401 next request.
    const canRotate = sessionFromUrl && !isApiRequest;
    const refresh = refreshSession(result.session!, ip, fingerprintData, canRotate);

    // Redirect (not 200) so Caddy forward_auth passes Set-Cookie.
    if (sessionFromUrl && !isApiRequest) {
      const cookieHost = forwardedHost || hostname;
      setSessionCookie(c, refresh.sessionId, cookieHost);

      const urlObj = new URL(originalUrl);
      urlObj.searchParams.delete('_shield_code');
      return c.redirect(urlObj.toString(), 302);
    }

    setForwardAuthHeaders(c, result.session!.credential_id || 'passkey-user', getCurrentTier(), refresh.sessionId);

    return c.json({ authenticated: true, tier: getCurrentTier() }, 200);
  });

  app.get('/_auth/sessions', async (c) => {
    const cookies = parseCookies(c.req.header('cookie'));
    const sessionId = cookies.shield_session;

    if (!sessionId) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const ip = getClientIp(c);
    const fingerprintData = getDeviceFingerprint(c);
    const result = validateSession(sessionId, ip, fingerprintData, '/_auth/sessions');

    if (!result.valid) {
      return c.json({ error: 'Session invalid' }, 401);
    }

    const sessions = db.prepare(`
      SELECT id, ip, created_at, last_activity, expires_at, absolute_expiry
      FROM sessions
      WHERE credential_id = ?
      ORDER BY last_activity DESC
    `).all(result.session!.credential_id) as Array<{
      id: string;
      ip: string;
      created_at: number;
      last_activity: number;
      expires_at: number;
      absolute_expiry: number;
    }>;

    return c.json({
      sessions: sessions.map(s => ({
        id: s.id.substring(0, 8) + '...',
        ip: s.ip,
        createdAt: s.created_at,
        lastActivity: s.last_activity,
        expiresAt: s.expires_at,
        absoluteExpiry: s.absolute_expiry,
        isCurrent: s.id === result.session!.id,
        isExpiringSoon: s.expires_at - Date.now() < 3600000
      })),
      currentSessionId: result.session!.id.substring(0, 8) + '...'
    });
  });

  app.delete('/_auth/sessions/:sessionId', async (c) => {
    const cookies = parseCookies(c.req.header('cookie'));
    const sessionId = cookies.shield_session;

    if (!sessionId) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const ip = getClientIp(c);
    const fingerprintData = getDeviceFingerprint(c);
    const result = validateSession(sessionId, ip, fingerprintData, '/_auth/sessions');

    if (!result.valid) {
      return c.json({ error: 'Session invalid' }, 401);
    }

    const targetPrefix = c.req.param('sessionId');

    const targetSession = db.prepare(
      'SELECT id FROM sessions WHERE id LIKE ? AND credential_id = ?'
    ).get(targetPrefix + '%', result.session!.credential_id) as { id: string } | undefined;

    if (!targetSession) {
      return c.json({ error: 'Session not found' }, 404);
    }

    if (targetSession.id === result.session!.id) {
      return c.json({
        error: 'Cannot revoke current session',
        details: 'Use logout to end your current session'
      }, 400);
    }

    db.prepare('DELETE FROM sessions WHERE id = ?').run(targetSession.id);

    logAuditEvent({
      type: 'session_revoked',
      ip,
      fingerprint: fingerprintData.hash,
      credentialId: result.session!.credential_id,
      sessionId: targetSession.id,
      details: { revokedBy: result.session!.id }
    });

    notifyBridgeSessionRevoked(targetSession.id, 'owner_revoked');

    return c.json({
      success: true,
      revokedSession: targetPrefix + '...'
    });
  });

  app.post('/_auth/sessions/revoke-all', async (c) => {
    const cookies = parseCookies(c.req.header('cookie'));
    const sessionId = cookies.shield_session;

    if (!sessionId) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const ip = getClientIp(c);
    const fingerprintData = getDeviceFingerprint(c);
    const result = validateSession(sessionId, ip, fingerprintData, '/_auth/sessions/revoke-all');

    if (!result.valid) {
      return c.json({ error: 'Session invalid' }, 401);
    }

    const deleteResult = db.prepare(
      'DELETE FROM sessions WHERE credential_id = ? AND id != ?'
    ).run(result.session!.credential_id, result.session!.id);

    logAuditEvent({
      type: 'all_sessions_revoked',
      ip,
      fingerprint: fingerprintData.hash,
      credentialId: result.session!.credential_id,
      sessionId: result.session!.id,
      details: { revokedCount: deleteResult.changes }
    });

    notifyBridgeSessionRevoked(undefined, 'owner_revoked_all');

    return c.json({
      success: true,
      revokedCount: deleteResult.changes
    });
  });

  // Volatile ML-KEM decap keys — never persisted.
  const pendingBinds = new Map<string, { dk: Uint8Array; challenge: string; expiresAt: number }>();

  setInterval(() => {
    const now = Date.now();
    for (const [key, val] of pendingBinds) {
      if (val.expiresAt < now) {
        val.dk.fill(0);
        pendingBinds.delete(key);
      }
    }
  }, 60_000);

  // ML-KEM PoP Bind Phase 1: returns ek + challenge; stores dk in memory (60s TTL).
  //
  // Per-device binding: if the client sends a stable `deviceId` (random 128-bit
  // tag stored in IDB alongside the HMAC key), each device gets its own row in
  // `device_bindings` keyed by (sessionId, deviceId). Multiple browsers/tabs
  // can bind additively under the same session without displacing each other.
  // Clients without deviceId (legacy) fall through to the pre-migration path
  // which writes to `sessions.pop_hmac_key` directly.
  app.post('/_auth/pop/bind/init', async (c) => {
    const cookies = parseCookies(c.req.header('cookie'));
    const sessionId = cookies.shield_session;
    if (!sessionId) return c.json({ error: 'No session' }, 401);

    const body = await c.req.json().catch(() => ({})) as { deviceId?: string; forceRebind?: boolean };
    const deviceId = isValidDeviceId(body.deviceId) ? body.deviceId : null;

    const session = db.prepare('SELECT id, pop_hmac_key FROM sessions WHERE id = ?')
      .get(sessionId) as { id: string; pop_hmac_key: string | null } | undefined;
    if (!session) return c.json({ error: 'Invalid session' }, 401);

    if (deviceId) {
      const existing = db.prepare(
        'SELECT pop_hmac_key, wrapped_hmac FROM device_bindings WHERE session_id = ? AND device_id = ?'
      ).get(sessionId, deviceId) as { pop_hmac_key: string; wrapped_hmac: string | null } | undefined;
      if (existing) {
        if (body.forceRebind) {
          db.prepare('DELETE FROM device_bindings WHERE session_id = ? AND device_id = ?')
            .run(sessionId, deviceId);
        } else {
          return c.json({
            bound: true,
            existing: true,
            hasWrappedKey: existing.wrapped_hmac !== null,
          });
        }
      }
    } else if (session.pop_hmac_key) {
      // Legacy client with no deviceId — unchanged hard-strict behaviour.
      return c.json({ bound: true, existing: true });
    }

    const { ml_kem1024 } = await import('@noble/post-quantum/ml-kem.js');
    const { publicKey: encapsulationKey, secretKey: decapsulationKey } = ml_kem1024.keygen();
    const challenge = crypto.randomBytes(32).toString('hex');

    // Pending-bind key space is keyed by (sessionId, deviceId) so one device's
    // bind-in-flight can't clobber another's on the same session.
    const pendKey = deviceId ? `${sessionId}:${deviceId}` : sessionId;
    pendingBinds.set(pendKey, {
      dk: decapsulationKey,
      challenge,
      expiresAt: Date.now() + 60_000,
    });

    const ip = getClientIp(c);
    logAuditEvent({
      type: 'pop_bind_init',
      ip,
      sessionId,
      details: {
        message: 'ML-KEM-1024 ephemeral keypair generated for PoP bind',
        deviceId: deviceId || null,
      }
    });

    return c.json({
      mlkem_ek: Buffer.from(encapsulationKey).toString('base64'),
      bind_challenge: challenge,
    });
  });

  // Phase 2: decapsulate → verify HMAC proof → store K_pop = HKDF(K, "pop-session-mac").
  //
  // Writes authoritatively to `device_bindings(session_id, device_id)` and
  // mirrors the freshly-bound key to `sessions.pop_hmac_key` so legacy
  // verification paths (confirm, workflow, token) keep working without
  // per-device awareness. Optional `wrapped_hmac` + `prf_salt` are PRF
  // recovery material; if present, the server stores them but NEVER the PRF
  // output itself — recovery is zero-knowledge to the server.
  app.post('/_auth/pop/bind/complete', async (c) => {
    const cookies = parseCookies(c.req.header('cookie'));
    const sessionId = cookies.shield_session;
    if (!sessionId) return c.json({ error: 'No session' }, 401);

    const body = await c.req.json() as {
      ciphertext?: string;
      bind_proof?: string;
      deviceId?: string;
      wrapped_hmac?: string;
      prf_salt?: string;
      attestation_aaguid?: string;
    };
    if (!body.ciphertext || !body.bind_proof) {
      return c.json({ error: 'Missing ciphertext or bind_proof' }, 400);
    }
    const deviceId = isValidDeviceId(body.deviceId) ? body.deviceId : null;

    const session = db.prepare('SELECT id, credential_id, pop_hmac_key FROM sessions WHERE id = ?')
      .get(sessionId) as { id: string; credential_id: string; pop_hmac_key: string | null } | undefined;
    if (!session) return c.json({ error: 'Invalid session' }, 401);

    if (deviceId) {
      const existing = db.prepare(
        'SELECT device_id FROM device_bindings WHERE session_id = ? AND device_id = ?'
      ).get(sessionId, deviceId) as { device_id: string } | undefined;
      if (existing) return c.json({ bound: true, existing: true });
    } else if (session.pop_hmac_key) {
      return c.json({ bound: true, existing: true });
    }

    const pendKey = deviceId ? `${sessionId}:${deviceId}` : sessionId;
    const pending = pendingBinds.get(pendKey);
    if (!pending || pending.expiresAt < Date.now()) {
      if (pending) {
        pending.dk.fill(0);
        pendingBinds.delete(pendKey);
      }
      return c.json({ error: 'No pending bind or expired — call /bind/init first' }, 400);
    }
    pendingBinds.delete(pendKey);

    const { ml_kem1024 } = await import('@noble/post-quantum/ml-kem.js');
    let sharedSecret: Uint8Array;
    try {
      const ct = Buffer.from(body.ciphertext, 'base64');
      sharedSecret = ml_kem1024.decapsulate(ct, pending.dk);
    } catch {
      pending.dk.fill(0);
      return c.json({ error: 'ML-KEM decapsulation failed' }, 400);
    }
    pending.dk.fill(0);

    const expectedProof = crypto.createHmac('sha256', sharedSecret)
      .update('pop-bind|' + pending.challenge)
      .digest();
    const clientProof = Buffer.from(body.bind_proof, 'base64');
    if (!crypto.timingSafeEqual(expectedProof, clientProof)) {
      sharedSecret.fill(0);
      return c.json({ error: 'Bind proof verification failed' }, 400);
    }

    const kPop = crypto.createHmac('sha256', sharedSecret)
      .update('pop-session-mac')
      .digest('base64');
    sharedSecret.fill(0);

    const now = Date.now();
    const wrappedHmac = typeof body.wrapped_hmac === 'string' ? body.wrapped_hmac : null;
    const prfSalt = typeof body.prf_salt === 'string' ? body.prf_salt : null;
    const aaguid = typeof body.attestation_aaguid === 'string' ? body.attestation_aaguid : null;

    // Per-device authoritative row + legacy mirror in a single txn so callers
    // never see a partial state.
    const txn = db.transaction(() => {
      if (deviceId) {
        db.prepare(`INSERT INTO device_bindings
          (session_id, device_id, pop_hmac_key, wrapped_hmac, prf_salt, attestation_aaguid, credential_id, created_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(sessionId, deviceId, kPop, wrappedHmac, prfSalt, aaguid, session.credential_id, now, now);
      }
      // Mirror: sessions.pop_hmac_key tracks the most-recent device binding on
      // this session. Verification code that isn't deviceId-aware reads it;
      // the CAS guard blocks concurrent writers but allows progression when
      // an earlier device already populated the row.
      if (!session.pop_hmac_key) {
        db.prepare(`UPDATE sessions SET
          pop_hmac_key = ?,
          pop_prf_bound = 1,
          pop_bound_at = ?
        WHERE id = ? AND pop_hmac_key IS NULL`).run(
          kPop,
          now,
          sessionId,
        );
      }
    });
    try {
      txn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: 'Bind persist failed', detail: msg }, 500);
    }

    const ip = getClientIp(c);
    logAuditEvent({
      type: 'pop_key_bound',
      ip,
      sessionId,
      details: {
        message: 'ML-KEM PoP HMAC key bound',
        deviceId: deviceId || null,
        hasWrappedKey: !!wrappedHmac,
      }
    });
    logAuditEvent({
      type: 'pqc_hmac_pop_bind',
      ip,
      sessionId,
      details: { metric: 'pqc.hmac_pop_bind', success: true, deviceId: deviceId || null },
    });

    return c.json({ bound: true, existing: false });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // PRF-backed silent recovery
  //
  // When local IDB loses the HMAC key (Safari ITP eviction, cleared cookies,
  // a fresh browser profile) but the passkey itself is still present, the
  // user can regain access with a single biometric tap instead of a full
  // re-auth. The flow:
  //
  //   1. Client POSTs /recover/options with its deviceId.
  //   2. Server looks up device_bindings for (session, device). If a row
  //      exists and has prf_salt+wrapped_hmac, it returns a fresh WebAuthn
  //      authentication challenge AND the prf_salt. The passkey is narrowed
  //      to the session's credential_id so only the legitimate authenticator
  //      can satisfy the challenge.
  //   3. Client calls navigator.credentials.get({ prf: { first: prf_salt }}).
  //      The authenticator returns an assertion plus a PRF output that is
  //      derived inside the secure element and never leaves the device.
  //   4. Client POSTs /recover/complete with the assertion.
  //   5. Server verifies the assertion. If valid, it returns wrapped_hmac.
  //      Client derives KEK = HKDF(prf_output, prf_salt) locally, AES-GCM-
  //      decrypts wrapped_hmac → restores the HMAC key to IDB.
  //
  // Security model: the server never sees the PRF output or the HMAC key.
  // Recovery requires: valid session cookie + proof-of-possession of the
  // same passkey credential + the PRF output from that specific passkey.
  // This is the same trust level as the initial bind — no degradation.
  // ──────────────────────────────────────────────────────────────────────────

  app.post('/_auth/pop/recover/options', async (c) => {
    const cookies = parseCookies(c.req.header('cookie'));
    const sessionId = cookies.shield_session;
    if (!sessionId) return c.json({ error: 'No session' }, 401);

    const body = await c.req.json().catch(() => ({})) as { deviceId?: string };
    if (!isValidDeviceId(body.deviceId)) {
      return c.json({ error: 'deviceId required' }, 400);
    }
    const deviceId = body.deviceId;

    const session = db.prepare('SELECT id, credential_id FROM sessions WHERE id = ?')
      .get(sessionId) as { id: string; credential_id: string } | undefined;
    if (!session) return c.json({ error: 'Invalid session' }, 401);

    const binding = db.prepare(
      'SELECT prf_salt, wrapped_hmac FROM device_bindings WHERE session_id = ? AND device_id = ?'
    ).get(sessionId, deviceId) as { prf_salt: string | null; wrapped_hmac: string | null } | undefined;

    if (!binding || !binding.prf_salt || !binding.wrapped_hmac) {
      // No PRF material enrolled for this device — recovery not possible,
      // caller should fall back to full passkey re-auth + fresh bind.
      return c.json({ error: 'no_recovery_material' }, 404);
    }

    // Narrow to the one credential that owns this session. Opening allowCredentials
    // wider would let any registered authenticator answer, which weakens the
    // device-binding guarantee the recovery is meant to preserve.
    const cred = db.prepare('SELECT * FROM credential WHERE id = ?')
      .get(session.credential_id) as CredentialRecord | undefined;
    if (!cred) return c.json({ error: 'credential_missing' }, 500);

    const options = await generateAuthenticationOptions({
      rpID: resolveRpId(c.req.header('host') ?? ''),
      userVerification: 'required',
      allowCredentials: buildAllowCredentials([cred]),
    });

    storeChallenge(options.challenge, {
      type: 'authentication',
      createdAt: Date.now(),
      // Carry the recovery target through the challenge record so /complete
      // can enforce that the assertion is bound to this specific recovery
      // attempt and can't be replayed against a different device row.
      userId: `pop-recover|${sessionId}|${deviceId}`,
    });

    return c.json({
      options,
      prf_salt: binding.prf_salt,
    });
  });

  app.post('/_auth/pop/recover/complete', async (c) => {
    const cookies = parseCookies(c.req.header('cookie'));
    const sessionId = cookies.shield_session;
    if (!sessionId) return c.json({ error: 'No session' }, 401);

    const body = await c.req.json().catch(() => ({})) as {
      deviceId?: string;
      assertion?: {
        id?: string;
        rawId?: string;
        type?: string;
        response?: {
          authenticatorData?: string;
          signature?: string;
          userHandle?: string;
          clientDataJSON?: string;
        };
      };
    };
    if (!isValidDeviceId(body.deviceId)) return c.json({ error: 'deviceId required' }, 400);
    const deviceId = body.deviceId;
    if (!body.assertion?.response?.clientDataJSON) return c.json({ error: 'Invalid assertion' }, 400);

    const session = db.prepare('SELECT id, credential_id FROM sessions WHERE id = ?')
      .get(sessionId) as { id: string; credential_id: string } | undefined;
    if (!session) return c.json({ error: 'Invalid session' }, 401);

    const binding = db.prepare(
      'SELECT pop_hmac_key, wrapped_hmac, prf_salt FROM device_bindings WHERE session_id = ? AND device_id = ?'
    ).get(sessionId, deviceId) as { pop_hmac_key: string; wrapped_hmac: string | null; prf_salt: string | null } | undefined;
    if (!binding || !binding.wrapped_hmac) return c.json({ error: 'no_recovery_material' }, 404);

    const clientData = JSON.parse(Buffer.from(body.assertion.response.clientDataJSON, 'base64').toString());
    const expectedChallenge = clientData.challenge;
    const challengeData = getChallenge(expectedChallenge);
    if (!challengeData ||
        challengeData.type !== 'authentication' ||
        challengeData.userId !== `pop-recover|${sessionId}|${deviceId}`) {
      return c.json({ error: 'challenge_invalid' }, 400);
    }

    const credId = body.assertion.rawId;
    const cred = db.prepare('SELECT * FROM credential WHERE credentialId = ? AND id = ?')
      .get(credId, session.credential_id) as CredentialRecord | undefined;
    if (!cred) return c.json({ error: 'credential_mismatch' }, 400);

    const ORIGINS = readAllowedOrigins();
    try {
      const verification = await verifyAuthenticationResponse({
        response: body.assertion as any,
        expectedChallenge,
        expectedOrigin: ORIGINS,
        expectedRPID: resolveRpId(c.req.header('host') ?? ''),
        credential: {
          id: cred.credentialId,
          publicKey: Buffer.from(cred.publicKey, 'base64url'),
          counter: cred.counter,
          transports: cred.transports ? JSON.parse(cred.transports) : [],
        },
      });
      if (!verification.verified) return c.json({ error: 'assertion_failed' }, 400);

      db.prepare('UPDATE credential SET counter = ? WHERE id = ?')
        .run(verification.authenticationInfo.newCounter, cred.id);
    } catch {
      return c.json({ error: 'assertion_failed' }, 400);
    }

    db.prepare('UPDATE device_bindings SET last_seen_at = ? WHERE session_id = ? AND device_id = ?')
      .run(Date.now(), sessionId, deviceId);

    logAuditEvent({
      type: 'pop_key_recovered',
      ip: getClientIp(c),
      sessionId,
      credentialId: cred.id,
      details: { message: 'PoP HMAC key recovered via PRF', deviceId },
    });

    // Client receives the wrapped blob, unwraps locally with the PRF-derived
    // KEK, and re-populates IDB. Server does not learn the unwrapped key.
    return c.json({
      wrapped_hmac: binding.wrapped_hmac,
      prf_salt: binding.prf_salt,
    });
  });

  // Post-bind PRF enrollment (two-phase, assertion-verified).
  //
  // A client that has completed ML-KEM bind but didn't produce PRF material
  // at bind time can attach recovery material by performing a fresh WebAuthn
  // assertion with the prf extension. We require the assertion so a stolen
  // cookie can't overwrite wrapped_hmac with attacker-owned material (which
  // would otherwise convert a later recovery into a denial-of-service).
  //
  // Server generates prf_salt here and returns it to the client alongside
  // the assertion challenge. The client uses that exact salt as the PRF
  // extension input so the KEK is deterministic for later recovery.

  app.post('/_auth/pop/recover/enroll/options', async (c) => {
    const cookies = parseCookies(c.req.header('cookie'));
    const sessionId = cookies.shield_session;
    if (!sessionId) return c.json({ error: 'No session' }, 401);

    const body = await c.req.json().catch(() => ({})) as { deviceId?: string };
    if (!isValidDeviceId(body.deviceId)) return c.json({ error: 'deviceId required' }, 400);
    const deviceId = body.deviceId;

    const session = db.prepare('SELECT id, credential_id FROM sessions WHERE id = ?')
      .get(sessionId) as { id: string; credential_id: string } | undefined;
    if (!session) return c.json({ error: 'Invalid session' }, 401);

    const binding = db.prepare(
      'SELECT device_id FROM device_bindings WHERE session_id = ? AND device_id = ?'
    ).get(sessionId, deviceId) as { device_id: string } | undefined;
    if (!binding) return c.json({ error: 'no_binding' }, 404);

    const cred = db.prepare('SELECT * FROM credential WHERE id = ?')
      .get(session.credential_id) as CredentialRecord | undefined;
    if (!cred) return c.json({ error: 'credential_missing' }, 500);

    // 32-byte salt, base64url. The client feeds this to the prf extension
    // so the PRF output — and therefore the KEK — is deterministic across
    // enroll and recovery.
    const prfSalt = crypto.randomBytes(32).toString('base64url');

    const options = await generateAuthenticationOptions({
      rpID: resolveRpId(c.req.header('host') ?? ''),
      userVerification: 'required',
      allowCredentials: buildAllowCredentials([cred]),
    });

    storeChallenge(options.challenge, {
      type: 'authentication',
      createdAt: Date.now(),
      userId: `pop-enroll|${sessionId}|${deviceId}|${prfSalt}`,
    });

    return c.json({ options, prf_salt: prfSalt });
  });

  app.post('/_auth/pop/recover/enroll/complete', async (c) => {
    const cookies = parseCookies(c.req.header('cookie'));
    const sessionId = cookies.shield_session;
    if (!sessionId) return c.json({ error: 'No session' }, 401);

    const body = await c.req.json().catch(() => ({})) as {
      deviceId?: string;
      wrapped_hmac?: string;
      prf_salt?: string;
      assertion?: {
        id?: string;
        rawId?: string;
        type?: string;
        response?: {
          authenticatorData?: string;
          signature?: string;
          userHandle?: string;
          clientDataJSON?: string;
        };
      };
    };
    if (!isValidDeviceId(body.deviceId) ||
        typeof body.wrapped_hmac !== 'string' ||
        typeof body.prf_salt !== 'string' ||
        !body.assertion?.response?.clientDataJSON) {
      return c.json({ error: 'invalid_payload' }, 400);
    }
    const deviceId = body.deviceId;

    const session = db.prepare('SELECT id, credential_id FROM sessions WHERE id = ?')
      .get(sessionId) as { id: string; credential_id: string } | undefined;
    if (!session) return c.json({ error: 'Invalid session' }, 401);

    const clientData = JSON.parse(Buffer.from(body.assertion.response.clientDataJSON, 'base64').toString());
    const expectedChallenge = clientData.challenge;
    const challengeData = getChallenge(expectedChallenge);
    if (!challengeData ||
        challengeData.type !== 'authentication' ||
        challengeData.userId !== `pop-enroll|${sessionId}|${deviceId}|${body.prf_salt}`) {
      return c.json({ error: 'challenge_invalid' }, 400);
    }

    const cred = db.prepare('SELECT * FROM credential WHERE credentialId = ? AND id = ?')
      .get(body.assertion.rawId, session.credential_id) as CredentialRecord | undefined;
    if (!cred) return c.json({ error: 'credential_mismatch' }, 400);

    const ORIGINS = readAllowedOrigins();
    try {
      const verification = await verifyAuthenticationResponse({
        response: body.assertion as any,
        expectedChallenge,
        expectedOrigin: ORIGINS,
        expectedRPID: resolveRpId(c.req.header('host') ?? ''),
        credential: {
          id: cred.credentialId,
          publicKey: Buffer.from(cred.publicKey, 'base64url'),
          counter: cred.counter,
          transports: cred.transports ? JSON.parse(cred.transports) : [],
        },
      });
      if (!verification.verified) return c.json({ error: 'assertion_failed' }, 400);
      db.prepare('UPDATE credential SET counter = ? WHERE id = ?')
        .run(verification.authenticationInfo.newCounter, cred.id);
    } catch {
      return c.json({ error: 'assertion_failed' }, 400);
    }

    db.prepare(`UPDATE device_bindings
        SET wrapped_hmac = ?, prf_salt = ?, last_seen_at = ?
        WHERE session_id = ? AND device_id = ?`)
      .run(body.wrapped_hmac, body.prf_salt, Date.now(), sessionId, deviceId);

    logAuditEvent({
      type: 'pop_recovery_enrolled',
      ip: getClientIp(c),
      sessionId,
      credentialId: cred.id,
      details: { deviceId },
    });

    return c.json({ enrolled: true });
  });

  // Legacy ECDSA bind — 410 Gone. Use ML-KEM two-phase.
  app.post('/_auth/pop/bind', async (c) => {
    return c.json({
      error: 'Legacy ECDSA PoP bind is no longer supported. Use /_auth/pop/bind/init + /_auth/pop/bind/complete (ML-KEM).'
    }, 410);
  });

  app.get('/_auth/intent/nonce', async (c) => {
    const cookies = parseCookies(c.req.header('cookie'));
    const sessionId = cookies.shield_session;
    if (!sessionId) {
      return c.json({ error: 'No session' }, 401);
    }

    const session = db.prepare('SELECT id FROM sessions WHERE id = ?')
      .get(sessionId) as { id: string } | undefined;
    if (!session) {
      return c.json({ error: 'Invalid session' }, 401);
    }

    const action = c.req.query('action');
    const resource = c.req.query('resource') || null;
    if (!action) {
      return c.json({ error: 'action query parameter required' }, 400);
    }

    const nonce = crypto.randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + 300_000;

    db.prepare('INSERT INTO intent_nonces (session_id, nonce, action, resource, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, nonce, action, resource, expiresAt);

    db.prepare('DELETE FROM intent_nonces WHERE expires_at < ?').run(Date.now());

    return c.json({ nonce, action, resource, expiresAt });
  });

  app.get('/_auth/pop/status', async (c) => {
    const cookies = parseCookies(c.req.header('cookie'));
    const sessionId = cookies.shield_session;
    if (!sessionId) return c.json({ error: 'No session' }, 401);

    const session = db.prepare('SELECT pop_hmac_key, pop_bound_at FROM sessions WHERE id = ?')
      .get(sessionId) as { pop_hmac_key: string | null; pop_bound_at: number | null } | undefined;
    if (!session) return c.json({ error: 'Invalid session' }, 401);

    return c.json({ bound: !!session.pop_hmac_key, boundAt: session.pop_bound_at });
  });

  app.post('/_auth/pop/sw-confirm', async (c) => {
    const cookies = parseCookies(c.req.header('cookie'));
    const sessionId = cookies.shield_session;
    if (!sessionId) return c.json({ error: 'No session' }, 401);

    const session = db.prepare('SELECT id, pop_hmac_key, pop_sw_active FROM sessions WHERE id = ?')
      .get(sessionId) as { id: string; pop_hmac_key: string | null; pop_sw_active: number | null } | undefined;
    if (!session) return c.json({ error: 'Invalid session' }, 401);
    if (!session.pop_hmac_key) return c.json({ error: 'PoP not bound' }, 400);

    db.prepare('UPDATE sessions SET pop_sw_active = 1 WHERE id = ?').run(sessionId);

    const ip = getClientIp(c);
    logAuditEvent({
      type: 'pop_sw_confirmed',
      ip,
      sessionId,
      details: { message: 'Service Worker active — PoP enforced on all requests' }
    });

    return c.json({ confirmed: true });
  });

  app.get('/_auth/static/session-pop.js', (c) => {
    const meta = POP_CLIENT_MANIFEST['session-pop.js'];
    if (meta && c.req.header('if-none-match') === meta.etag) {
      return c.body(null, 304);
    }
    c.header('Content-Type', 'application/javascript');
    c.header('Cache-Control', 'public, max-age=3600');
    if (meta) {
      c.header('ETag', meta.etag);
    }
    return c.body(SESSION_POP_JS);
  });

  app.get('/_auth/static/session-pop.js.map', (c) => {
    c.header('Content-Type', 'application/json');
    c.header('Cache-Control', 'public, max-age=3600');
    return c.body(SESSION_POP_MAP);
  });

  app.get('/_auth/static/pop-sw.js', (c) => {
    const meta = POP_CLIENT_MANIFEST['pop-sw.js'];
    if (meta && c.req.header('if-none-match') === meta.etag) {
      return c.body(null, 304);
    }
    c.header('Content-Type', 'application/javascript');
    c.header('Cache-Control', 'public, max-age=3600');
    c.header('Service-Worker-Allowed', '/');
    if (meta) {
      c.header('ETag', meta.etag);
    }
    return c.body(SESSION_POP_SW_JS);
  });

  app.get('/_auth/static/pop-sw.js.map', (c) => {
    c.header('Content-Type', 'application/json');
    c.header('Cache-Control', 'public, max-age=3600');
    return c.body(SESSION_POP_SW_MAP);
  });

  // Pre-built at provisioning (Cloud Run); written to /opt/ellul/auth/static/pqc-mlkem.js.
  app.get('/_auth/static/pqc-mlkem.js', async (c) => {
    const fs = await import('fs');
    const prebuiltPath = '/opt/ellul/auth/static/pqc-mlkem.js';
    try {
      const js = fs.readFileSync(prebuiltPath, 'utf8');
      c.header('Content-Type', 'application/javascript');
      c.header('Cache-Control', 'public, max-age=3600');
      return c.body(js);
    } catch {
      return c.json({ error: 'PQC browser bundle not provisioned' }, 500);
    }
  });

  app.get('/_auth/static/terminal-init.js', (c) => {
    const meta = POP_CLIENT_MANIFEST['terminal-init.js'];
    if (meta && c.req.header('if-none-match') === meta.etag) {
      return c.body(null, 304);
    }
    c.header('Content-Type', 'application/javascript');
    c.header('Cache-Control', 'public, max-age=3600');
    if (meta) {
      c.header('ETag', meta.etag);
    }
    return c.body(TERMINAL_INIT_JS);
  });

  app.get('/_auth/static/terminal-init.js.map', (c) => {
    c.header('Content-Type', 'application/json');
    c.header('Cache-Control', 'public, max-age=3600');
    return c.body(TERMINAL_INIT_MAP);
  });

  app.get('/_auth/terminal/wrapper', (c) => {
    const twNonce = generateCspNonce();
    c.header('Content-Type', 'text/html; charset=utf-8');
    c.header('Cache-Control', 'no-store');
    // frame-src added: wrapper loads ttyd in iframe.
    c.header('Content-Security-Policy',
      getCspHeader(twNonce).replace("frame-ancestors", "frame-src 'self'; frame-ancestors"));

    const popSri = POP_CLIENT_MANIFEST['session-pop.js']?.sri || '';
    const initSri = POP_CLIENT_MANIFEST['terminal-init.js']?.sri || '';
    const html = TERMINAL_WRAPPER_HTML
      .replace(
        '<script src="/_auth/static/session-pop.js"></script>',
        `<script nonce="${twNonce}" src="/_auth/static/session-pop.js"${popSri ? ` integrity="${popSri}" crossorigin="anonymous"` : ''}></script>`
      )
      .replace(
        '<script src="/_auth/static/terminal-init.js"></script>',
        `<script nonce="${twNonce}" src="/_auth/static/terminal-init.js"${initSri ? ` integrity="${initSri}" crossorigin="anonymous"` : ''}></script>`
      )
      .replace(/<style>/g, `<style nonce="${twNonce}">`);
    return c.body(html);
  });

  // Owner-gated forward_auth for free-tier exposed apps — compares authed user vs owner.lock.
  app.get('/api/auth/check', async (c) => {
    const tier = getCurrentTier();
    const cookies = parseCookies(c.req.header('cookie'));

    let userId: string | null = null;

    if (tier === 'standard') {
      const jwtPayload = verifyJwtToken(c.req);
      if (jwtPayload) {
        userId = jwtPayload.sub || null;
      }
    } else {
      const sessionId = cookies.shield_session;
      if (sessionId) {
        const ip = getClientIp(c);
        const fingerprintData = getDeviceFingerprint(c);
        const result = validateSession(sessionId, ip, fingerprintData, '/api/auth/check');
        if (result.valid && result.session) {
          userId = result.session.credential_id || null;
        }
      }
    }

    if (!userId) {
      return c.json({ error: 'Authentication required' }, 403);
    }

    let ownerId: string | null = null;
    try {
      ownerId = fs.readFileSync('/etc/ellul/owner.lock', 'utf8').trim();
    } catch { /* missing → fail secure */ }

    if (!ownerId || userId !== ownerId) {
      return c.json({ error: 'Not the server owner' }, 403);
    }

    setForwardAuthHeaders(c, userId, tier, 'owner-check');
    return c.json({ authenticated: true, owner: true }, 200);
  });
}
