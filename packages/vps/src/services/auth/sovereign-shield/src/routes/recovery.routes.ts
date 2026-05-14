// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Recovery Routes
 *
 * Break-glass recovery system to prevent permanent lockout
 * if user loses all passkey devices.
 *
 * Endpoints:
 * - GET  /_auth/recovery                     - Recovery landing page
 * - POST /_auth/recovery/verify              - Verify a recovery code
 * - GET  /_auth/recovery/register            - Re-registration page after recovery
 * - POST /_auth/recovery/register/options    - Get registration options for recovery
 * - POST /_auth/recovery/register/verify     - Verify registration after recovery
 * - POST /_auth/recovery/regenerate          - Generate new recovery codes (requires session)
 * - GET  /_auth/recovery/codes               - Get recovery code status
 */

import type { Hono } from 'hono';
import crypto from 'crypto';
import { db } from '../database';
import { RP_NAME, TRUSTED_AAGUIDS, readAllowedOrigins, resolveRpId } from '../config';
import { getDeviceFingerprint, getClientIp } from '../auth/fingerprint';
import { createSession, setSessionCookie, validateSession } from '../auth/session';
import { logAuditEvent } from '../application/audit/Audit';
import { checkRecoveryRateLimit, recordRecoveryAttempt } from '../application/platform/RateLimiter';
import { getCurrentTier, notifyPlatformPasskeyRegistered } from '../application/gates/Tier';
import { validateSetupToken, loadAttestationPolicy } from '../application/platform/Setup';
import {
  generateRecoveryCodes,
  storeRecoveryCodes,
  verifyRecoveryCode,
  markRecoveryCodeUsed,
  getRemainingRecoveryCodes,
} from '../auth/recovery';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  storeChallenge,
  getChallenge,
} from '../auth/webauthn';
import { parseCookies } from '../utils/cookie';
import { generateCspNonce, getCspHeader, getStaticPageCspHeader } from '../utils/csp';

/**
 * Register recovery routes on Hono app
 */
export function registerRecoveryRoutes(app: Hono, hostname: string): void {
  // RP ID resolved per-request; ORIGINS read from platform allowlist + optional
  // custom-domain file. See login.routes.ts for rationale.
  const ORIGINS = readAllowedOrigins();

  /**
   * Recovery landing page
   */
  app.get('/_auth/recovery', async (c) => {
    // Only available in Web Locked tier
    const tier = getCurrentTier();
    if (tier === 'standard') {
      c.header('Content-Security-Policy', getStaticPageCspHeader());
      return c.html(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Recovery Not Available</title>
<style>body{font-family:system-ui;background: #0B0B0F;color:#e0e0e0;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;}</style>
</head><body>
<div style="text-align:center;padding:20px;">
  <h2>Recovery Not Available</h2>
  <p style="color:rgba(245,239,230,0.45);">Recovery is only available for Web Locked tier servers.</p>
  <p style="color:rgba(245,239,230,0.45);">Current tier: ${tier}</p>
</div>
</body></html>`, 400);
    }

    // Check if any recovery codes exist
    const remaining = getRemainingRecoveryCodes();
    if (remaining === 0) {
      c.header('Content-Security-Policy', getStaticPageCspHeader());
      return c.html(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>No Recovery Codes</title>
<style>body{font-family:system-ui;background: #0B0B0F;color:#e0e0e0;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;}</style>
</head><body>
<div style="text-align:center;padding:20px;max-width:400px;">
  <h2 style="color:#E5806B;">No Recovery Codes Available</h2>
  <p style="color:rgba(245,239,230,0.45);">All recovery codes have been used or none were generated.</p>
  <p style="color:rgba(245,239,230,0.45);">If you have SSH access, you can manage your server via SSH.</p>
  <p style="color:rgba(245,239,230,0.45);">Otherwise, contact support for assistance.</p>
</div>
</body></html>`, 400);
    }

    const nonce = generateCspNonce();
    c.header('Content-Security-Policy', getCspHeader(nonce));
    return c.html(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Emergency Recovery - Sovereign Shield</title>
  <style nonce="${nonce}">
    * { box-sizing: border-box; }
    body { font-family: -apple-system, system-ui, sans-serif; max-width: 420px; margin: 20px auto; padding: 20px; background: #0B0B0F; color: #e0e0e0; }
    h1 { font-size: 1.4rem; color: #E5806B; margin-bottom: 8px; }
    .warning { background: #7f1d1d; border: 1px solid #E5806B; padding: 16px; border-radius: 8px; margin-bottom: 24px; font-size: 0.9rem; }
    input { width: 100%; padding: 12px; background: #1a1a1a; border: 1px solid rgba(245,239,230,0.08); border-radius: 6px; color: white; font-size: 1.2rem; margin-bottom: 12px; font-family: monospace; letter-spacing: 3px; text-transform: uppercase; text-align: center; }
    button { width: 100%; padding: 14px; border-radius: 8px; border: none; background: #E5806B; color: white; font-size: 1rem; cursor: pointer; font-weight: 600; }
    button:hover { background: #E5806B; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .error { color: #E5806B; margin-top: 12px; display: none; font-size: 0.85rem; text-align: center; }
    .info { color: rgba(245,239,230,0.45); font-size: 0.85rem; margin-top: 16px; text-align: center; }
  </style>
</head>
<body>
  <h1>Emergency Recovery</h1>
  <div class="warning">
    <strong>Lost access to your passkey?</strong><br><br>
    Enter one of your recovery codes below. Each code can only be used once.
    This will create a temporary session to register a new passkey.
  </div>
  <input type="text" id="code" placeholder="XXXXXXXX" maxlength="8" autocomplete="off" autofocus>
  <button id="recover-btn">Use Recovery Code</button>
  <p class="error" id="error-msg"></p>
  <p class="info">${remaining} recovery code(s) remaining</p>
  <script nonce="${nonce}">
    const input = document.getElementById('code');
    input.addEventListener('input', (e) => {
      e.target.value = e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase().substring(0, 8);
    });

    async function doRecover() {
      const btn = document.getElementById('recover-btn');
      const err = document.getElementById('error-msg');
      const code = document.getElementById('code').value;

      if (code.length !== 8) {
        err.textContent = 'Please enter all 8 characters';
        err.style.display = 'block';
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Verifying...';
      err.style.display = 'none';

      try {
        const res = await fetch('/_auth/recovery/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
          credentials: 'include',
        });

        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || 'Recovery failed');
        }

        // Redirect to passkey re-registration
        window.location.href = '/_auth/recovery/register?token=' + data.registrationToken;
      } catch (e) {
        err.textContent = e.message;
        err.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Use Recovery Code';
      }
    }

    // Bind click handlers via JS (not inline onclick — CSP blocks inline handlers)
    document.getElementById('recover-btn').addEventListener('click', doRecover);
    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') doRecover();
    });
  </script>
</body>
</html>`);
  });

  /**
   * Verify a recovery code
   */
  app.post('/_auth/recovery/verify', async (c) => {
    const ip = getClientIp(c);
    const fingerprintData = getDeviceFingerprint(c);

    // Rate limiting: max 3 attempts per hour per IP
    const rateLimit = checkRecoveryRateLimit(ip);
    if (rateLimit.blocked) {
      logAuditEvent({
        type: 'recovery_rate_limited',
        ip,
        fingerprint: fingerprintData.hash
      });
      return c.json({
        error: 'Too many recovery attempts. Try again in 1 hour.',
        retryAfter: 3600
      }, 429);
    }

    const body = await c.req.json() as { code?: string };
    const { code } = body;

    if (!code || code.length !== 8) {
      return c.json({ error: 'Invalid recovery code format' }, 400);
    }

    // Verify the recovery code
    const codeId = verifyRecoveryCode(code, ip);

    // Record the attempt
    recordRecoveryAttempt(ip, !!codeId);

    if (!codeId) {
      logAuditEvent({
        type: 'recovery_failed',
        ip,
        fingerprint: fingerprintData.hash,
        details: { reason: 'invalid_code' }
      });
      return c.json({ error: 'Invalid recovery code' }, 401);
    }

    // Mark code as used
    markRecoveryCodeUsed(codeId, ip);

    // Generate one-time registration token (15 minute expiry)
    const registrationToken = crypto.randomBytes(32).toString('hex');
    const expiry = Date.now() + 15 * 60 * 1000;

    // Store recovery session
    db.prepare(
      'INSERT INTO recovery_sessions (token, created_at, expires_at, ip, fingerprint) VALUES (?, ?, ?, ?, ?)'
    ).run(registrationToken, Date.now(), expiry, ip, fingerprintData.hash);

    logAuditEvent({
      type: 'recovery_initiated',
      ip,
      fingerprint: fingerprintData.hash,
      details: { codeId, expiresAt: expiry }
    });

    // Count remaining codes
    const remaining = getRemainingRecoveryCodes();

    return c.json({
      success: true,
      registrationToken,
      expiresAt: expiry,
      remainingCodes: remaining,
      warning: remaining <= 2 ?
        'WARNING: You have very few recovery codes left. Generate new codes after re-registering.' : null
    });
  });

  /**
   * Re-registration page after recovery
   */
  app.get('/_auth/recovery/register', async (c) => {
    const token = c.req.query('token');
    const ip = getClientIp(c);

    if (!token) {
      return c.redirect('/_auth/recovery', 302);
    }

    // Verify recovery session
    const session = db.prepare(
      'SELECT * FROM recovery_sessions WHERE token = ? AND used = 0'
    ).get(token) as { expires_at: number; ip: string } | undefined;

    if (!session || Date.now() > session.expires_at) {
      c.header('Content-Security-Policy', getStaticPageCspHeader());
      return c.html(`<!DOCTYPE html>
<html><head><title>Session Expired</title>
<style>body{font-family:system-ui;background: #0B0B0F;color:white;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;}</style>
</head><body>
<div style="text-align:center">
  <h2 style="color:#E5806B">Recovery Session Expired</h2>
  <p>Please start the recovery process again.</p>
  <a href="/_auth/recovery" style="color:#7c3aed">Return to Recovery</a>
</div>
</body></html>`, 400);
    }

    // Verify IP matches (recovery must complete from same IP).
    // Skipped in proxied mode — edge IPs rotate between requests. See utils/ip-binding.ts.
    const { shouldRejectIpMismatch } = await import('../utils/ip-binding');

    if (shouldRejectIpMismatch(session.ip, ip, c.req.raw.headers)) {
      logAuditEvent({
        type: 'recovery_ip_mismatch',
        ip,
        details: { expectedIp: session.ip }
      });
      c.header('Content-Security-Policy', getStaticPageCspHeader());
      return c.html(`<!DOCTYPE html>
<html><head><title>IP Mismatch</title>
<style>body{font-family:system-ui;background: #0B0B0F;color:white;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;}</style>
</head><body>
<div style="text-align:center;max-width:400px;padding:20px;">
  <h2 style="color:#E5806B">Security Check Failed</h2>
  <p>Recovery must be completed from the same network where it was initiated.</p>
  <a href="/_auth/recovery" style="color:#7c3aed">Start Over</a>
</div>
</body></html>`, 403);
    }

    const rNonce = generateCspNonce();
    c.header('Content-Security-Policy', getCspHeader(rNonce));
    return c.html(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Recovery - Register New Passkey</title>
  <style nonce="${rNonce}">
    * { box-sizing: border-box; }
    body { font-family: -apple-system, system-ui, sans-serif; max-width: 420px; margin: 20px auto; padding: 20px; background: #0B0B0F; color: #e0e0e0; }
    h1 { font-size: 1.4rem; color: #22c55e; margin-bottom: 8px; }
    .info { background: #14532d; border: 1px solid #22c55e; padding: 16px; border-radius: 8px; margin-bottom: 24px; font-size: 0.9rem; }
    button { width: 100%; padding: 14px; border-radius: 8px; border: none; background: #7c3aed; color: white; font-size: 1rem; cursor: pointer; font-weight: 600; display: flex; align-items: center; justify-content: center; gap: 8px; }
    button:hover { background: #6d28d9; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .error { color: #E5806B; margin-top: 12px; display: none; font-size: 0.85rem; text-align: center; }
    .success { color: #22c55e; margin-top: 12px; display: none; font-size: 0.85rem; text-align: center; }
    .btn-icon { display: flex; align-items: center; }
    .btn-icon svg { width: 18px; height: 18px; }
    .timer { color: rgba(245,239,230,0.45); font-size: 0.85rem; text-align: center; margin-top: 16px; }
  </style>
</head>
<body>
  <h1>Recovery Code Accepted</h1>
  <div class="info">
    Register a new passkey to regain access to your server.
    This session expires in 15 minutes.
  </div>
  <button id="register-btn">
    <span class="btn-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></span>
    Register New Passkey
  </button>
  <p class="error" id="error-msg"></p>
  <p class="success" id="success-msg">Passkey registered! Redirecting...</p>
  <p class="timer" id="timer"></p>
  <script nonce="${rNonce}" type="module">
    import { startRegistration } from '/_auth/static/simplewebauthn-browser.js';
    window.startRegistration = startRegistration;
  </script>
  <script nonce="${rNonce}">
    const TOKEN = '${token}';
    const EXPIRY = ${session.expires_at};

    // Update timer
    function updateTimer() {
      const remaining = Math.max(0, Math.floor((EXPIRY - Date.now()) / 1000));
      const mins = Math.floor(remaining / 60);
      const secs = remaining % 60;
      document.getElementById('timer').textContent = 'Session expires in ' + mins + ':' + secs.toString().padStart(2, '0');
      if (remaining <= 0) {
        document.getElementById('register-btn').disabled = true;
        document.getElementById('timer').textContent = 'Session expired. Please start over.';
        document.getElementById('timer').style.color = '#E5806B';
      }
    }
    updateTimer();
    setInterval(updateTimer, 1000);

    async function doRegister() {
      const btn = document.getElementById('register-btn');
      const err = document.getElementById('error-msg');
      const success = document.getElementById('success-msg');

      btn.disabled = true;
      btn.innerHTML = 'Waiting for device...';
      err.style.display = 'none';

      try {
        // Get registration options
        const optRes = await fetch('/_auth/recovery/register/options', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ recoveryToken: TOKEN }),
          credentials: 'include',
        });

        if (!optRes.ok) throw new Error((await optRes.json()).error || 'Failed to get options');
        const options = await optRes.json();

        const attResp = await window.startRegistration({ optionsJSON: options });

        const verRes = await fetch('/_auth/recovery/register/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recoveryToken: TOKEN,
            attestation: attResp,
            name: 'Recovered Passkey'
          }),
          credentials: 'include',
        });

        if (!verRes.ok) throw new Error((await verRes.json()).error || 'Verification failed');

        btn.style.display = 'none';
        success.style.display = 'block';

        setTimeout(() => {
          window.location.href = '/';
        }, 2000);
      } catch (e) {
        err.textContent = e.message;
        err.style.display = 'block';
        btn.disabled = false;
        btn.innerHTML = '<span class="btn-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></span> Register New Passkey';
      }
    }
    // Bind click handler via JS (not inline onclick — CSP blocks inline handlers)
    document.getElementById('register-btn').addEventListener('click', doRegister);
  </script>
</body>
</html>`);
  });

  /**
   * Get registration options for recovery
   */
  app.post('/_auth/recovery/register/options', async (c) => {
    const body = await c.req.json() as { recoveryToken?: string };
    const { recoveryToken } = body;
    const ip = getClientIp(c);

    // Verify recovery session
    const session = db.prepare(
      'SELECT * FROM recovery_sessions WHERE token = ? AND used = 0 AND expires_at > ?'
    ).get(recoveryToken, Date.now()) as { ip: string } | undefined;

    if (!session) {
      return c.json({ error: 'Invalid or expired recovery session' }, 403);
    }

    const { shouldRejectIpMismatch: shouldReject2 } = await import('../utils/ip-binding');
    if (shouldReject2(session.ip, ip, c.req.raw.headers)) {
      return c.json({ error: 'IP address mismatch' }, 403);
    }

    // Load attestation policy
    const attestationPolicy = loadAttestationPolicy();

    // Exclude existing credentials to allow recovery with the same authenticator
    const existingCreds = db.prepare('SELECT credentialId FROM credential').all() as Array<{ credentialId: string }>;

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: resolveRpId(c.req.header('host') ?? ''),
      userName: 'owner',
      userDisplayName: 'Server Owner (Recovered)',
      attestationType: attestationPolicy.mode === 'none' ? 'none' : 'direct',
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'required',
      },
      excludeCredentials: existingCreds.map(c => ({
        id: c.credentialId,
        type: 'public-key' as const,
      })),
    });

    storeChallenge(options.challenge, {
      type: 'recovery_registration',
      recoveryToken,
      createdAt: Date.now()
    });

    return c.json(options);
  });

  /**
   * Verify registration after recovery
   */
  app.post('/_auth/recovery/register/verify', async (c) => {
    const body = await c.req.json() as {
      recoveryToken?: string;
      attestation?: { response?: { clientDataJSON?: string } };
      name?: string;
    };
    const { recoveryToken, attestation, name } = body;
    const ip = getClientIp(c);
    const fingerprintData = getDeviceFingerprint(c);

    // Verify recovery session
    const session = db.prepare(
      'SELECT * FROM recovery_sessions WHERE token = ? AND used = 0 AND expires_at > ?'
    ).get(recoveryToken, Date.now()) as { ip: string } | undefined;

    const { shouldRejectIpMismatch: shouldReject3 } = await import('../utils/ip-binding');
    if (!session || shouldReject3(session.ip, ip, c.req.raw.headers)) {
      return c.json({ error: 'Invalid recovery session' }, 403);
    }

    // Extract and verify challenge
    const clientDataJSON = attestation?.response?.clientDataJSON;
    if (!clientDataJSON) {
      return c.json({ error: 'Invalid attestation' }, 400);
    }
    const clientData = JSON.parse(Buffer.from(clientDataJSON, 'base64').toString());
    const expectedChallenge = clientData.challenge;

    const challengeData = getChallenge(expectedChallenge);
    if (!challengeData || challengeData.type !== 'recovery_registration') {
      return c.json({ error: 'Challenge expired' }, 400);
    }

    try {
      const verification = await verifyRegistrationResponse({
        response: attestation,
        expectedChallenge,
        expectedOrigin: ORIGINS,
        expectedRPID: resolveRpId(c.req.header('host') ?? ''),
        requireUserVerification: true,
      });

      if (!verification.verified || !verification.registrationInfo) {
        return c.json({ error: 'Verification failed' }, 400);
      }

      const { credential, aaguid, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
      const credId = crypto.randomUUID();
      const credentialIdB64 = typeof credential.id === 'string'
        ? credential.id
        : Buffer.from(credential.id as Uint8Array).toString('base64url');
      const aaguidStr = aaguid || '00000000-0000-0000-0000-000000000000';
      const authenticatorName = TRUSTED_AAGUIDS[aaguidStr] || 'Unknown Authenticator';

      // Store new credential with attestation info
      db.prepare(
        'INSERT INTO credential (id, credentialId, publicKey, counter, transports, aaguid, device_type, backed_up, name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        credId,
        credentialIdB64,
        Buffer.from(credential.publicKey).toString('base64url'),
        credential.counter,
        JSON.stringify(credential.transports || []),
        aaguidStr,
        credentialDeviceType || 'unknown',
        credentialBackedUp ? 1 : 0,
        name || 'Recovered Passkey'
      );

      // Mark recovery session as used
      db.prepare('UPDATE recovery_sessions SET used = 1 WHERE token = ?').run(recoveryToken);

      // Challenge already consumed by getChallenge (single-use)

      // Create new session
      const newSession = createSession(credId, ip, fingerprintData);
      setSessionCookie(c, newSession.id, hostname);

      logAuditEvent({
        type: 'recovery_completed',
        ip,
        fingerprint: fingerprintData.hash,
        credentialId: credId,
        details: { aaguid: aaguidStr, name: name || 'Recovered Passkey' }
      });

      // Notify platform (fire-and-forget)
      notifyPlatformPasskeyRegistered(credentialIdB64, name || 'Recovered Passkey').catch(() => {});

      return c.json({
        verified: true,
        sessionId: newSession.id,
        message: 'Passkey registered successfully via recovery'
      });
    } catch (e) {
      return c.json({ error: (e as Error).message || 'Verification error' }, 400);
    }
  });

  /**
   * Generate new recovery codes (requires active session)
   */
  app.post('/_auth/recovery/regenerate', async (c) => {
    const cookies = parseCookies(c.req.header('cookie'));
    const sessionId = cookies.shield_session;

    if (!sessionId) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const ip = getClientIp(c);
    const fingerprintData = getDeviceFingerprint(c);
    const result = validateSession(sessionId, ip, fingerprintData, '/_auth/recovery/regenerate');

    if (!result.valid) {
      return c.json({ error: 'Session invalid' }, 401);
    }

    // Step-up: require recent authentication (within 5 minutes)
    const timeSinceAuth = Date.now() - (result.session?.created_at || 0);
    if (timeSinceAuth > 5 * 60 * 1000) {
      return c.json({
        error: 'Step-up authentication required',
        needsReauth: true,
        message: 'Please re-authenticate to regenerate recovery codes'
      }, 401);
    }

    // Generate new codes (invalidates old ones)
    const codes = generateRecoveryCodes();
    const displayCodes = storeRecoveryCodes(codes);

    logAuditEvent({
      type: 'recovery_codes_regenerated',
      ip,
      fingerprint: fingerprintData.hash,
      credentialId: result.session?.credential_id
    });

    return c.json({
      success: true,
      recoveryCodes: displayCodes,
      warning: 'SAVE THESE CODES NOW. Old codes are now invalid. They will not be shown again.'
    });
  });

  /**
   * Get recovery code status (not the codes themselves)
   */
  app.get('/_auth/recovery/codes', async (c) => {
    const cookies = parseCookies(c.req.header('cookie'));
    const sessionId = cookies.shield_session;

    if (!sessionId) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const ip = getClientIp(c);
    const fingerprintData = getDeviceFingerprint(c);
    const result = validateSession(sessionId, ip, fingerprintData, '/_auth/recovery/codes');

    if (!result.valid) {
      return c.json({ error: 'Session invalid' }, 401);
    }

    const remaining = getRemainingRecoveryCodes();
    const total = (db.prepare('SELECT COUNT(*) as count FROM recovery_codes').get() as { count: number }).count;

    return c.json({
      remaining,
      total,
      hasRecoveryCodes: total > 0,
      warning: remaining <= 2 && remaining > 0 ?
        'You have very few recovery codes remaining. Consider regenerating them.' : null
    });
  });
}
