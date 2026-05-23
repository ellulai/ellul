// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Token Routes
 *
 * Short-lived token authorization and validation for:
 * - Terminal (ttyd) access
 * - Code browser (file-api) access
 * - Agent bridge (Workbench) access
 *
 * Endpoints:
 * - POST /_auth/terminal/authorize - Get terminal token
 * - POST /_auth/terminal/validate  - Validate terminal token
 * - POST /_auth/code/authorize     - Get code browser token
 * - POST /_auth/code/validate      - Validate code browser token
 * - POST /_auth/agent/authorize    - Get agent bridge token
 * - POST /_auth/agent/validate     - Validate agent bridge token
 * - POST /_auth/client/exchange    - Exchange one-time code for session (VS Code, CLI, etc.)
 */

import crypto from 'crypto';
import type { Hono } from 'hono';
import { db } from '../database';
import { SVC_USER } from '../config';
import { getCurrentTier } from '../application/gates/Tier';
import { getClientIp } from '../auth/fingerprint';
import { verifyPopSignature } from '../auth/pop';
import { consumeExchangeCode } from '../auth/session';
import { checkApiRateLimit } from '../application/platform/RateLimiter';
import { logAuditEvent } from '../application/audit/Audit';
import { parseCookies, codeSessionCookie } from '../utils/cookie';
import { generateCspNonce, getCspHeader } from '../utils/csp';
import type { CodeSessionResponse } from '../../../../../auth/bridge-contracts';

interface TokenData {
  sessionId: string;
  ip: string;
  expiresAt: number;
  tier: string;
}

interface CodeTokenData {
  sessionId: string;
  ip: string;
  expiresAt: number;
  tier: string;
}

interface CodeSessionData {
  parentSessionId: string;
  credentialId: string;
  ip: string;
  createdAt: number;
  expiresAt: number;
  tier: string;
}

// In-memory token stores (short-lived, single-use)
const terminalTokens = new Map<string, TokenData>();
const codeTokens = new Map<string, CodeTokenData>();
const agentTokens = new Map<string, TokenData>();
const codeSessions = new Map<string, CodeSessionData>();

// Cleanup expired term sessions from SQLite every 60s
setInterval(() => {
  try {
    db.prepare('DELETE FROM term_sessions WHERE expires_at < ?').run(Date.now());
  } catch { /* ignore */ }
}, 60000);

// Token expiration times
const TERMINAL_TOKEN_TTL = 60 * 1000;  // 60 seconds (single-use for auth, allows slow iframe loads)
const TERM_SESSION_TTL = 30 * 60 * 1000; // 30 minutes (terminal session cookie)
const CODE_TOKEN_TTL = 5 * 60 * 1000;  // 5 minutes
const AGENT_TOKEN_TTL = 30 * 1000;     // 30 seconds
const CODE_SESSION_TTL = 30 * 60 * 1000;  // 30 minutes (code subdomain session)

// Cleanup expired tokens periodically
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of terminalTokens) {
    if (data.expiresAt < now) terminalTokens.delete(token);
  }
  for (const [token, data] of codeTokens) {
    if (data.expiresAt < now) codeTokens.delete(token);
  }
  for (const [token, data] of agentTokens) {
    if (data.expiresAt < now) agentTokens.delete(token);
  }
  for (const [sessionId, data] of codeSessions) {
    if (data.expiresAt < now) codeSessions.delete(sessionId);
  }
}, 10000);

/**
 * Register token routes on Hono app
 */
export function registerTokenRoutes(app: Hono): void {
  /**
   * Authorize terminal access - returns short-lived token
   * Tier-aware: standard (JWT), web_locked (passkey+PoP)
   */
  app.post('/_auth/terminal/authorize', async (c) => {
    const tier = getCurrentTier();
    const ip = getClientIp(c);

    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Too many requests' }, 429);
    }

    // Auth already verified by tier-gate middleware
    let sessionId: string;
    if (tier === 'standard') {
      sessionId = 'jwt:' + crypto.randomBytes(8).toString('hex');
    } else {
      sessionId = parseCookies(c.req.header('cookie')).shield_session!;
    }

    // Generate short-lived token
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + TERMINAL_TOKEN_TTL;

    terminalTokens.set(token, {
      sessionId,
      ip,
      expiresAt,
      tier
    });

    console.log('[shield] Terminal token issued (tier: ' + tier + ')');
    return c.json({ token, expiresAt, tier });
  });

  /**
   * Validate terminal token (called by term-proxy)
   * Tier-aware: standard tokens don't require session binding
   *
   * Token is single-use - consumed on first WebSocket connection.
   * Once connected, the WebSocket stays authenticated for its lifetime.
   */
  app.post('/_auth/terminal/validate', async (c) => {
    const body = await c.req.json() as { token?: string; sessionId?: string };
    const { token, sessionId } = body;

    if (!token) {
      return c.json({ valid: false, reason: 'missing_token' }, 400);
    }

    // ATOMIC: Get and delete token immediately (single-use)
    const tokenData = terminalTokens.get(token);
    if (!tokenData) {
      return c.json({ valid: false, reason: 'token_not_found' });
    }

    // Delete immediately - token is single-use
    terminalTokens.delete(token);

    // Check expiration
    if (tokenData.expiresAt < Date.now()) {
      return c.json({ valid: false, reason: 'token_expired' });
    }

    // Session binding only required for web_locked tier
    // Standard tier tokens are bound to JWT, not shield_session
    if (tokenData.tier !== 'standard') {
      if (!sessionId) {
        return c.json({ valid: false, reason: 'session_required_for_web_locked' });
      }
      if (tokenData.sessionId !== sessionId) {
        console.log('[shield] Terminal token session mismatch - potential attack:', {
          expectedSession: tokenData.sessionId.substring(0, 8),
          providedSession: sessionId.substring(0, 8)
        });
        return c.json({ valid: false, reason: 'session_mismatch' });
      }
    }

    console.log('[shield] Terminal token validated (tier: ' + tokenData.tier + ')');
    return c.json({ valid: true, ip: tokenData.ip, tier: tokenData.tier, sessionId: tokenData.sessionId });
  });

  /**
   * Check if a shield session is still valid (internal use by term-proxy)
   * Returns valid: true only if session exists and hasn't been revoked
   */
  app.post('/_auth/session/check', async (c) => {
    const body = await c.req.json() as { sessionId?: string };
    if (!body.sessionId) {
      return c.json({ valid: false, reason: 'missing_session_id' }, 400);
    }

    const session = db.prepare('SELECT id, expires_at, pop_hmac_key FROM sessions WHERE id = ?')
      .get(body.sessionId) as { id: string; expires_at: number; pop_hmac_key: string | null } | undefined;

    if (!session) {
      return c.json({ valid: false, reason: 'session_not_found' });
    }

    if (session.expires_at < Date.now()) {
      return c.json({ valid: false, reason: 'session_expired' });
    }

    const tier = getCurrentTier();

    // For web_locked tier, require PoP HMAC key to be bound (ML-KEM derived)
    if (tier !== 'standard' && !session.pop_hmac_key) {
      return c.json({ valid: false, reason: 'pop_not_bound' });
    }

    return c.json({ valid: true, hasPoP: !!session.pop_hmac_key, tier });
  });

  /**
   * Create a terminal session (called by term-proxy after token validation).
   * Stores session in sovereign-shield's memory so it survives term-proxy restarts.
   */
  app.post('/_auth/terminal/session/create', async (c) => {
    const body = await c.req.json() as {
      ip?: string;
      shieldSessionId?: string;
      tier?: string;
    };

    const sessionId = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    db.prepare(
      'INSERT INTO term_sessions (id, ip, shield_session_id, tier, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(sessionId, body.ip || '', body.shieldSessionId || '', body.tier || '', now, now + TERM_SESSION_TTL);

    return c.json({ sessionId });
  });

  /**
   * Validate a terminal session (called by term-proxy on WebSocket upgrade).
   * Checks session exists, not expired, IP matches, and shield_session still valid.
   */
  app.post('/_auth/terminal/session/validate', async (c) => {
    const body = await c.req.json() as {
      termSessionId?: string;
      ip?: string;
      shieldSessionId?: string;
    };

    if (!body.termSessionId) {
      return c.json({ valid: false, reason: 'missing_session_id' }, 400);
    }

    const session = db.prepare('SELECT * FROM term_sessions WHERE id = ?')
      .get(body.termSessionId) as { id: string; ip: string; shield_session_id: string; tier: string; created_at: number; expires_at: number } | undefined;

    if (!session) {
      return c.json({ valid: false, reason: 'session_not_found' });
    }

    if (session.expires_at < Date.now()) {
      db.prepare('DELETE FROM term_sessions WHERE id = ?').run(body.termSessionId);
      return c.json({ valid: false, reason: 'session_expired' });
    }

    // IP binding: Log for security monitoring but don't reject
    // Users on mobile networks or VPNs may have IP changes mid-session
    if (session.ip && body.ip && session.ip !== body.ip) {
      console.log('[shield] Term session IP changed:', session.ip.substring(0, 10), '->', body.ip.substring(0, 10));
    }

    // Shield session binding removed: shield_session IDs rotate (every 15min) and
    // re-authentication deletes old sessions entirely, causing false rejections.
    // Term sessions already have 30-min expiry + IP binding which is sufficient.

    // Refresh session TTL on activity (sliding window) - keeps active terminals alive
    const newExpiresAt = Date.now() + TERM_SESSION_TTL;
    db.prepare('UPDATE term_sessions SET expires_at = ? WHERE id = ?').run(newExpiresAt, body.termSessionId);

    return c.json({ valid: true });
  });

  /**
   * Authorize code browser access - returns short-lived token
   * Tier-aware: standard (JWT), web_locked (passkey+PoP)
   */
  app.post('/_auth/code/authorize', async (c) => {
    const tier = getCurrentTier();
    const ip = getClientIp(c);

    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Too many requests' }, 429);
    }

    // Auth already verified by tier-gate middleware
    let sessionId: string;
    if (tier === 'standard') {
      sessionId = 'jwt:' + crypto.randomBytes(8).toString('hex');
    } else {
      sessionId = parseCookies(c.req.header('cookie')).shield_session!;
    }

    // Generate short-lived token
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + CODE_TOKEN_TTL;

    codeTokens.set(token, {
      sessionId,
      ip,
      expiresAt,
      tier
    });

    // Clean up expired tokens periodically
    if (codeTokens.size > 100) {
      const now = Date.now();
      for (const [t, data] of codeTokens.entries()) {
        if (data.expiresAt < now) codeTokens.delete(t);
      }
    }

    console.log('[shield] Code token issued (tier: ' + tier + ')');
    return c.json({ token, expiresAt, tier });
  });

  /**
   * Validate code browser token (called by file-api)
   * SECURITY: Code tokens are now single-use to prevent token theft exploitation
   */
  app.post('/_auth/code/validate', async (c) => {
    const body = await c.req.json() as { token?: string };
    const { token } = body;

    if (!token) {
      return c.json({ valid: false, reason: 'missing_token' }, 400);
    }

    // ATOMIC: Get and delete token immediately to prevent reuse
    const tokenData = codeTokens.get(token);
    if (!tokenData) {
      return c.json({ valid: false, reason: 'token_not_found' });
    }

    // Single-use: delete immediately before validation
    codeTokens.delete(token);

    if (tokenData.expiresAt < Date.now()) {
      return c.json({ valid: false, reason: 'token_expired' });
    }

    // SECURITY: Code tokens are single-use for maximum security
    // Client pre-fetches next token in background after each use
    return c.json({ valid: true, sessionId: tokenData.sessionId, tier: tokenData.tier });
  });

  /**
   * Create a code session for the code subdomain.
   * This is a longer-lived session that allows access to the code browser
   * without requiring PoP on every request (PoP was verified when creating this session).
   *
   * SECURITY: Requires passkey + PoP authentication to create.
   * The code session is bound to the parent session and IP.
   */
  app.post('/_auth/code/session', async (c) => {
    const tier = getCurrentTier();
    const ip = getClientIp(c);

    // Auth already verified by tier-gate middleware
    let sessionId: string;
    let credentialId: string;

    if (tier === 'standard') {
      sessionId = 'jwt:' + crypto.randomBytes(8).toString('hex');
      credentialId = 'jwt-user';
    } else {
      sessionId = parseCookies(c.req.header('cookie')).shield_session!;
      // Fetch credential_id from validated session (middleware guarantees it exists)
      const session = db.prepare('SELECT credential_id FROM sessions WHERE id = ?')
        .get(sessionId) as { credential_id: string };
      credentialId = session.credential_id;
    }

    // Create code session
    const codeSessionId = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    const expiresAt = now + CODE_SESSION_TTL;

    codeSessions.set(codeSessionId, {
      parentSessionId: sessionId,
      credentialId,
      ip,
      createdAt: now,
      expiresAt,
      tier
    });

    // Cleanup old sessions if too many
    if (codeSessions.size > 100) {
      for (const [id, data] of codeSessions.entries()) {
        if (data.expiresAt < now) codeSessions.delete(id);
      }
    }

    console.log('[shield] Code session created (tier: ' + tier + ')');
    // `satisfies` pins this to the bridge contract — if the contract shape
    // changes (e.g. field renamed), this return is a compile error rather
    // than a silent wire-shape drift that breaks the console's WS auth.
    return c.json({ codeSessionId, expiresAt, tier } satisfies CodeSessionResponse);
  });

  /**
   * Validate a code session (used by forward_auth for code subdomain)
   */
  app.post('/_auth/code/session/validate', async (c) => {
    const body = await c.req.json() as { codeSessionId?: string; ip?: string };
    const { codeSessionId, ip: requestIp } = body;

    if (!codeSessionId) {
      return c.json({ valid: false, reason: 'missing_session_id' }, 400);
    }

    const sessionData = codeSessions.get(codeSessionId);
    if (!sessionData) {
      return c.json({ valid: false, reason: 'session_not_found' });
    }

    const now = Date.now();
    if (sessionData.expiresAt < now) {
      codeSessions.delete(codeSessionId);
      return c.json({ valid: false, reason: 'session_expired' });
    }

    // IP binding is non-blocking on this path — the code-session validate is
    // called frequently by forward_auth, and CGNAT / carrier-NAT clients see
    // their public IP rotate between adjacent addresses every few seconds.
    // We only surface the event when the new IP crosses a binding class
    // boundary (different /24 for IPv4, different /64 for IPv6), which is
    // the cross-network replay signal worth investigating. Intra-class drift
    // is suppressed entirely to keep the journal clean.
    if (requestIp && sessionData.ip !== requestIp) {
      const { ipBindingClass } = await import('../utils/ip-binding');
      if (ipBindingClass(sessionData.ip) !== ipBindingClass(requestIp)) {
        console.log('[shield] Code session IP class mismatch:', {
          expected: sessionData.ip,
          actual: requestIp,
          expectedClass: ipBindingClass(sessionData.ip),
          actualClass: ipBindingClass(requestIp),
        });
      }
    }

    return c.json({
      valid: true,
      credentialId: sessionData.credentialId,
      tier: sessionData.tier
    });
  });

  /**
   * Report full session status for a code session.
   *
   * Called by file-api on a ~30s tick (localhost) to push `session_status`
   * events to connected WebSocket clients, replacing the browser's 60s
   * /_auth/session/keepalive poll. Returns liveness for the code session's
   * parent shield session, plus the effective expiry (minimum of session
   * TTL, absolute expiry, and idle deadline) so the UI can show accurate
   * "expires in N minutes" and proactive warnings without polling.
   *
   * Standard tier sessions are JWT-backed (no parent shield session); we
   * report them alive until the code session itself expires, since the JWT
   * cookie is managed independently by Caddy.
   */
  app.post('/_auth/code/session/status', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { codeSessionId?: string };
    const { codeSessionId } = body;
    const now = Date.now();

    if (!codeSessionId) {
      return c.json({ alive: false, reason: 'missing_session_id' }, 400);
    }

    const codeSession = codeSessions.get(codeSessionId);
    if (!codeSession) {
      return c.json({ alive: false, reason: 'session_not_found' });
    }

    if (codeSession.expiresAt < now) {
      codeSessions.delete(codeSessionId);
      return c.json({ alive: false, reason: 'code_session_expired' });
    }

    // Standard tier: JWT-backed, no parent shield session row.
    // Report alive with the code session's own expiry as the deadline.
    if (codeSession.tier === 'standard' || codeSession.parentSessionId.startsWith('jwt:')) {
      return c.json({
        alive: true,
        tier: codeSession.tier,
        effectiveExpiresAt: codeSession.expiresAt,
        sessionExpiresAt: null,
        absoluteExpiry: null,
        idleDeadline: null,
      });
    }

    const session = db.prepare('SELECT * FROM sessions WHERE id = ?')
      .get(codeSession.parentSessionId) as {
        absolute_expiry: number;
        expires_at: number;
        last_activity: number;
      } | undefined;

    if (!session) {
      return c.json({ alive: false, reason: 'shield_session_not_found' });
    }

    if (now > session.absolute_expiry) {
      return c.json({ alive: false, reason: 'absolute_expiry' });
    }
    if (now > session.expires_at) {
      return c.json({ alive: false, reason: 'session_timeout' });
    }

    const { getSessionPolicy } = await import('../application/platform/SessionPolicy');
    const { idleTimeoutMs } = getSessionPolicy();
    const idleDeadline = session.last_activity + idleTimeoutMs;
    if (now > idleDeadline) {
      return c.json({ alive: false, reason: 'idle_timeout' });
    }

    const effectiveExpiresAt = Math.min(
      session.expires_at,
      session.absolute_expiry,
      idleDeadline,
    );

    return c.json({
      alive: true,
      tier: codeSession.tier,
      effectiveExpiresAt,
      sessionExpiresAt: session.expires_at,
      absoluteExpiry: session.absolute_expiry,
      idleDeadline,
    });
  });

  /**
   * Establish a code session cookie on the code subdomain.
   * Called by the dashboard's CodeTokenContext to set __Host-code_session cookie.
   * After this, all file-api requests use the cookie (multi-use, 30min TTL)
   * instead of single-use X-Code-Token headers — dramatically reducing request count.
   *
   * The code session ID comes from the bridge (get_code_session) which already
   * validated passkey + PoP. This endpoint just sets the cookie.
   */
  app.get('/_auth/code/establish', async (c) => {
    const codeSessionId = c.req.query('_code_session');
    if (!codeSessionId) {
      return c.json({ error: 'Missing _code_session parameter' }, 400);
    }

    const sessionData = codeSessions.get(codeSessionId);
    if (!sessionData) {
      return c.json({ error: 'Invalid or expired code session' }, 401);
    }

    if (sessionData.expiresAt < Date.now()) {
      codeSessions.delete(codeSessionId);
      return c.json({ error: 'Code session expired' }, 401);
    }

    const maxAge = Math.floor((sessionData.expiresAt - Date.now()) / 1000);
    c.header('Set-Cookie', codeSessionCookie(codeSessionId, maxAge));

    console.log('[shield] Code session cookie established for:', sessionData.credentialId?.substring(0, 8));
    return c.json({ established: true, expiresAt: sessionData.expiresAt });
  });

  /**
   * Authorize agent bridge access - returns short-lived token
   * Tier-aware: standard (JWT), web_locked (passkey+PoP)
   */
  app.post('/_auth/agent/authorize', async (c) => {
    const tier = getCurrentTier();
    const ip = getClientIp(c);

    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Too many requests' }, 429);
    }

    // Auth already verified by tier-gate middleware
    let sessionId: string;
    if (tier === 'standard') {
      sessionId = 'jwt:' + crypto.randomBytes(8).toString('hex');
    } else {
      sessionId = parseCookies(c.req.header('cookie')).shield_session!;
    }

    // Generate short-lived token
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + AGENT_TOKEN_TTL;

    agentTokens.set(token, {
      sessionId,
      ip,
      expiresAt,
      tier
    });

    console.log('[shield] Agent token issued (tier: ' + tier + ')');
    return c.json({ token, expiresAt, tier });
  });

  /**
   * Validate agent bridge token (called by agent-bridge)
   */
  app.post('/_auth/agent/validate', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ valid: false, reason: 'rate_limited' }, 429);
    }

    const body = await c.req.json() as { token?: string };
    const { token } = body;

    if (!token) {
      return c.json({ valid: false, reason: 'missing_token' }, 400);
    }

    // ATOMIC: Get and delete token immediately to prevent race condition
    const tokenData = agentTokens.get(token);
    if (!tokenData) {
      return c.json({ valid: false, reason: 'token_not_found' });
    }

    // Atomically remove from map BEFORE validation
    agentTokens.delete(token);

    if (tokenData.expiresAt < Date.now()) {
      return c.json({ valid: false, reason: 'token_expired' });
    }

    console.log('[shield] Agent token validated for session:', tokenData.sessionId.substring(0, 8));
    return c.json({ valid: true, sessionId: tokenData.sessionId });
  });

  /**
   * Verify a WebSocket PoP challenge-response (called by agent-bridge / file-api).
   * Internal-only (localhost). Verifies HMAC-SHA256 over 'challenge|' + challenge.
   *
   * Auditing: signature_invalid is the attack signal (cookie stolen without
   * the HMAC key) and gets audit-logged at every occurrence so operators can
   * trend on it. session_not_found / no_pop_key are benign lifecycle states
   * (cookie rotated, PoP not yet bound, session GC'd) — NOT audit-logged to
   * avoid drowning real signals.
   */
  app.post('/_auth/pop/verify-challenge', async (c) => {
    const body = await c.req.json() as { sessionId?: string; challenge?: string; signature?: string };
    const { sessionId, challenge, signature } = body;

    if (!sessionId || !challenge || !signature) {
      return c.json({ valid: false, reason: 'missing_params' }, 400);
    }

    const session = db.prepare('SELECT pop_hmac_key FROM sessions WHERE id = ?')
      .get(sessionId) as { pop_hmac_key: string | null } | undefined;

    if (!session) {
      return c.json({ valid: false, reason: 'session_not_found' });
    }

    if (!session.pop_hmac_key) {
      return c.json({ valid: false, reason: 'no_pop_key' });
    }

    const payload = 'challenge|' + challenge;
    const valid = await verifyPopSignature(session.pop_hmac_key, payload, signature);

    if (!valid) {
      logAuditEvent({
        type: 'ws_pop_challenge_invalid',
        sessionId,
        details: {
          reason: 'signature_invalid',
          challenge_len: challenge.length,
          signature_len: signature.length,
        },
      });
      return c.json({ valid: false, reason: 'signature_invalid' });
    }

    return c.json({ valid: true });
  });

  /**
   * Code redirect page - helps users get a code session via passkey+PoP
   * This page loads the bridge, authenticates, gets a code session, and redirects
   */
  app.get('/_auth/code/redirect', async (c) => {
    const target = c.req.query('target') || '/';
    const nonce = generateCspNonce();
    c.header('Content-Security-Policy', getCspHeader(nonce));

    return c.html(`<!DOCTYPE html>
<html>
<head>
  <title>Authenticating...</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style nonce="${nonce}">
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0B0B0F;
      color: white;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      text-align: center;
      padding: 2rem;
    }
    .spinner {
      width: 48px;
      height: 48px;
      border: 3px solid rgba(245,239,230,0.08);
      border-top-color: #7c3aed;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 1.5rem;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    p { color: rgba(245,239,230,0.45); font-size: 0.9rem; }
    .error { color: #E5806B; margin-top: 1rem; display: none; }
    button {
      margin-top: 1rem;
      padding: 0.75rem 1.5rem;
      background: #7c3aed;
      color: white;
      border: none;
      border-radius: 0.5rem;
      cursor: pointer;
      font-size: 1rem;
    }
    button:hover { background: #6d28d9; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-icon { display: flex; align-items: center; }
    .btn-icon svg { width: 18px; height: 18px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="spinner" id="spinner"></div>
    <h1 id="status">Sovereign Shield</h1>
    <p id="message">Verifying session...</p>
    <p class="error" id="error"></p>
    <button id="authBtn" style="display: none;"><span class="btn-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></span>Authenticate</button>
  </div>

  <!-- Load PoP script -->
  <script nonce="${nonce}" src="/_auth/static/session-pop.js"></script>
  <script nonce="${nonce}" type="module">
    import { startAuthentication } from '/_auth/static/simplewebauthn-browser.js';

    const TARGET_URL = ${JSON.stringify(target)};

    async function initPoP() {
      if (typeof SESSION_POP === 'undefined') {
        throw new Error('SESSION_POP not available');
      }
      await SESSION_POP.initialize();
      SESSION_POP.wrapFetch();
    }

    async function checkSession() {
      const res = await fetch('/_auth/bridge/session', { credentials: 'include' });
      return res.ok;
    }

    async function doPasskeyAuth() {
      document.getElementById('message').textContent = 'Waiting for passkey...';

      const optionsRes = await fetch('/_auth/login/options', {
        method: 'POST',
        credentials: 'include'
      });
      if (!optionsRes.ok) {
        const err = await optionsRes.json();
        throw new Error(err.error || 'Failed to get auth options');
      }

      const options = await optionsRes.json();
      const credential = await startAuthentication({ optionsJSON: options });

      const verifyRes = await fetch('/_auth/login/verify', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assertion: credential })
      });

      if (!verifyRes.ok) {
        const err = await verifyRes.json();
        throw new Error(err.error || 'Passkey verification failed');
      }

      return await verifyRes.json();
    }

    async function getCodeSession() {
      document.getElementById('message').textContent = 'Getting code session...';

      const res = await fetch('/_auth/code/session', {
        method: 'POST',
        credentials: 'include'
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to get code session');
      }

      return await res.json();
    }

    function redirectWithCodeSession(codeSessionId) {
      const targetUrl = new URL(TARGET_URL, window.location.origin);
      targetUrl.searchParams.set('_code_session', codeSessionId);
      window.location.href = targetUrl.toString();
    }

    function revealButton(message) {
      document.getElementById('spinner').style.display = 'none';
      document.getElementById('status').textContent = 'Sovereign Shield';
      document.getElementById('message').textContent = message || 'Authenticate with your passkey to continue';
      document.getElementById('authBtn').style.display = 'inline-flex';
      document.getElementById('authBtn').disabled = false;
      document.getElementById('authBtn').innerHTML = '<span class="btn-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></span>Authenticate';
    }

    // On page load: if the user already has a valid session, silently issue a
    // code session and redirect — no button flash, no extra click. Only fall
    // back to the passkey button when we actually need a user gesture.
    (async function autoRedirect() {
      try {
        await initPoP();
        if (!await checkSession()) {
          revealButton();
          return;
        }
        const { codeSessionId } = await getCodeSession();
        document.getElementById('message').textContent = 'Redirecting...';
        redirectWithCodeSession(codeSessionId);
      } catch (err) {
        console.warn('Silent auth failed, falling back to button:', err);
        revealButton();
      }
    })();

    window.startAuth = async function() {
      document.getElementById('spinner').style.display = 'block';
      document.getElementById('status').textContent = 'Authenticating...';
      document.getElementById('message').textContent = 'Please wait...';
      document.getElementById('error').style.display = 'none';
      document.getElementById('authBtn').disabled = true;
      document.getElementById('authBtn').innerHTML = 'Authenticating...';

      try {
        await initPoP();

        const hasSession = await checkSession();
        if (!hasSession) {
          await doPasskeyAuth();
          await initPoP();
        }

        const { codeSessionId } = await getCodeSession();

        document.getElementById('status').textContent = 'Success!';
        document.getElementById('message').textContent = 'Redirecting...';
        redirectWithCodeSession(codeSessionId);

      } catch (err) {
        console.error('Auth error:', err);
        document.getElementById('spinner').style.display = 'none';
        document.getElementById('status').textContent = 'Authentication Failed';
        document.getElementById('message').textContent = err.name === 'NotAllowedError' ? 'Authentication cancelled.' : '';
        document.getElementById('error').textContent = err.name === 'NotAllowedError' ? '' : (err.message || 'Unknown error');
        document.getElementById('error').style.display = err.name === 'NotAllowedError' ? 'none' : 'block';
        document.getElementById('authBtn').disabled = false;
        document.getElementById('authBtn').innerHTML = '<span class="btn-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></span>Authenticate';
      }
    };
    // Bind click handler via JS (not inline onclick — CSP blocks inline handlers)
    document.getElementById('authBtn').addEventListener('click', window.startAuth);
  </script>
</body>
</html>`);
  });

  /**
   * Exchange a one-time code for session data (local client callback).
   *
   * Local clients (VS Code extension, CLI daemon, etc.) cannot use cookies.
   * After passkey auth in the browser, the login page redirects to the local
   * callback server with an exchange code. The client exchanges it here for
   * session metadata.
   *
   * SECURITY: This endpoint is AUTH_FLOW (no session required) — the exchange code
   * IS the auth proof. Additional protections:
   *
   * 1. Exchange code is single-use (consumed atomically) and expires in 30 seconds
   * 2. Only web_locked tier allowed (passkey-authenticated sessions only)
   * 3. PoP public key + bind signature REQUIRED in the same request — eliminates
   *    the race window between exchange and PoP bind. The session is never usable
   *    without PoP because the key is bound atomically during exchange.
   * 4. Rate limited per IP
   * 5. Audit logged on success and failure
   */
  app.post('/_auth/client/exchange', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Too many requests' }, 429);
    }

    const body = await c.req.json() as {
      code?: string;
      popPublicKey?: string;
      popTimestamp?: string;
      popSignature?: string;
    };

    if (!body.code) {
      return c.json({ error: 'Missing exchange code' }, 400);
    }

    // SECURITY: Require PoP proof in the same request as exchange.
    // This eliminates the race window where a stolen exchange code could
    // create a session without PoP (which would bypass all PoP enforcement
    // since tier-gate only checks PoP if pop_hmac_key is set).
    // CLI must complete ML-KEM bind flow after exchange to establish pop_hmac_key.
    if (!body.popPublicKey || !body.popTimestamp || !body.popSignature) {
      return c.json({ error: 'PoP proof required (popPublicKey, popTimestamp, popSignature)' }, 400);
    }

    // Validate PoP timestamp freshness
    const reqTime = parseInt(body.popTimestamp, 10);
    if (isNaN(reqTime) || Math.abs(Date.now() - reqTime) > 30_000) {
      return c.json({ error: 'PoP timestamp expired' }, 400);
    }

    // Verify the caller holds the private key for the claimed public key
    const bindPayload = 'bind|' + body.popTimestamp;
    const popValid = await verifyPopSignature(body.popPublicKey, bindPayload, body.popSignature);
    if (!popValid) {
      logAuditEvent({ type: 'client_exchange_failed', ip, details: { reason: 'pop_signature_invalid' } });
      return c.json({ error: 'Invalid PoP signature — cannot prove key ownership' }, 401);
    }

    // Consume exchange code (single-use, atomic)
    const exchangeData = consumeExchangeCode(body.code);
    if (!exchangeData) {
      logAuditEvent({ type: 'client_exchange_failed', ip, details: { reason: 'invalid_or_expired_code' } });
      return c.json({ error: 'Invalid or expired exchange code' }, 401);
    }

    if (exchangeData.tier === 'standard' || !exchangeData.sessionId) {
      logAuditEvent({ type: 'client_exchange_failed', ip, details: { reason: 'not_web_locked' } });
      return c.json({ error: 'Client exchange requires web_locked tier' }, 403);
    }

    // Look up session to get expiry
    const session = db.prepare('SELECT expires_at, pop_hmac_key FROM sessions WHERE id = ?')
      .get(exchangeData.sessionId) as { expires_at: number; pop_hmac_key: string | null } | undefined;

    if (!session) {
      return c.json({ error: 'Session not found' }, 401);
    }

    // SECURITY: PoP HMAC key is bound via ML-KEM bind flow (/_auth/pop/bind/init + /complete).
    // Client exchange does NOT bind PoP — it only validates the session exists.
    // The CLI must perform ML-KEM bind after exchange to establish pop_hmac_key.
    if (session.pop_hmac_key) {
      // Already bound — extension/CLI will use this session with existing HMAC key
    }
    // If not yet bound, the CLI must call /_auth/pop/bind/init + /complete after exchange

    // Generate operator bind nonce (single-use, for daemon operator key binding)
    const operatorBindNonce = crypto.randomBytes(32).toString('hex');
    db.prepare('UPDATE sessions SET operator_bind_nonce = ? WHERE id = ?')
      .run(operatorBindNonce, exchangeData.sessionId);

    const tier = getCurrentTier();

    logAuditEvent({
      type: 'client_exchange_success',
      ip,
      sessionId: exchangeData.sessionId,
      details: { tier, popKeyPrefix: body.popPublicKey.substring(0, 20) + '...' },
    });

    return c.json({
      sessionId: exchangeData.sessionId,
      tier,
      svcUser: SVC_USER,
      expiresAt: session.expires_at,
      operatorBindNonce,
    });
  });
}

/**
 * Inline code-token validation — direct Map lookup, no HTTP self-call.
 * Used by forward_auth handler to avoid self-referencing fetch deadlock in proot.
 */
export function validateCodeTokenInline(token: string): { valid: boolean; sessionId?: string; tier?: string; reason?: string } {
  const tokenData = codeTokens.get(token);
  if (!tokenData) return { valid: false, reason: 'token_not_found' };
  codeTokens.delete(token);
  if (tokenData.expiresAt < Date.now()) return { valid: false, reason: 'token_expired' };
  return { valid: true, sessionId: tokenData.sessionId, tier: tokenData.tier };
}

/**
 * Inline code-session validation — direct Map lookup, no HTTP self-call.
 * Used by forward_auth handler to avoid self-referencing fetch deadlock in proot.
 */
export function validateCodeSessionInline(codeSessionId: string, requestIp?: string): { valid: boolean; credentialId?: string; tier?: string; reason?: string } {
  const sessionData = codeSessions.get(codeSessionId);
  if (!sessionData) return { valid: false, reason: 'session_not_found' };
  if (sessionData.expiresAt < Date.now()) {
    codeSessions.delete(codeSessionId);
    return { valid: false, reason: 'session_expired' };
  }
  if (requestIp && sessionData.ip !== requestIp) {
    import('../utils/ip-binding').then(({ ipBindingClass }) => {
      if (ipBindingClass(sessionData.ip) !== ipBindingClass(requestIp)) {
        console.log('[shield] Code session IP class mismatch:', {
          expected: sessionData.ip, actual: requestIp,
          expectedClass: ipBindingClass(sessionData.ip),
          actualClass: ipBindingClass(requestIp),
        });
      }
    }).catch(() => {});
  }
  return { valid: true, credentialId: sessionData.credentialId, tier: sessionData.tier };
}

/**
 * Validate a code session ID against the in-memory store.
 * Used by gate endpoints to require browser-authenticated sessions.
 * Returns true only if the session exists and hasn't expired.
 */
export function validateCodeSession(sessionId: string): boolean {
  const session = codeSessions.get(sessionId);
  if (!session) return false;
  if (session.expiresAt < Date.now()) {
    codeSessions.delete(sessionId);
    return false;
  }
  return true;
}

// Export token stores for cleanup interval setup in main
export { terminalTokens, codeTokens, agentTokens, codeSessions };
