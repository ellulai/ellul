// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Default-deny auth boundary. Unclassified routes fall through to SESSION (fail-closed).

import { createMiddleware } from 'hono/factory';
import { getCurrentTier } from '../application/gates/Tier';
import { getClientIp, getDeviceFingerprint } from '../auth/fingerprint';
import { validateSession, deleteSession } from '../auth/session';
import { verifyRequestPoP } from '../auth/pop';
import { verifyJwtToken } from '../auth/jwt';
import { parseCookies } from '../utils/cookie';
import { logAuditEvent } from '../application/audit/Audit';
import { dbg } from '../application/audit/DebugLog';
import { verifyProjectTokenDetailed, STS_EXPIRED_CODE, STS_INVALID_CODE } from '../application/platform/Sts';

// ── Route classification ──────────────────────────────────────────────────

const enum AuthType {
  PUBLIC,
  AUTH_FLOW,
  INTERNAL,
  SESSION,
}

interface RoutePolicy {
  type: AuthType;
  reason: string;
}

// Rules ordered most-specific first. Default: SESSION (fail-closed).
function classifyRoute(path: string): RoutePolicy {
  // ── PUBLIC ──
  if (path === '/health') {
    return { type: AuthType.PUBLIC, reason: 'health_check' };
  }
  if (path === '/_auth/capabilities') {
    return { type: AuthType.PUBLIC, reason: 'capability_discovery' };
  }
  if (path.startsWith('/_auth/static/')) {
    return { type: AuthType.PUBLIC, reason: 'static_asset' };
  }

  // ── AUTH_FLOW: these ARE the authentication mechanism ──
  if (path.startsWith('/_auth/login')) {
    return { type: AuthType.AUTH_FLOW, reason: 'passkey_login' };
  }
  if (path.startsWith('/_auth/register')) {
    return { type: AuthType.AUTH_FLOW, reason: 'passkey_registration' };
  }
  if (path.startsWith('/_auth/recovery')) {
    return { type: AuthType.AUTH_FLOW, reason: 'account_recovery' };
  }
  if (path.startsWith('/_auth/standard-upgrade')) {
    return { type: AuthType.AUTH_FLOW, reason: 'tier_upgrade_flow' };
  }
  if (path === '/_auth/bridge') {
    return { type: AuthType.AUTH_FLOW, reason: 'auth_bootstrap_iframe' };
  }
  if (path === '/_auth/bridge/tier') {
    return { type: AuthType.AUTH_FLOW, reason: 'tier_discovery' };
  }
  if (path === '/_auth/bridge/session') {
    return { type: AuthType.AUTH_FLOW, reason: 'session_check' };
  }
  if (path === '/_auth/code/redirect') {
    return { type: AuthType.AUTH_FLOW, reason: 'code_session_redirect' };
  }
  if (path === '/_auth/code/establish') {
    // Auth inherent: _code_session query param is a cryptographic token from passkey+PoP flow.
    return { type: AuthType.AUTH_FLOW, reason: 'code_session_establish' };
  }
  if (path === '/_auth/client/exchange') {
    // Auth inherent: exchange code is single-use 30s-TTL token from passkey auth.
    return { type: AuthType.AUTH_FLOW, reason: 'client_exchange' };
  }
  if (path === '/_auth/device/challenge' || path === '/_auth/device/authenticate') {
    // Auth inherent: server challenge + ECDSA signature from registered PoP key.
    return { type: AuthType.AUTH_FLOW, reason: 'device_auth' };
  }
  if (path === '/_auth/session/keepalive') {
    return { type: AuthType.AUTH_FLOW, reason: 'session_keepalive' };
  }
  if (path.startsWith('/_auth/pop/')) {
    return { type: AuthType.AUTH_FLOW, reason: 'pop_binding' };
  }
  if (path === '/_auth/schema') {
    return { type: AuthType.PUBLIC, reason: 'schema_discovery' };
  }

  // ── INTERNAL: localhost-only, tokens in body (not cookies) ──
  if (path === '/_auth/terminal/validate' ||
      path === '/_auth/terminal/session/create' ||
      path === '/_auth/terminal/session/validate' ||
      path === '/_auth/code/validate' ||
      path === '/_auth/code/session/validate' ||
      path === '/_auth/code/session/status' ||
      path === '/_auth/agent/validate' ||
      path === '/_auth/session/check' ||
      path === '/_auth/pop/verify-challenge' ||
      path === '/_auth/preview/validate') {
    return { type: AuthType.INTERNAL, reason: 'service_validation' };
  }
  if (path === '/_auth/verify-confirmation' ||
      path === '/_auth/git/verify-link-token' ||
      path === '/_auth/git/verify-unlink-token') {
    return { type: AuthType.INTERNAL, reason: 'api_server_verification' };
  }
  if (path === '/api/auth/session' || path.startsWith('/api/auth/session?')) {
    return { type: AuthType.INTERNAL, reason: 'forward_auth' };
  }
  if (path.startsWith('/api/internal/') || path.startsWith('/_internal/')) {
    return { type: AuthType.INTERNAL, reason: 'internal_api' };
  }
  // B2B gate resolve uses WebAuthn assertion; other B2B endpoints use control plane sig auth
  if (path.startsWith('/_auth/b2b/gates/') && path.endsWith('/resolve')) {
    return { type: AuthType.AUTH_FLOW, reason: 'b2b_gate_resolve' };
  }
  if (path.startsWith('/_auth/b2b/')) {
    return { type: AuthType.INTERNAL, reason: 'b2b_control_plane' };
  }

  if (path.startsWith('/_auth/exec/')) {
    return { type: AuthType.SESSION, reason: 'exec_sandbox' };
  }

  return { type: AuthType.SESSION, reason: 'default_deny' };
}

export const tierGateMiddleware = createMiddleware(async (c, next) => {
  const path = c.req.path;
  const method = c.req.method;
  const ip = getClientIp(c);
  const cookieHeader = c.req.header('cookie') ?? '';
  const hasShieldSessionCookie = /(?:^|;\s*)shield_session=/.test(cookieHeader);

  dbg('gate', 'enter', { path, method, ip, hasShieldSessionCookie });

  // ── LOCKED-BUT-AWAKE: volume encrypted, awaiting PRF unlock — everything else → 423 ──
  try {
    const { isLockedButAwake } = require('../main');
    if (isLockedButAwake()) {
      const isUnlockPath = path === '/health'
        || path === '/_auth/capabilities'
        || path === '/_auth/bridge/luks-unlock'
        || path === '/_auth/bridge/luks-unlock-challenge'
        || path.startsWith('/_auth/static/');
      if (!isUnlockPath) {
        dbg('gate', 'reject_locked_but_awake', { path, method, ip });
        return c.json({ error: 'Volume locked — passkey unlock required', locked: true }, 423);
      }
      dbg('gate', 'pass_locked_unlock_path', { path });
    }
  } catch { /* isLockedButAwake not available — not in locked mode */ }

  const policy = classifyRoute(path);
  const policyTypeName =
    policy.type === AuthType.PUBLIC ? 'PUBLIC' :
    policy.type === AuthType.AUTH_FLOW ? 'AUTH_FLOW' :
    policy.type === AuthType.INTERNAL ? 'INTERNAL' :
    policy.type === AuthType.SESSION ? 'SESSION' : 'UNKNOWN';
  dbg('gate', 'classified', { path, policy_type: policyTypeName, reason: policy.reason });

  if (policy.type === AuthType.PUBLIC) { dbg('gate', 'pass_public', { path }); return next(); }
  if (policy.type === AuthType.AUTH_FLOW) { dbg('gate', 'pass_auth_flow', { path }); return next(); }

  // INTERNAL: layered protection at endpoint (single-use tokens, localhost check,
  // requireInternalTokenMiddleware) + network (Caddy routes only from localhost).
  if (policy.type === AuthType.INTERNAL) {
    dbg('gate', 'pass_internal', { path });
    return next();
  }

  // ── SESSION ──
  const tier = getCurrentTier();
  dbg('gate', 'tier_resolved', { path, method, tier });

  if (tier === 'web_locked' || tier === 'private_locked') {
    const cookies = parseCookies(c.req.header('cookie'));
    const sessionId = cookies.shield_session;

    if (!sessionId) {
      dbg('gate', 'reject_no_session', {
        path, method, tier, ip,
        cookieNames: Object.keys(cookies),
        hasCookieHeader: !!c.req.header('cookie'),
      });
      logAuditEvent({
        type: 'tier_gate_denied',
        ip,
        details: { path, method, tier, reason: 'no_session' },
      });
      // Opaque error — do not leak tier/auth mechanism to unauthenticated callers.
      return c.json({ error: 'Authentication required' }, 401);
    }

    const fingerprintData = getDeviceFingerprint(c);
    dbg('gate', 'validating_session', {
      path, method, tier, sessionIdShort: sessionId.slice(0, 8),
      ip, fingerprintShort: fingerprintData?.hash?.slice(0, 8),
    });
    const result = validateSession(sessionId, ip, fingerprintData, path);
    if (!result.valid) {
      dbg('gate', 'reject_session_invalid', {
        path, method, tier, sessionIdShort: sessionId.slice(0, 8),
        reason: result.reason ?? 'session_invalid',
        hint: result.hint,
      });
      logAuditEvent({
        type: 'tier_gate_denied',
        ip,
        sessionId,
        details: { path, method, tier, reason: result.reason || 'session_invalid' },
      });
      if (result.reason === 'step_up_required') {
        return c.json({ error: 'Authentication required', reason: 'step_up_required' }, 401);
      }
      return c.json({ error: 'Authentication required' }, 401);
    }
    dbg('gate', 'session_valid', {
      path, method, tier, sessionIdShort: sessionId.slice(0, 8),
      fingerprintStatus: result.session?.fingerprint_status,
      popBound: !!result.session?.pop_hmac_key,
      popSwActive: !!result.session?.pop_sw_active,
    });

    c.set('tierGateAuth', {
      tier: 'web_locked' as const,
      sessionId,
      credentialId: result.session?.credential_id,
    });

    // PoP: every web_locked SESSION request must prove browser holds the ML-KEM-derived HMAC key.
    if (result.session?.pop_hmac_key) {
      // PoP setup endpoints ARE the PoP mechanism (chicken-and-egg).
      const isPopSetup = path.startsWith('/_auth/pop/');

      // SSE streams — EventSource has no JS custom-header API and the console origin has no PoP SW
      // (shield SW is scoped to srv only). Cookie-only auth accepted here; gate stream routes
      // remain PoP-required via the bridge iframe. /_auth/gates/stream requires X-STS-Token.
      const isConsoleInboxStream =
        path === '/_auth/gates/stream';

      // sec-fetch-mode/sec-fetch-site are Forbidden headers — JS cannot set them, so
      // "navigate" + trusted site value proves a genuine browser navigation (not fetch/XHR).
      const hasSw = !!result.session.pop_sw_active;
      const secFetchMode = c.req.header('sec-fetch-mode');
      const secFetchSite = c.req.header('sec-fetch-site');
      const isGenuineNavigation = secFetchMode === 'navigate' &&
        (secFetchSite === 'same-origin' || secFetchSite === 'same-site' || secFetchSite === 'none');
      const isStaticAssetUrl = /\.(css|js|map|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot)$/i.test(path);

      const skipPoP = isPopSetup || isConsoleInboxStream ||
        (!hasSw && (isGenuineNavigation || isStaticAssetUrl));

      if (!skipPoP) {
        dbg('gate', 'pop_required', {
          path, method, sessionIdShort: sessionId.slice(0, 8),
          hasSw, secFetchMode, secFetchSite,
        });
        const popResult = await verifyRequestPoP(c, result.session);
        if (!popResult.valid) {
          dbg('gate', 'reject_pop_failed', {
            path, method, sessionIdShort: sessionId.slice(0, 8),
            reason: popResult.reason,
          });
          logAuditEvent({
            type: 'tier_gate_pop_failed',
            ip,
            sessionId,
            details: { path, method, reason: popResult.reason },
          });
          // Only destroy session for actual replay/forgery — missing headers are not an attack
          // and nuking the session would cascade-break the bridge iframe.
          const isReplayAttack = popResult.reason === 'nonce_reused' ||
            popResult.reason === 'pop_signature_invalid';
          if (isReplayAttack) {
            dbg('gate', 'pop_replay_destroying_session', { sessionIdShort: sessionId.slice(0, 8), reason: popResult.reason });
            deleteSession(sessionId);
          }
          return c.json({ error: 'Authentication required' }, 401);
        }
        dbg('gate', 'pop_verified', { path, method, sessionIdShort: sessionId.slice(0, 8) });
        // Flag so downstream verifyRequestPoP() short-circuits instead of re-claiming nonce.
        c.set('popVerified', true);
      } else {
        dbg('gate', 'pop_skipped', {
          path, method, sessionIdShort: sessionId.slice(0, 8),
          isPopSetup, isConsoleInboxStream, hasSw,
          isGenuineNavigation, isStaticAssetUrl,
        });
      }
    } else {
      dbg('gate', 'pop_not_bound_yet', { sessionIdShort: sessionId.slice(0, 8) });
    }
  } else {
    // Standard tier: JWT
    const jwt = verifyJwtToken(c.req);
    if (!jwt) {
      dbg('gate', 'reject_no_jwt', { path, method, tier, ip });
      logAuditEvent({
        type: 'tier_gate_denied',
        ip,
        details: { path, method, tier, reason: 'no_jwt' },
      });
      return c.json({ error: 'Authentication required' }, 401);
    }
    dbg('gate', 'jwt_verified', { path, method, sub: jwt.sub, jti: jwt.jti });

    c.set('tierGateAuth', {
      tier: 'standard' as const,
      userId: jwt.sub,
      jwtId: jwt.jti,
    });
  }

  // ── STS token: optional X-STS-Token → c.get('stsProject') for provable project isolation ──
  const stsToken = c.req.header('x-sts-token');
  if (stsToken) {
    const auth = c.get('tierGateAuth');
    const sessionId = auth?.sessionId || auth?.jwtId;

    const stsResult = verifyProjectTokenDetailed(stsToken, sessionId || undefined);
    if (!stsResult.valid) {
      // Report expiry ONLY for signature-verified tokens (prevents oracle attack).
      if (stsResult.reason === 'expired') {
        return c.json({ error: 'STS token expired', code: STS_EXPIRED_CODE }, 401);
      }
      return c.json({ error: 'Invalid STS token', code: STS_INVALID_CODE }, 401);
    }

    // sub = immutable infrastructure slug (the only project id in lean STS payload).
    c.set('stsProject', stsResult.payload.sub);
  }

  return next();
});
