// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Login Routes
 *
 * Passkey authentication (WebAuthn) flow.
 *
 * Endpoints:
 * - GET  /_auth/login         - Login UI page
 * - POST /_auth/login/options - Generate authentication options
 * - POST /_auth/login/verify  - Verify authentication response
 * - POST /_auth/logout        - Logout (clear session)
 */

import crypto from 'crypto';
import type { Hono } from 'hono';
import { db } from '../database';
import { RP_NAME, readAllowedOrigins, resolveRpId, CONSOLE_ORIGIN, PLATFORM_ZONE, APP_ZONE } from '../config';
import { getDeviceFingerprint, getClientIp } from '../auth/fingerprint';
import { createSession, clearSessionCookie, setSessionCookie, createSessionExchangeCode, consumeExchangeCode, type Session } from '../auth/session';
import { checkRateLimit, recordAuthAttempt } from '../application/platform/RateLimiter';
import { logAuditEvent } from '../application/audit/Audit';
import { dbg } from '../application/audit/DebugLog';
import { parseCookies } from '../utils/cookie';
import { generateCspNonce, getCspHeader } from '../utils/csp';
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  storeChallenge,
  getChallenge,
  buildAllowCredentials,
  type CredentialRecord,
} from '../auth/webauthn';

/**
 * Register login routes on Hono app
 */
export function registerLoginRoutes(app: Hono, hostname: string): void {
  // Origin allowlist is written to /etc/ellul/allowed-origins at provisioning
  // and merged with the optional custom-domain file at read time. Read once at
  // registration — file contents are append-only from provisioning's POV.
  const ORIGINS = readAllowedOrigins();
  // RP_ID is resolved PER REQUEST via resolveRpId(host). Setting a single RP_ID
  // at registration would break custom-domain support (RP ID must be a suffix
  // of the origin; ellul.ai is not a suffix of acme.com). See config.ts.
  // `hostname` is still passed through for cookie domain binding in setSessionCookie.

  /**
   * Login UI page
   */
  app.get('/_auth/login', async (c) => {
    const nonce = generateCspNonce();
    c.header('Content-Security-Policy', getCspHeader(nonce));
    return c.html(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sovereign Shield</title>
  <script nonce="${nonce}" src="/_auth/static/session-pop.js"></script>
  <style nonce="${nonce}">
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, system-ui, 'Segoe UI', sans-serif; background: radial-gradient(ellipse at 50% -5%, rgba(240,166,90,0.06) 0%, transparent 55%), #0B0B0F; background-attachment: fixed; color: #F5EFE6; min-height: 100vh; display: flex; align-items: center; justify-content: center; overflow: hidden; }
    .container { position: relative; max-width: 380px; width: 100%; padding: 2rem; }

    /* Brand */
    .brand { display: flex; align-items: center; justify-content: center; gap: 0.6rem; margin-bottom: 1.5rem; }
    .brand svg { width: 28px; height: 28px; }
    .brand span { font-size: 1.1rem; font-weight: 700; letter-spacing: -0.01em; color: #F5EFE6; }

    /* Card */
    .auth-card { background: rgba(19,19,26,0.85); border: 1px solid rgba(245,239,230,0.07); border-radius: 16px; padding: 2rem 1.75rem; backdrop-filter: blur(20px); }

    /* Lock visual */
    .lock-visual { text-align: center; margin-bottom: 1.5rem; }
    .lock-ring { width: 48px; height: 48px; margin: 0 auto 1rem; border-radius: 50%; border: 1px solid rgba(240, 166, 90,0.2); background: rgba(240, 166, 90,0.05); display: flex; align-items: center; justify-content: center; }
    .lock-ring svg { width: 20px; height: 20px; color: #F0A65A; }
    .lock-visual h1 { font-size: 1rem; font-weight: 600; color: #F5EFE6; margin-bottom: 0.35rem; letter-spacing: -0.01em; }
    .lock-visual p { font-size: 0.8rem; color: rgba(245,239,230,0.45); line-height: 1.5; }

    /* Divider */
    .divider { height: 1px; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.06), transparent); margin: 1.25rem 0; }

    /* Button */
    .auth-btn { width: 100%; padding: 0.7rem 1rem; border-radius: 10px; border: 1px solid rgba(240, 166, 90,0.25); background: linear-gradient(180deg, rgba(240, 166, 90,0.12) 0%, rgba(240, 166, 90,0.06) 100%); color: #F4B873; font-size: 0.8rem; cursor: pointer; font-weight: 500; display: flex; align-items: center; justify-content: center; gap: 0.5rem; transition: all 0.2s ease; letter-spacing: 0.01em; }
    .auth-btn:hover { background: linear-gradient(180deg, rgba(240, 166, 90,0.2) 0%, rgba(240, 166, 90,0.1) 100%); border-color: rgba(240, 166, 90,0.45); color: #F4B873; transform: translateY(-1px); box-shadow: 0 4px 12px rgba(240, 166, 90,0.1); }
    .auth-btn:active { transform: translateY(0); }
    .auth-btn:disabled { opacity: 0.4; cursor: not-allowed; transform: none; box-shadow: none; }
    .auth-btn svg { width: 14px; height: 14px; }
    .error { color: #E5806B; margin-top: 0.75rem; display: none; font-size: 0.775rem; text-align: center; line-height: 1.4; }

    /* Trust indicators */
    .trust { display: flex; justify-content: center; gap: 1.25rem; margin-top: 1.5rem; }
    .trust-item { display: flex; align-items: center; gap: 0.3rem; }
    .trust-dot { width: 4px; height: 4px; border-radius: 50%; background: rgba(245,239,230,0.25); }
    .trust-item span { font-size: 0.55rem; color: rgba(245,239,230,0.25); letter-spacing: 0.06em; text-transform: uppercase; font-weight: 500; }

    @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
    .fade { animation: fadeIn 0.3s ease; }
  </style>
</head>
<body>
  <div class="container">
    <div class="brand">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#F0A65A"/><text x="16" y="22" text-anchor="middle" font-family="ui-monospace, monospace" font-size="20" font-weight="700" fill="#0B0B0F">e</text></svg>
      <span>${PLATFORM_ZONE}</span>
    </div>

    <div class="auth-card fade">
      <div class="lock-visual">
        <div class="lock-ring">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 11V7a5 5 0 0 1 10 0v4"/><rect x="3" y="11" width="18" height="11" rx="2"/><circle cx="12" cy="16" r="1"/></svg>
        </div>
        <h1>Passkey Authentication</h1>
        <p>Verify your identity to access this server</p>
      </div>

      <div class="divider"></div>

      <button class="auth-btn" id="auth-btn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 11V7a5 5 0 0 1 10 0v4"/><rect x="3" y="11" width="18" height="11" rx="2"/><circle cx="12" cy="16" r="1"/></svg>
        Authenticate with Passkey
      </button>
      <p class="error" id="error-msg"></p>
    </div>

    <div class="trust">
      <div class="trust-item"><div class="trust-dot"></div><span>FIDO2</span></div>
      <div class="trust-item"><div class="trust-dot"></div><span>Zero-knowledge</span></div>
      <div class="trust-item"><div class="trust-dot"></div><span>On-device</span></div>
    </div>
  </div>
  <script nonce="${nonce}">
    // VS Code extension callback: redirect to localhost auth server after passkey auth
    const params = new URLSearchParams(window.location.search);
    const isLocalhostCallback = params.get('callback') === 'localhost';
    const callbackPort = params.get('port') || params.get('callback_port');
    const callbackCsrf = params.get('csrf');
    const clientNonce = params.get('nonce');
    const autostart = params.get('autostart') === '1';
    const isExchangeMode = params.get('mode') === 'exchange';

    // Deduplicate auth across multiple login pages (terminal, code, context all redirect here)
    const AUTH_LOCK_KEY = 'shield_auth_lock';
    const AUTH_LOCK_TTL = 30000; // 30 seconds

    function acquireAuthLock() {
      try {
        const existing = localStorage.getItem(AUTH_LOCK_KEY);
        if (existing) {
          const lockTime = parseInt(existing, 10);
          if (Date.now() - lockTime < AUTH_LOCK_TTL) {
            return false; // Another page has the lock
          }
        }
        localStorage.setItem(AUTH_LOCK_KEY, Date.now().toString());
        return true;
      } catch { return true; } // If localStorage fails, proceed anyway
    }

    function releaseAuthLock() {
      try { localStorage.removeItem(AUTH_LOCK_KEY); } catch {}
    }

    // Listen for auth success from other pages
    window.addEventListener('storage', (e) => {
      if (e.key === 'shield_auth_success') {
        // Another page completed auth, reload to get the session
        window.location.reload();
      }
    });

    function getParentOrigin() {
      try {
        const ref = document.referrer;
        if (!ref) return null;
        const origin = new URL(ref).origin;
        if (origin.startsWith('https://') && (origin === 'https://${PLATFORM_ZONE}' || origin.endsWith('.${PLATFORM_ZONE}') || origin.endsWith('.${APP_ZONE}'))) return origin;
        return null;
      } catch { return null; }
    }
    async function doAuth() {
      // Only one login page should show the passkey prompt at a time
      if (!acquireAuthLock()) {
        document.getElementById('auth-btn').textContent = 'Authenticating in another tab...';
        document.getElementById('auth-btn').disabled = true;
        return;
      }
      const btn = document.getElementById('auth-btn');
      const err = document.getElementById('error-msg');
      btn.disabled = true;
      btn.textContent = 'Waiting for device...';
      err.style.display = 'none';
      try {
        const optRes = await fetch('/_auth/login/options', { method: 'POST', credentials: 'include' });
        if (!optRes.ok) throw new Error((await optRes.json()).error || 'Failed');
        const options = await optRes.json();
        if (typeof SESSION_POP === 'undefined') {
          throw new Error('Session security module unavailable');
        }
        const { assertion: assertionResp, prfMaterial } = await SESSION_POP.runLoginAssertion(options);
        const verRes = await fetch('/_auth/login/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assertion: assertionResp }),
          credentials: 'include',
        });
        if (!verRes.ok) throw new Error((await verRes.json()).error || 'Auth failed');
        const result = await verRes.json();

        // Exchange mode: post exchange code to opener (for ITP/CHIPS-safe re-auth).
        // The popup was opened by the console. The exchange code is posted back
        // via window.opener.postMessage. The console passes it to the bridge iframe,
        // which calls /_auth/session/exchange to set the cookie in its partitioned jar.
        if (isExchangeMode && result.exchangeCode && window.opener) {
          const allowedOrigins = ['${CONSOLE_ORIGIN}', 'https://${PLATFORM_ZONE}'];
          const openerOrigin = getParentOrigin() || '${CONSOLE_ORIGIN}';
          if (allowedOrigins.includes(openerOrigin)) {
            window.opener.postMessage({
              type: 'shield_exchange_token',
              exchangeCode: result.exchangeCode,
            }, openerOrigin);
          }
          releaseAuthLock();
          window.close();
          return;
        }

        // Localhost callback: redirect to local auth server (VS Code extension popup flow).
        // SECURITY: Only redirects to 127.0.0.1 (hardcoded), port must be numeric.
        // CSRF token validated by local server to prevent cross-site callback injection.
        if (isLocalhostCallback && callbackPort && /^\d+$/.test(callbackPort) && clientNonce && result.exchangeCode) {
          const domain = window.location.hostname.replace(/^srv\\./, '');
          const callbackUrl = 'http://127.0.0.1:' + callbackPort + '/callback'
            + '?code=' + encodeURIComponent(result.exchangeCode)
            + '&domain=' + encodeURIComponent(domain)
            + '&nonce=' + encodeURIComponent(clientNonce)
            + '&csrf=' + encodeURIComponent(callbackCsrf || '');
          releaseAuthLock();
          window.location.href = callbackUrl;
          return;
        }

        let redirectUrl = params.get('redirect') || '/';
        // SECURITY: Validate redirect URL to prevent open redirect attacks.
        // Only allow relative paths or URLs on platform / app zone domains.
        try {
          if (redirectUrl.startsWith('/') && !redirectUrl.startsWith('//')) {
            // Relative path — safe
          } else {
            const rUrl = new URL(redirectUrl);
            if (!rUrl.hostname.endsWith('.${PLATFORM_ZONE}') && !rUrl.hostname.endsWith('.${APP_ZONE}') && rUrl.hostname !== '${PLATFORM_ZONE}') {
              redirectUrl = '/';
            }
            if (rUrl.protocol !== 'https:') {
              redirectUrl = '/';
            }
          }
        } catch {
          redirectUrl = '/';
        }
        // Handle cross-domain redirect for preview (app zone) vs same-domain (platform zone)
        // SECURITY: Use one-time exchange code instead of session ID in URL to prevent
        // session fixation via browser history, referer headers, or server logs.
        const exchangeCode = result.exchangeCode;
        if (exchangeCode) {
          try {
            const u = new URL(redirectUrl);
            if (u.hostname.endsWith('.${APP_ZONE}')) {
              // Cross-site redirect to dev domain: get a preview token
              const previewRes = await fetch('/_auth/preview/authorize', {
                method: 'POST',
                credentials: 'include',
              });
              if (previewRes.ok) {
                const previewData = await previewRes.json();
                u.searchParams.delete('_preview_token');
                u.searchParams.set('_preview_token', previewData.token);
                redirectUrl = u.toString();
              }
            } else {
              // Same-site redirect: append one-time exchange code (not session ID)
              u.searchParams.delete('_shield_code');
              redirectUrl = u.toString();
              const sep = redirectUrl.includes('?') ? '&' : '?';
              redirectUrl = redirectUrl + sep + '_shield_code=' + encodeURIComponent(exchangeCode);
            }
          } catch {
            // Fallback for relative URLs
            const sep = redirectUrl.includes('?') ? '&' : '?';
            redirectUrl = redirectUrl + sep + '_shield_code=' + encodeURIComponent(exchangeCode);
          }
          // Notify parent frame about the new session
          if (window.parent !== window) {
            const parentOrigin = getParentOrigin();
            if (parentOrigin) {
              window.parent.postMessage({ type: 'shield-authenticated', sessionId: result.sessionId }, parentOrigin);
            }
          }
        }
        // Initialize PoP (SSH-equivalent security) - MANDATORY, no fallback
        // This prevents downgrade attacks where attacker pretends IndexedDB is broken
        try {
          if (typeof SESSION_POP === 'undefined') {
            throw new Error('Session security module unavailable');
          }
          await SESSION_POP.initialize(prfMaterial);
          SESSION_POP.wrapFetch();
        } catch (popErr) {
          // PoP failed - logout and show error. NO FALLBACK to cookie-only.
          await fetch('/_auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {});
          throw new Error('Session security failed: ' + (popErr.message || 'Unknown error') + '. Requires a modern browser with IndexedDB support.');
        }
        // Register Service Worker for universal PoP (signs navigations + static assets)
        await SESSION_POP.registerServiceWorker();
        // Auth succeeded - release lock and notify other tabs
        releaseAuthLock();
        try { localStorage.setItem('shield_auth_success', Date.now().toString()); } catch {}
        window.location.href = redirectUrl;
      } catch (e) {
        releaseAuthLock();
        err.textContent = e.name === 'NotAllowedError' ? 'Authentication cancelled.' : (e.message || 'Authentication failed.');
        err.style.display = 'block';
        btn.disabled = false;
        btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><path d="M7 11V7a5 5 0 0 1 10 0v4"/><rect x="3" y="11" width="18" height="11" rx="2"/><circle cx="12" cy="16" r="1"/></svg> Authenticate with Passkey';
      }
    }
    window.doAuth = doAuth;

    // Bind click handler via JS (not inline onclick — CSP blocks inline handlers)
    document.getElementById('auth-btn').addEventListener('click', doAuth);

    // Auto-trigger passkey for VS Code flow — no user interaction needed on this page
    if (autostart) {
      // Small delay to ensure WebAuthn is ready
      setTimeout(() => doAuth(), 100);
    }
  </script>
</body>
</html>`);
  });

  /**
   * Generate authentication options (with rate limiting)
   */
  app.post('/_auth/login/options', async (c) => {
    const ip = getClientIp(c);
    const fingerprintData = getDeviceFingerprint(c);

    const rateLimit = checkRateLimit(ip);
    if (rateLimit.blocked) {
      logAuditEvent({ type: 'rate_limit_blocked', ip, fingerprint: fingerprintData.hash, details: { until: rateLimit.until } });
      return c.json({ error: 'Too many attempts. Try again later.', retryAfter: Math.ceil(rateLimit.remaining! / 1000) }, 429);
    }

    const creds = db.prepare('SELECT * FROM credential').all() as CredentialRecord[];
    if (!creds.length) {
      return c.json({ error: 'No passkeys registered' }, 400);
    }

    // Restrict to only registered credentials to prevent authenticator offering old/stale passkeys
    const allowCredentials = buildAllowCredentials(creds);

    const options = await generateAuthenticationOptions({
      rpID: resolveRpId(c.req.header('host') ?? ''),
      userVerification: 'required',
      allowCredentials,
    });

    storeChallenge(options.challenge, { type: 'authentication', createdAt: Date.now() });
    return c.json(options);
  });

  /**
   * Verify authentication response (with rate limiting, IP binding, fingerprint binding)
   */
  app.post('/_auth/login/verify', async (c) => {
    const reqHost = c.req.header('host') ?? '';
    const reqOrigin = c.req.header('origin') ?? '';
    const ip = getClientIp(c);
    const fingerprintData = getDeviceFingerprint(c);
    dbg('login', 'verify_enter', { host: reqHost, origin: reqOrigin, ip });

    const rateLimit = checkRateLimit(ip);
    if (rateLimit.blocked) {
      dbg('login', 'reject_rate_limited', { ip });
      return c.json({ error: 'Too many attempts. Try again later.' }, 429);
    }

    const body = await c.req.json() as {
      assertion?: {
        rawId?: string;
        response?: {
          clientDataJSON?: string;
        };
      };
    };

    // Extract challenge from assertion response
    const clientDataJSON = body.assertion?.response?.clientDataJSON;
    if (!clientDataJSON) {
      dbg('login', 'reject_no_client_data', { hasAssertion: !!body.assertion });
      return c.json({ error: 'Invalid assertion' }, 400);
    }
    const clientData = JSON.parse(Buffer.from(clientDataJSON, 'base64').toString());
    const expectedChallenge = clientData.challenge;
    dbg('login', 'parsed_client_data', {
      challengeShort: expectedChallenge?.slice(0, 12),
      clientDataOrigin: clientData.origin,
      clientDataType: clientData.type,
    });

    const challengeData = getChallenge(expectedChallenge);
    if (!challengeData || challengeData.type !== 'authentication') {
      dbg('login', 'reject_no_challenge_data', {
        challengeShort: expectedChallenge?.slice(0, 12),
        challengeFound: !!challengeData,
        challengeType: challengeData?.type,
      });
      return c.json({ error: 'No pending authentication or challenge expired' }, 400);
    }

    const credId = body.assertion!.rawId;
    const cred = db.prepare('SELECT * FROM credential WHERE credentialId = ?').get(credId) as CredentialRecord | undefined;
    if (!cred) {
      dbg('login', 'reject_unknown_credential', { credIdShort: credId?.slice(0, 12) });
      recordAuthAttempt(ip, false);
      logAuditEvent({ type: 'auth_failed', ip, fingerprint: fingerprintData.hash, details: { reason: 'unknown_credential' } });
      return c.json({ error: 'Unknown credential' }, 400);
    }
    dbg('login', 'credential_found', {
      credIdInternal: cred.id.slice(0, 8),
      counter: cred.counter,
    });

    const rpIdResolved = resolveRpId(reqHost);
    dbg('login', 'resolved_rp', { rpId: rpIdResolved, originsCount: ORIGINS.length });

    try {
      const verification = await verifyAuthenticationResponse({
        response: body.assertion as any,
        expectedChallenge,
        expectedOrigin: ORIGINS,
        expectedRPID: rpIdResolved,
        credential: {
          id: cred.credentialId,
          publicKey: Buffer.from(cred.publicKey, 'base64url'),
          counter: cred.counter,
          transports: cred.transports ? JSON.parse(cred.transports) : [],
        },
      });
      dbg('login', 'verify_result', { verified: !!verification.verified });

      if (!verification.verified) {
        dbg('login', 'reject_verify_failed', { credIdInternal: cred.id.slice(0, 8) });
        recordAuthAttempt(ip, false);
        logAuditEvent({ type: 'auth_failed', ip, fingerprint: fingerprintData.hash, credentialId: cred.id, details: { reason: 'verification_failed' } });
        return c.json({ error: 'Verification failed' }, 400);
      }

      // Update counter
      db.prepare('UPDATE credential SET counter = ? WHERE id = ?')
        .run(verification.authenticationInfo.newCounter, cred.id);

      // Challenge already consumed by getChallenge (single-use)
      recordAuthAttempt(ip, true);

      // Create session bound to IP + fingerprint
      const session = createSession(cred.id, ip, fingerprintData);
      const operatorBindNonce = crypto.randomBytes(32).toString('hex');
      db.prepare('UPDATE sessions SET operator_bind_nonce = ? WHERE id = ?')
        .run(operatorBindNonce, session.id);
      logAuditEvent({ type: 'auth_success', ip, fingerprint: fingerprintData.hash, credentialId: cred.id, sessionId: session.id });
      setSessionCookie(c, session.id, hostname);
      // Return one-time exchange code for URL redirect (never expose session ID in URLs)
      const exchangeCode = createSessionExchangeCode(session.id);
      dbg('login', 'success', {
        credIdInternal: cred.id.slice(0, 8),
        sidShort: session.id.slice(0, 8),
        exchangeCodeShort: exchangeCode.slice(0, 8),
      });
      return c.json({ verified: true, sessionId: session.id, exchangeCode });
    } catch (e) {
      dbg('login', 'exception', { message: (e as Error).message, stack: (e as Error).stack?.split('\n').slice(0, 5).join(' | ') });
      recordAuthAttempt(ip, false);
      logAuditEvent({ type: 'auth_error', ip, fingerprint: fingerprintData.hash, details: { error: (e as Error).message } });
      return c.json({ error: (e as Error).message || 'Verification error' }, 400);
    }
  });

  /**
   * Logout - clear session
   */
  app.post('/_auth/logout', async (c) => {
    const cookies = parseCookies(c.req.header('cookie'));
    const sessionId = cookies.shield_session;

    if (sessionId) {
      const ip = getClientIp(c);
      const fingerprintData = getDeviceFingerprint(c);

      // Delete session from database
      db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);

      logAuditEvent({
        type: 'logout',
        ip,
        fingerprint: fingerprintData.hash,
        sessionId,
      });
    }

    clearSessionCookie(c, hostname);
    return c.json({ success: true });
  });

  /**
   * Exchange a one-time code for a session cookie (ITP/CHIPS safe).
   *
   * Called by the bridge iframe after receiving an exchange code from
   * a re-auth popup via postMessage. The popup authenticated in a
   * first-party context and got the code. The iframe (third-party
   * context) exchanges it here to get a session cookie in its own
   * partitioned cookie jar.
   */
  app.post('/_auth/session/exchange', async (c) => {
    const body = await c.req.json() as { exchangeCode?: string };
    if (!body.exchangeCode) {
      return c.json({ error: 'Missing exchangeCode' }, 400);
    }

    const exchangeData = consumeExchangeCode(body.exchangeCode);
    if (!exchangeData) {
      return c.json({ error: 'Invalid or expired exchange code' }, 401);
    }

    // web_locked exchange: set session cookie from the exchange code's session ID
    if (exchangeData.tier !== 'standard' && exchangeData.sessionId) {
      setSessionCookie(c, exchangeData.sessionId, hostname);
      logAuditEvent({
        type: 'session_exchanged',
        ip: getClientIp(c),
        sessionId: exchangeData.sessionId,
        details: { context: 'bridge_reauth' },
      });
      return c.json({ success: true });
    }

    // standard tier exchange: set JWT cookie
    if (exchangeData.tier === 'standard' && exchangeData.jwt) {
      c.header('Set-Cookie',
        `terminal_token=${exchangeData.jwt}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`
      );
      return c.json({ success: true });
    }

    return c.json({ error: 'Exchange failed' }, 400);
  });

  /**
   * Session keepalive — refreshes shield session idle timer.
   * Called periodically by the bridge to prevent the shield session
   * from expiring while the console tab is open and active.
   */
  app.post('/_auth/session/keepalive', async (c) => {
    const cookies = parseCookies(c.req.header('cookie'));
    const sessionId = cookies.shield_session;

    if (!sessionId) {
      return c.json({ alive: false, reason: 'no_session' });
    }

    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as Session | undefined;
    if (!session) {
      return c.json({ alive: false, reason: 'session_not_found' });
    }

    const now = Date.now();

    // Check absolute expiry
    if (now > session.absolute_expiry) {
      return c.json({ alive: false, reason: 'absolute_expiry' });
    }

    // Check session TTL (fixed window from creation)
    if (now > session.expires_at) {
      return c.json({ alive: false, reason: 'session_timeout' });
    }

    // Check idle timeout (no forward-auth requests for idle_timeout_ms)
    const { getSessionPolicy } = await import('../application/platform/SessionPolicy');
    const { idleTimeoutMs } = getSessionPolicy();
    if (now - session.last_activity > idleTimeoutMs) {
      return c.json({ alive: false, reason: 'idle_timeout' });
    }

    // Do NOT refresh idle timer — keepalive only checks liveness for
    // short-lived code tokens / bridge auth, it must not extend the
    // shield session. The idle timer is only reset by real forward-auth
    // requests (page loads, API calls through Caddy).

    return c.json({ alive: true });
  });
}
