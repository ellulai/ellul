// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Setup Routes
 *
 * Initial passkey registration during server setup.
 *
 * Endpoints:
 * - GET  /_auth/setup           - Setup UI page
 * - POST /_auth/register/options - Generate registration options
 * - POST /_auth/register/verify  - Verify registration response
 */

import type { Hono } from 'hono';
import crypto from 'crypto';
import fs from 'fs';
import { execSync } from 'child_process';
import { db } from '../database';
import {
  RP_NAME,
  TRUSTED_AAGUIDS,
  PENDING_SSH_BLOCK_FILE,
  SOVEREIGN_KEYS_FILE,
  readAllowedOrigins,
  resolveRpId,
  CONSOLE_ORIGIN,
  PLATFORM_ZONE,
  APP_ZONE,
} from '../config';
import { getDeviceFingerprint, getClientIp } from '../auth/fingerprint';
import { createSession, setSessionCookie, createSessionExchangeCode } from '../auth/session';
import { logAuditEvent } from '../application/audit/Audit';
import { dbg } from '../application/audit/DebugLog';
import { validateSetupToken, loadAttestationPolicy, cleanupSetupToken } from '../application/platform/Setup';
import { notifyPlatformPasskeyRegistered } from '../application/gates/Tier';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  storeChallenge,
  getChallenge,
} from '../auth/webauthn';
import { generateCspNonce, getCspHeader } from '../utils/csp';

/**
 * Register setup routes on Hono app
 */
export function registerSetupRoutes(app: Hono, hostname: string): void {
  // RP ID is resolved per-request from the Host header; see login.routes.ts
  // for the rationale. ORIGINS is read from the platform-managed allowlist file
  // + the optional custom-domain file, both written by boot-config / enforcer.
  const ORIGINS = readAllowedOrigins();

  /**
   * Setup page - register first passkey
   */
  app.get('/_auth/setup', async (c) => {
    const credCount = db.prepare('SELECT COUNT(*) as count FROM credential').get() as { count: number };
    if (credCount && credCount.count > 0) {
      return c.text('Setup already completed. Sovereign Shield is active.', 403);
    }

    if (!validateSetupToken(c.req.query('token'))) {
      const wn = generateCspNonce();
      c.header('Content-Security-Policy', getCspHeader(wn));
      return c.html(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style nonce="${wn}">body{font-family:-apple-system,system-ui,sans-serif;background:#06000f;color:rgba(245,239,230,0.45);min-height:100vh;display:flex;align-items:center;justify-content:center;margin:0;text-align:center;}
.spinner{display:inline-block;width:20px;height:20px;border:2px solid rgba(240, 166, 90,0.15);border-top-color:rgba(240, 166, 90,0.6);border-radius:50%;animation:spin 0.8s linear infinite;margin-bottom:12px;}
@keyframes spin{to{transform:rotate(360deg)}}</style>
</head><body>
<div><div class="spinner"></div>
<p style="font-size:0.8rem;">Waiting for activation...</p></div>
<script nonce="${wn}">(function(){var a=parseInt(sessionStorage.getItem('shield-retry')||'0');if(a>15){sessionStorage.removeItem('shield-retry');document.body.innerHTML='<p>Setup token not found. Try again from the dashboard.</p>';return;}
sessionStorage.setItem('shield-retry',''+(a+1));setTimeout(function(){location.reload()},2000)})()</script>
</body></html>`, 200);
    }

    const nonce = generateCspNonce();
    c.header('Content-Security-Policy', getCspHeader(nonce));
    return c.html(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sovereign Shield Setup</title>
  <script nonce="${nonce}" src="/_auth/static/session-pop.js"></script>
  <style nonce="${nonce}">
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, system-ui, 'Segoe UI', sans-serif; background: #050010; color: #F5EFE6; min-height: 100vh; display: flex; align-items: center; justify-content: center; overflow: hidden; }
    body::before { content: ''; position: fixed; inset: 0; background: radial-gradient(ellipse 60% 50% at 50% 40%, rgba(240, 166, 90,0.04) 0%, transparent 70%); pointer-events: none; }
    .container { position: relative; max-width: 400px; width: 100%; padding: 2rem; }

    /* Brand */
    .brand { display: flex; align-items: center; justify-content: center; gap: 0.5rem; margin-bottom: 2rem; }
    .brand svg { width: 18px; height: 18px; color: #F0A65A; opacity: 0.7; }
    .brand span { font-size: 0.65rem; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: rgba(245,239,230,0.35); }

    /* Steps */
    .step-indicator { display: flex; align-items: center; justify-content: center; gap: 0.5rem; margin-bottom: 1.5rem; }
    .step { width: 6px; height: 6px; border-radius: 50%; background: #13131A; transition: all 0.3s; }
    .step.active { background: #F0A65A; box-shadow: 0 0 8px rgba(240, 166, 90,0.3); }
    .step.done { background: #22c55e; }

    /* Card */
    .setup-card { background: rgba(255,255,255,0.015); border: 1px solid rgba(255,255,255,0.05); border-radius: 16px; padding: 2rem 1.75rem; backdrop-filter: blur(20px); }

    /* Lock visual */
    .lock-visual { text-align: center; margin-bottom: 1.25rem; }
    .lock-ring { width: 56px; height: 56px; margin: 0 auto 1rem; border-radius: 50%; border: 1.5px solid rgba(240, 166, 90,0.2); display: flex; align-items: center; justify-content: center; position: relative; }
    .lock-ring::before { content: ''; position: absolute; inset: -4px; border-radius: 50%; border: 1px solid rgba(240, 166, 90,0.06); }
    .lock-ring svg { width: 22px; height: 22px; color: #F0A65A; }
    .lock-visual h1 { font-size: 1rem; font-weight: 600; color: #f1f5f9; margin-bottom: 0.3rem; }
    .lock-visual p { font-size: 0.775rem; color: rgba(245,239,230,0.45); line-height: 1.4; }

    /* Feature list */
    .features { display: flex; flex-direction: column; gap: 0.6rem; margin-bottom: 1.5rem; padding: 0.875rem; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.04); border-radius: 10px; }
    .feature { display: flex; align-items: center; gap: 0.6rem; }
    .feature-icon { width: 28px; height: 28px; border-radius: 6px; background: rgba(240, 166, 90,0.06); border: 1px solid rgba(240, 166, 90,0.1); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .feature-icon svg { width: 13px; height: 13px; color: #F0A65A; }
    .feature-text { font-size: 0.75rem; color: rgba(245,239,230,0.6); line-height: 1.3; }
    .feature-text strong { color: rgba(245,239,230,0.85); font-weight: 500; }

    /* Divider */
    .divider { height: 1px; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.06), transparent); margin: 1.25rem 0; }

    /* Button */
    .auth-btn { width: 100%; padding: 0.8rem 1rem; border-radius: 10px; border: 1px solid rgba(240, 166, 90,0.25); background: linear-gradient(180deg, rgba(240, 166, 90,0.12) 0%, rgba(240, 166, 90,0.06) 100%); color: #F4B873; font-size: 0.85rem; cursor: pointer; font-weight: 500; display: flex; align-items: center; justify-content: center; gap: 8px; transition: all 0.2s ease; letter-spacing: 0.01em; }
    .auth-btn:hover { background: linear-gradient(180deg, rgba(240, 166, 90,0.2) 0%, rgba(240, 166, 90,0.1) 100%); border-color: rgba(240, 166, 90,0.45); color: #F4B873; transform: translateY(-1px); box-shadow: 0 4px 12px rgba(240, 166, 90,0.1); }
    .auth-btn:active { transform: translateY(0); }
    .auth-btn:disabled { opacity: 0.35; cursor: not-allowed; transform: none; box-shadow: none; }
    .auth-btn svg { width: 16px; height: 16px; }
    .success { margin-top: 0.75rem; display: none; font-size: 0.775rem; text-align: center; color: #86efac; background: rgba(34,197,94,0.06); border: 1px solid rgba(34,197,94,0.15); border-radius: 8px; padding: 0.6rem; }
    .error { color: #E5806B; margin-top: 0.75rem; display: none; font-size: 0.775rem; text-align: center; background: rgba(239,68,68,0.06); border: 1px solid rgba(239,68,68,0.15); border-radius: 8px; padding: 0.6rem; }


    /* Trust + Footer */
    .trust { display: flex; justify-content: center; gap: 1.25rem; margin-top: 1.5rem; }
    .trust-item { display: flex; align-items: center; gap: 0.3rem; }
    .trust-dot { width: 4px; height: 4px; border-radius: 50%; background: rgba(245,239,230,0.25); }
    .trust-item span { font-size: 0.6rem; color: rgba(245,239,230,0.25); letter-spacing: 0.04em; text-transform: uppercase; font-weight: 500; }
    .footer { text-align: center; margin-top: 2rem; padding-top: 1rem; border-top: 1px solid rgba(255,255,255,0.03); }
    .footer span { font-size: 0.6rem; color: #13131A; letter-spacing: 0.08em; text-transform: uppercase; }
  </style>
</head>
<body>
  <div class="container">
    <div class="brand">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
      <span>Sovereign Shield</span>
    </div>

    <div class="step-indicator">
      <div class="step active" id="step1"></div>
      <div class="step" id="step2"></div>
    </div>

    <div class="setup-card">
      <div class="lock-visual">
        <div class="lock-ring">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12.65 2.35a1 1 0 0 0-1.3 0L3.35 9a1 1 0 0 0-.35.76V20a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V9.76a1 1 0 0 0-.35-.76z"/><path d="M12 22v-9"/><path d="M8 13h8"/></svg>
        </div>
        <h1>Secure Your Server</h1>
        <p>Register a passkey to activate Sovereign Shield protection.</p>
      </div>

      <div class="features">
        <div class="feature">
          <div class="feature-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></div>
          <div class="feature-text"><strong>Hardware-bound credential</strong> &mdash; stored on your device, never transmitted</div>
        </div>
        <div class="feature">
          <div class="feature-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>
          <div class="feature-text"><strong>Biometric verification</strong> &mdash; Face ID, Touch ID, or security key</div>
        </div>
        <div class="feature">
          <div class="feature-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg></div>
          <div class="feature-text"><strong>Zero-knowledge auth</strong> &mdash; no passwords, no cloud dependency</div>
        </div>
      </div>

      <div class="divider"></div>

      <button class="auth-btn" id="register-btn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 11V7a5 5 0 0 1 10 0v4"/><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><circle cx="12" cy="16" r="1"/></svg>
        Register Passkey
      </button>
      <div class="success" id="success-msg">Passkey registered. Sovereign Shield is active.</div>
      <div class="error" id="error-msg"></div>
    </div>

    <div class="trust">
      <div class="trust-item"><div class="trust-dot"></div><span>FIDO2</span></div>
      <div class="trust-item"><div class="trust-dot"></div><span>WebAuthn</span></div>
      <div class="trust-item"><div class="trust-dot"></div><span>On-device</span></div>
    </div>

    <div class="footer"><span>Protected by Sovereign Shield</span></div>
  </div>
  <script nonce="${nonce}">sessionStorage.removeItem('shield-retry');</script>
  <script nonce="${nonce}" type="module">
    import { startRegistration } from '/_auth/static/simplewebauthn-browser.js';
    window.startRegistration = startRegistration;
  </script>
  <script nonce="${nonce}">
    // CLI localhost callback: redirect to local auth server after passkey registration.
    // Mirrors the login page pattern (VS Code extension / CLI flow).
    // Accepts both 'port' (standard) and 'callback_port' (CLI compat) param names.
    const _params = new URLSearchParams(window.location.search);
    const _isLocalhostCallback = _params.get('callback') === 'localhost';
    const _callbackPort = _params.get('port') || _params.get('callback_port');
    const _callbackNonce = _params.get('nonce');

    function getParentOrigin() {
      try {
        const ref = document.referrer;
        if (!ref) return null;
        const origin = new URL(ref).origin;
        if (origin.startsWith('https://') && (origin === 'https://${PLATFORM_ZONE}' || origin.endsWith('.${PLATFORM_ZONE}') || origin.endsWith('.${APP_ZONE}'))) return origin;
        return null;
      } catch { return null; }
    }

    async function doRegister() {
      const btn = document.getElementById('register-btn');
      const err = document.getElementById('error-msg');
      const success = document.getElementById('success-msg');
      btn.disabled = true;
      btn.textContent = 'Waiting for device...';
      err.style.display = 'none';
      try {
        const optRes = await fetch('/_auth/register/options', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: new URLSearchParams(window.location.search).get('token') }),
          credentials: 'include',
        });
        if (!optRes.ok) throw new Error((await optRes.json()).error || 'Failed to get options');
        const options = await optRes.json();
        const attResp = await window.startRegistration({ optionsJSON: options });
        const verRes = await fetch('/_auth/register/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: new URLSearchParams(window.location.search).get('token'), attestation: attResp }),
          credentials: 'include',
        });
        if (!verRes.ok) throw new Error((await verRes.json()).error || 'Verification failed');
        const result = await verRes.json();
        btn.style.display = 'none';
        success.style.display = 'block';
        // Update step indicators
        document.getElementById('step1').className = 'step done';
        document.getElementById('step2').className = 'step active';

        // Initialize PoP (SSH-equivalent security) - MANDATORY
        try {
          if (typeof SESSION_POP === 'undefined') {
            throw new Error('Session security module unavailable');
          }
          await SESSION_POP.initialize();
          SESSION_POP.wrapFetch();
          console.log('[PoP] Session key bound after setup');
        } catch (popErr) {
          console.error('[PoP] Init failed:', popErr);
          err.textContent = 'Session security failed: ' + (popErr.message || 'Unknown error');
          err.style.display = 'block';
          // Don't block setup - PoP can be bound on next login
        }

        // Notify parent iframe that registration is complete, include session for preview auth
        if (window.parent !== window) {
          const parentOrigin = getParentOrigin();
          if (parentOrigin) {
            window.parent.postMessage({ type: 'shield-registered', sessionId: result.sessionId }, parentOrigin);
          }
        }

        // CLI localhost callback: redirect to VPS login page for fresh exchange code.
        // The login page handles passkey auth → exchange code → localhost redirect.
        // We redirect to login (not directly to localhost) because the exchange code
        // from registration has a 30s TTL and the login page generates a fresh one.
        // SECURITY: Only redirects to 127.0.0.1 (hardcoded in login.routes.ts).
        if (_isLocalhostCallback && _callbackPort && /^\d+$/.test(_callbackPort) && _callbackNonce) {
          window.location.href = '/_auth/login?callback=localhost'
            + '&port=' + encodeURIComponent(_callbackPort)
            + '&nonce=' + encodeURIComponent(_callbackNonce)
            + '&autostart=1';
          return;
        }
      } catch (e) {
        err.textContent = e.message || 'Registration failed.';
        err.style.display = 'block';
        btn.disabled = false;
        btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M7 11V7a5 5 0 0 1 10 0v4"/><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><circle cx="12" cy="16" r="1"/></svg> Register Passkey';
      }
    }
    // Bind click handler via JS (not inline onclick — CSP blocks inline handlers)
    document.getElementById('register-btn').addEventListener('click', doRegister);
  </script>
</body>
</html>`);
  });

  /**
   * Registration options
   */
  app.post('/_auth/register/options', async (c) => {
    const body = await c.req.json() as { token?: string; name?: string };

    if (!validateSetupToken(body.token)) {
      return c.json({ error: 'Invalid or expired setup token' }, 403);
    }

    // Prevent registration if credentials already exist (must use bridge to add more)
    const credCount = db.prepare('SELECT COUNT(*) as count FROM credential').get() as { count: number };
    if (credCount.count > 0) {
      return c.json({ error: 'Passkeys already registered. Use dashboard to add additional keys.' }, 403);
    }

    // Load attestation policy
    const attestationPolicy = loadAttestationPolicy();

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: resolveRpId(c.req.header('host') ?? ''),
      userName: 'owner',
      userDisplayName: 'Server Owner',
      // Request attestation based on policy (allows AAGUID verification)
      attestationType: attestationPolicy.mode === 'none' ? 'none' : 'direct',
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'preferred',
        userVerification: 'required', // Enforce biometric/PIN verification
      },
      extensions: {
        // Request PRF so the same credential can derive encryption keys
        prf: {},
      },
    });

    storeChallenge(options.challenge, { type: 'registration', createdAt: Date.now() });
    return c.json(options);
  });

  /**
   * Registration verify
   */
  app.post('/_auth/register/verify', async (c) => {
    const reqHost = c.req.header('host') ?? '';
    const reqOrigin = c.req.header('origin') ?? '';
    dbg('register', 'verify_enter', { host: reqHost, origin: reqOrigin });

    const body = await c.req.json() as {
      token?: string;
      attestation?: {
        response?: { clientDataJSON?: string };
        clientExtensionResults?: { prf?: { enabled?: boolean } };
      };
      name?: string;
      prfEnabled?: boolean;
    };

    if (!validateSetupToken(body.token)) {
      dbg('register', 'reject_token_invalid', { tokenPresent: !!body.token, tokenShort: body.token?.slice(0, 8) });
      return c.json({ error: 'Invalid or expired setup token' }, 403);
    }
    dbg('register', 'token_valid', { tokenShort: body.token!.slice(0, 8) });

    // Extract challenge from attestation response
    const clientDataJSON = body.attestation?.response?.clientDataJSON;
    if (!clientDataJSON) {
      dbg('register', 'reject_no_client_data', { hasAttestation: !!body.attestation });
      return c.json({ error: 'Invalid attestation' }, 400);
    }
    const clientData = JSON.parse(Buffer.from(clientDataJSON, 'base64').toString());
    const expectedChallenge = clientData.challenge;
    dbg('register', 'parsed_client_data', {
      challengeShort: expectedChallenge?.slice(0, 12),
      clientDataOrigin: clientData.origin,
      clientDataType: clientData.type,
    });

    const challengeData = getChallenge(expectedChallenge);
    if (!challengeData || challengeData.type !== 'registration') {
      dbg('register', 'reject_no_challenge_data', {
        challengeShort: expectedChallenge?.slice(0, 12),
        challengeFound: !!challengeData,
        challengeType: challengeData?.type,
      });
      return c.json({ error: 'No pending registration or challenge expired' }, 400);
    }
    dbg('register', 'challenge_valid', { challengeShort: expectedChallenge.slice(0, 12) });

    const ip = getClientIp(c);
    const fingerprintData = getDeviceFingerprint(c);
    const rpIdResolved = resolveRpId(reqHost);
    dbg('register', 'resolved_rp', { rpId: rpIdResolved, originsCount: ORIGINS.length, originsSample: ORIGINS.slice(0, 3) });

    try {
      const verification = await verifyRegistrationResponse({
        response: body.attestation,
        expectedChallenge,
        expectedOrigin: ORIGINS,
        expectedRPID: rpIdResolved,
        requireUserVerification: true, // Enforce biometric/PIN was used
      });
      dbg('register', 'verify_result', {
        verified: !!verification.verified,
        hasInfo: !!verification.registrationInfo,
      });

      if (!verification.verified || !verification.registrationInfo) {
        dbg('register', 'reject_verify_failed', {
          verified: !!verification.verified,
          hasInfo: !!verification.registrationInfo,
        });
        return c.json({ error: 'Verification failed' }, 400);
      }

      const { credential, aaguid, credentialDeviceType, credentialBackedUp, attestationObject } = verification.registrationInfo;

      // Load attestation policy and verify AAGUID
      const attestationPolicy = loadAttestationPolicy();
      const aaguidStr = aaguid || '00000000-0000-0000-0000-000000000000';
      const authenticatorName = TRUSTED_AAGUIDS[aaguidStr] || 'Unknown Authenticator';

      // Check AAGUID against policy
      dbg('register', 'aaguid_policy_check', {
        aaguid: aaguidStr,
        authenticator: authenticatorName,
        policyMode: attestationPolicy.mode,
        inAllowlist: attestationPolicy.allowedAAGUIDs.includes(aaguidStr),
      });
      if (attestationPolicy.mode === 'strict') {
        if (!attestationPolicy.allowedAAGUIDs.includes(aaguidStr)) {
          dbg('register', 'reject_aaguid_strict_denied', { aaguid: aaguidStr });
          logAuditEvent({
            type: 'attestation_rejected',
            ip,
            fingerprint: fingerprintData.hash,
            details: {
              aaguid: aaguidStr,
              reason: 'aaguid_not_in_allowlist',
              credentialDeviceType,
              credentialBackedUp
            }
          });
          return c.json({
            error: 'Authenticator not allowed',
            details: 'This authenticator type is not permitted by security policy. Use a hardware security key or platform authenticator.',
            aaguid: aaguidStr,
            authenticator: authenticatorName
          }, 403);
        }
      }

      // Log warning for unknown AAGUIDs in permissive mode
      if (attestationPolicy.mode === 'permissive' && attestationPolicy.warnUnknownAAGUID) {
        if (!attestationPolicy.allowedAAGUIDs.includes(aaguidStr)) {
          logAuditEvent({
            type: 'attestation_unknown_aaguid',
            ip,
            fingerprint: fingerprintData.hash,
            details: { aaguid: aaguidStr, credentialDeviceType, credentialBackedUp, authenticatorName }
          });
          console.log('[shield] WARNING: Unknown AAGUID registered:', aaguidStr);
        }
      }

      // Log attestation details for audit
      if (attestationPolicy.logAttestationDetails) {
        logAuditEvent({
          type: 'credential_attestation',
          ip,
          fingerprint: fingerprintData.hash,
          details: {
            aaguid: aaguidStr,
            authenticatorName,
            credentialDeviceType: credentialDeviceType || 'unknown',
            credentialBackedUp: !!credentialBackedUp,
            fmt: attestationObject?.fmt || 'unknown'
          }
        });
      }

      const credId = crypto.randomUUID();
      // credential.id may be Uint8Array (encode it) or already base64url string (use as-is)
      const credentialIdB64 = typeof credential.id === 'string'
        ? credential.id
        : Buffer.from(credential.id as Uint8Array).toString('base64url');

      dbg('register', 'before_db_insert', {
        credId: credId.slice(0, 8),
        credIdB64Short: credentialIdB64.slice(0, 12),
        deviceType: credentialDeviceType,
        backedUp: !!credentialBackedUp,
      });

      // Store credential with attestation info
      try {
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
          body.name || authenticatorName || 'Passkey'
        );
        dbg('register', 'db_insert_ok', { credId: credId.slice(0, 8) });
      } catch (dbErr) {
        dbg('register', 'db_insert_failed', {
          credId: credId.slice(0, 8),
          error: (dbErr as Error).message,
        });
        throw dbErr;
      }

      // Challenge already consumed by getChallenge (single-use)
      cleanupSetupToken();

      // Export passkey public keys to bootstrap partition (root FS) for
      // sovereign mode stateless unlock (Patent Embodiment 6)
      try {
        const { exportBootstrapCredentials } = require('../application/platform/BootstrapExport');
        exportBootstrapCredentials();
      } catch (e) { console.warn('[shield] Bootstrap export after registration failed:', e); }

      // If lock_web_only was requested, block SSH now that passkey is registered
      if (fs.existsSync(PENDING_SSH_BLOCK_FILE)) {
        try {
          execSync('ufw delete allow 22/tcp 2>/dev/null || true', { stdio: 'ignore' });
          execSync('ufw deny 22/tcp 2>/dev/null || true', { stdio: 'ignore' });
          fs.writeFileSync(SOVEREIGN_KEYS_FILE, '');
          fs.chmodSync(SOVEREIGN_KEYS_FILE, 0o400);
          fs.unlinkSync(PENDING_SSH_BLOCK_FILE);
          console.log('[shield] SSH blocked permanently after passkey registration');
        } catch (e) {
          console.error('[shield] Error blocking SSH:', (e as Error).message);
        }
      }

      // PRF detection: prefer explicit flag from frontend (survives serialization),
      // fall back to clientExtensionResults from the attestation object.
      const prfSupported = body.prfEnabled === true
        || body.attestation?.clientExtensionResults?.prf?.enabled === true;

      logAuditEvent({ type: 'credential_registered', ip, fingerprint: fingerprintData.hash, credentialId: credId, details: { prfSupported } });
      dbg('register', 'credential_registered', { credId: credId.slice(0, 8), prfSupported });

      // Synchronous notification — API creates both server_passkeys and userEncryptionCredentials.
      // Returns true if synced, false if API unreachable (frontend falls back to direct sync).
      const credentialSynced = await notifyPlatformPasskeyRegistered(credentialIdB64, body.name || 'Passkey', {
        publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter,
        transports: credential.transports || [],
        aaguid: aaguidStr,
        prfSupported,
      });
      dbg('register', 'platform_notify_result', { credentialSynced });

      // Credential metadata for frontend→API sync (one registration, both stores)
      const credentialMeta = {
        id: credentialIdB64,
        publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter,
        transports: credential.transports || [],
        aaguid: aaguidStr,
        prfSupported,
      };

      // Create session with IP + fingerprint binding
      const session = createSession(credId, ip, fingerprintData);
      setSessionCookie(c, session.id, hostname);

      // Generate one-time exchange code for CLI localhost callback redirect
      const exchangeCode = createSessionExchangeCode(session.id);

      dbg('register', 'success', {
        credId: credId.slice(0, 8),
        sidShort: session.id.slice(0, 8),
        exchangeCodeShort: exchangeCode.slice(0, 8),
        credentialSynced,
      });
      return c.json({ verified: true, sessionId: session.id, exchangeCode, credential: credentialMeta, credentialSynced });
    } catch (e) {
      dbg('register', 'exception', { message: (e as Error).message, stack: (e as Error).stack?.split('\n').slice(0, 5).join(' | ') });
      return c.json({ error: (e as Error).message || 'Verification error' }, 400);
    }
  });

}
