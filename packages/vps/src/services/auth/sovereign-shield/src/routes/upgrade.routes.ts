// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Upgrade Routes
 *
 * Direct tier upgrade endpoints from Standard tier (JWT authenticated).
 * These endpoints allow users in Standard tier to upgrade directly
 * without going through the bridge.
 *
 * Endpoints:
 * - POST /_auth/upgrade-to-web-locked       - Initiate Web Locked upgrade
 * - POST /_auth/upgrade-to-web-locked/verify - Complete Web Locked upgrade
 */

import type { Hono } from 'hono';
import crypto from 'crypto';
import { db } from '../database';
import {
  RP_NAME,
  TRUSTED_AAGUIDS,
  readAllowedOrigins,
  resolveRpId,
  CONSOLE_ORIGIN,
  PLATFORM_ZONE,
  APP_ZONE,
} from '../config';
import { getDeviceFingerprint, getClientIp } from '../auth/fingerprint';
import { createSession, setSessionCookie } from '../auth/session';
import { verifyJwtToken } from '../auth/jwt';
import { logAuditEvent } from '../application/audit/Audit';
import {
  getCurrentTier,
  executeTierSwitch,
  notifyPlatformPasskeyRegistered,
} from '../application/gates/Tier';
import { loadAttestationPolicy } from '../application/platform/Setup';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  storeChallenge,
  getChallenge,
} from '../auth/webauthn';
import { generateRecoveryCodes, storeRecoveryCodes } from '../auth/recovery';
import { generateCspNonce, getCspHeader, getStaticPageCspHeader } from '../utils/csp';

/**
 * Register upgrade routes on Hono app
 */
export function registerUpgradeRoutes(app: Hono, hostname: string): void {
  // RP ID resolved per-request; ORIGINS read from platform allowlist + optional
  // custom-domain file. See login.routes.ts for rationale.
  const ORIGINS = readAllowedOrigins();

  /**
   * Initiate Web Locked upgrade from Standard
   * This starts the passkey registration flow
   */
  app.post('/_auth/upgrade-to-web-locked', async (c) => {
    // Only accept JWT cookie (must be in Standard tier)
    const decoded = verifyJwtToken(c.req);

    if (!decoded) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    // Check current tier
    const currentTier = getCurrentTier();
    if (currentTier !== 'standard') {
      return c.json({ error: 'Can only upgrade to Web Locked from Standard tier', currentTier }, 400);
    }

    const body = await c.req.json() as { name?: string };
    const { name } = body;

    // Generate WebAuthn registration options
    const userName = name || 'ellul User';

    // Load attestation policy
    const attestationPolicy = loadAttestationPolicy();

    // Exclude already-registered credentials so the browser allows registering
    // a new passkey with the same authenticator for a different purpose (e.g.,
    // web lock passkey + volume encryption PRF passkey on the same Touch ID).
    const existingCreds = db.prepare('SELECT credentialId FROM credential').all() as Array<{ credentialId: string }>;

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: resolveRpId(c.req.header('host') ?? ''),
      userName,
      userDisplayName: userName,
      // Request attestation based on policy
      attestationType: attestationPolicy.mode === 'none' ? 'none' : 'direct',
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'required', // Enforce biometric/PIN
      },
      excludeCredentials: existingCreds.map(c => ({
        id: c.credentialId,
        type: 'public-key' as const,
      })),
      extensions: {
        // Request PRF so the same credential can derive encryption keys
        prf: {},
      },
    });

    // Store challenge for verification with 'upgrade_registration' type
    storeChallenge(options.challenge, {
      type: 'registration', // Use 'registration' type for compatibility
      userId: crypto.randomBytes(16).toString('base64url'),
      createdAt: Date.now(),
    });

    return c.json({ options, upgradeFlow: true });
  });

  /**
   * Complete Web Locked upgrade
   * Verifies the passkey registration and activates Web Locked tier
   */
  app.post('/_auth/upgrade-to-web-locked/verify', async (c) => {
    // Accept JWT cookie for initial upgrade
    const decoded = verifyJwtToken(c.req);

    if (!decoded) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    // Check current tier
    const currentTier = getCurrentTier();
    if (currentTier !== 'standard') {
      return c.json({ error: 'Can only upgrade to Web Locked from Standard tier', currentTier }, 400);
    }

    const ip = getClientIp(c);
    const fingerprintData = getDeviceFingerprint(c);
    const body = await c.req.json() as {
      attestation?: { response?: { clientDataJSON?: string }; clientExtensionResults?: { prf?: { enabled?: boolean } } };
      prfEnabled?: boolean;
      name?: string;
    };
    const { attestation, name } = body;

    if (!attestation) {
      return c.json({ error: 'Attestation required' }, 400);
    }

    // Extract challenge from attestation response
    const clientDataJSON = attestation?.response?.clientDataJSON;
    if (!clientDataJSON) {
      return c.json({ error: 'Invalid attestation' }, 400);
    }
    const clientData = JSON.parse(Buffer.from(clientDataJSON, 'base64').toString());
    const expectedChallenge = clientData.challenge;

    const challengeData = getChallenge(expectedChallenge);
    if (!challengeData || challengeData.type !== 'registration') {
      return c.json({ error: 'Registration session expired' }, 400);
    }

    try {
      const verification = await verifyRegistrationResponse({
        response: attestation,
        expectedChallenge,
        expectedOrigin: ORIGINS,
        expectedRPID: resolveRpId(c.req.header('host') ?? ''),
        requireUserVerification: true, // Enforce biometric/PIN
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

      // Store credential
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
        name || authenticatorName || 'Passkey'
      );

      // Challenge already consumed by getChallenge (single-use)

      // Execute tier switch to Web Locked
      await executeTierSwitch('web_locked', ip, c.req.header('user-agent') || 'unknown');

      logAuditEvent({
        type: 'tier_upgrade_web_locked',
        ip,
        fingerprint: fingerprintData.hash,
        credentialId: credId,
      });

      // PRF detection: prefer explicit flag from frontend (survives serialization),
      // fall back to clientExtensionResults from the attestation object.
      const prfSupported = body.prfEnabled === true
        || attestation?.clientExtensionResults?.prf?.enabled === true;

      // Credential metadata for frontend→API sync (one registration, both stores)
      const credentialMeta = {
        id: credentialIdB64,
        publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter,
        transports: credential.transports || [],
        aaguid: aaguidStr,
        prfSupported,
      };

      // Synchronous notification — API creates both server_passkeys and userEncryptionCredentials.
      // Returns true if synced, false if API unreachable (frontend falls back to direct sync).
      const credentialSynced = await notifyPlatformPasskeyRegistered(credentialIdB64, name || 'Passkey', {
        publicKey: credentialMeta.publicKey,
        counter: credentialMeta.counter,
        transports: credentialMeta.transports,
        aaguid: credentialMeta.aaguid,
        prfSupported: credentialMeta.prfSupported,
      });

      // Create session
      const session = createSession(credId, ip, fingerprintData);
      setSessionCookie(c, session.id, hostname);

      // Generate recovery codes on web lock upgrade
      const codes = generateRecoveryCodes();
      const displayCodes = storeRecoveryCodes(codes);

      logAuditEvent({
        type: 'recovery_codes_generated',
        ip,
        fingerprint: fingerprintData.hash,
        credentialId: credId
      });

      return c.json({
        success: true,
        tier: 'web_locked',
        sessionId: session.id,
        credential: credentialMeta,
        credentialSynced,
        recoveryCodes: displayCodes,
        recoveryWarning: 'SAVE THESE RECOVERY CODES NOW. They will not be shown again.',
      });
    } catch (e) {
      console.error('[shield] Error verifying Web Locked upgrade:', e);
      return c.json({ error: (e as Error).message || 'Verification error' }, 400);
    }
  });

  /**
   * Standard to Web Locked upgrade - popup page for passkey registration
   * This is opened as a popup from the dashboard to handle WebAuthn
   */
  app.get('/_auth/standard-upgrade', async (c) => {
    // Verify JWT authentication
    const decoded = verifyJwtToken(c.req);
    const isEmbedded = c.req.query('embed') === 'true';

    if (!decoded) {
      c.header('Content-Security-Policy', getStaticPageCspHeader());
      const errorHtml = isEmbedded
        ? `<div style="padding:1rem;color:#E5806B;font-family:-apple-system,system-ui,sans-serif;font-size:0.8rem;text-align:center;">Authentication required. Please refresh and try again.</div>`
        : `<!DOCTYPE html><html><head><title>Authentication Required</title><style>body{font-family:-apple-system,system-ui,sans-serif;background:#06000f;color:#F5EFE6;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;}.container{max-width:400px;text-align:center;padding:2rem;}h2{color:#E5806B;font-size:1rem;font-weight:600;margin-bottom:0.5rem;}p{color:rgba(245,239,230,0.45);font-size:0.8rem;}</style></head><body><div class="container"><h2>Authentication Required</h2><p>Please log in first, then try again.</p></div></body></html>`;
      return c.html(errorHtml, 401);
    }

    // Check current tier
    const currentTier = getCurrentTier();
    if (currentTier !== 'standard') {
      c.header('Content-Security-Policy', getStaticPageCspHeader());
      const errorHtml = isEmbedded
        ? `<div style="padding:1rem;color:#F4B873;font-family:-apple-system,system-ui,sans-serif;font-size:0.8rem;text-align:center;">This upgrade is only available from Standard tier.</div>`
        : `<!DOCTYPE html><html><head><title>Invalid Tier</title><style>body{font-family:-apple-system,system-ui,sans-serif;background:#06000f;color:#F5EFE6;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;}.container{max-width:400px;text-align:center;padding:2rem;}h2{color:#F4B873;font-size:1rem;font-weight:600;margin-bottom:0.5rem;}p{color:rgba(245,239,230,0.45);font-size:0.8rem;}</style></head><body><div class="container"><h2>Invalid Tier</h2><p>This upgrade is only available from Standard tier. Current tier: ${currentTier}</p></div></body></html>`;
      return c.html(errorHtml, 400);
    }

    const name = c.req.query('name') || 'Passkey';

    // Embedded mode: minimal UI for iframe in modal
    if (isEmbedded) {
      const eNonce = generateCspNonce();
      c.header('Content-Security-Policy', getCspHeader(eNonce));
      return c.html(`<!DOCTYPE html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style nonce="${eNonce}">
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, system-ui, 'Segoe UI', sans-serif; background: transparent; color: #F5EFE6; padding: 1.25rem; }

  .embed-header { text-align: center; margin-bottom: 1rem; }
  .embed-header .lock-ring { width: 40px; height: 40px; margin: 0 auto 0.75rem; border-radius: 50%; border: 1.5px solid rgba(240, 166, 90,0.2); display: flex; align-items: center; justify-content: center; }
  .embed-header .lock-ring svg { width: 18px; height: 18px; color: #F0A65A; }
  .embed-header p { font-size: 0.75rem; color: rgba(245,239,230,0.45); line-height: 1.4; }

  .divider { height: 1px; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.06), transparent); margin: 1rem 0; }

  button { width: 100%; padding: 0.75rem 1rem; border-radius: 10px; border: 1px solid rgba(240, 166, 90,0.25); background: linear-gradient(180deg, rgba(240, 166, 90,0.12) 0%, rgba(240, 166, 90,0.06) 100%); color: #F4B873; font-size: 0.85rem; font-weight: 500; cursor: pointer; transition: all 0.2s ease; display: flex; align-items: center; justify-content: center; gap: 8px; }
  button:hover { background: linear-gradient(180deg, rgba(240, 166, 90,0.2) 0%, rgba(240, 166, 90,0.1) 100%); border-color: rgba(240, 166, 90,0.45); color: #F4B873; transform: translateY(-1px); box-shadow: 0 4px 12px rgba(240, 166, 90,0.1); }
  button:active { transform: translateY(0); }
  button:disabled { opacity: 0.35; cursor: not-allowed; transform: none; box-shadow: none; border-color: rgba(255,255,255,0.06); background: rgba(255,255,255,0.02); color: rgba(245,239,230,0.35); }
  button svg { width: 16px; height: 16px; }
  .error { background: rgba(239,68,68,0.06); border: 1px solid rgba(239,68,68,0.15); border-radius: 8px; padding: 0.6rem; margin-top: 0.75rem; color: #E5806B; font-size: 0.775rem; display: none; text-align: center; }
  .success { background: rgba(34,197,94,0.06); border: 1px solid rgba(34,197,94,0.15); border-radius: 8px; padding: 0.6rem; margin-top: 0.75rem; color: #86efac; font-size: 0.775rem; display: none; text-align: center; }
  .recovery { background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); border-radius: 10px; padding: 0.875rem; margin-top: 0.75rem; }
  .recovery h3 { color: #E5806B; margin: 0 0 0.5rem 0; font-size: 0.775rem; font-weight: 600; display: flex; align-items: center; gap: 0.35rem; }
  .recovery h3 svg { width: 14px; height: 14px; }
  .recovery code { display: block; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.04); padding: 0.4rem; border-radius: 4px; font-size: 0.7rem; color: #F5EFE6; margin: 0.2rem 0; font-family: 'SF Mono', 'Fira Code', monospace; letter-spacing: 1px; text-align: center; }
  .trust { display: flex; justify-content: center; gap: 1rem; margin-top: 1rem; padding-top: 0.75rem; border-top: 1px solid rgba(255,255,255,0.03); }
  .trust span { font-size: 0.55rem; color: rgba(245,239,230,0.25); letter-spacing: 0.04em; text-transform: uppercase; font-weight: 500; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .spinner { width: 14px; height: 14px; border: 2px solid rgba(240, 166, 90,0.2); border-top-color: #F4B873; border-radius: 50%; animation: spin 0.7s linear infinite; }
</style>
</head>
<body>
<div class="embed-header">
  <div class="lock-ring">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
  </div>
  <p>Register a passkey to activate Web Locked mode. Your biometric credential never leaves this device.</p>
</div>
<div class="divider"></div>
<button id="registerBtn">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 11V7a5 5 0 0 1 10 0v4"/><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><circle cx="12" cy="16" r="1"/></svg>
  <span id="btnText">Register Passkey</span>
</button>
<div class="error" id="error"></div>
<div class="success" id="success"></div>
<div class="recovery" id="recovery" style="display:none;">
  <h3><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg> Save your recovery codes</h3>
  <div id="recoveryCodes"></div>
</div>
<div class="trust"><span>FIDO2</span><span>Zero-knowledge</span><span>On-device</span></div>

<script nonce="${eNonce}" type="module">
import { startRegistration } from '/_auth/static/simplewebauthn-browser.js';

const passkeyName = ${JSON.stringify(name)};
const DASHBOARD_ORIGINS = ['${CONSOLE_ORIGIN}', 'https://${PLATFORM_ZONE}'];

function notifyParent(data) {
  DASHBOARD_ORIGINS.forEach(origin => {
    try { window.parent.postMessage(data, origin); } catch {}
  });
}

window.startRegistration = async function() {
  const btn = document.getElementById('registerBtn');
  const btnText = document.getElementById('btnText');
  const errorDiv = document.getElementById('error');
  const successDiv = document.getElementById('success');

  btn.disabled = true;
  btnText.textContent = 'Waiting for device...';
  errorDiv.style.display = 'none';

  try {
    const optRes = await fetch('/_auth/upgrade-to-web-locked', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: passkeyName })
    });

    if (!optRes.ok) {
      const err = await optRes.json();
      throw new Error(err.error || 'Failed to get registration options');
    }

    const { options } = await optRes.json();
    const credential = await startRegistration({ optionsJSON: options });

    btnText.innerHTML = '<span class="spinner"></span> Activating Web Locked...';

    const verifyRes = await fetch('/_auth/upgrade-to-web-locked/verify', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attestation: credential, name: passkeyName })
    });

    if (!verifyRes.ok) {
      const err = await verifyRes.json();
      throw new Error(err.error || 'Verification failed');
    }

    const result = await verifyRes.json();

    successDiv.innerHTML = '<strong>Web Locked enabled.</strong> Save your recovery information below. It will not be shown again.';
    successDiv.style.display = 'block';
    btn.style.display = 'none';

    if (result.recoveryCodes && result.recoveryCodes.length > 0) {
      const codesHtml = result.recoveryCodes.map(c => '<code>' + c + '</code>').join('');
      document.getElementById('recoveryCodes').innerHTML = codesHtml;
      document.getElementById('recovery').style.display = 'block';
      // Delay notification so user can see recovery codes
      setTimeout(() => notifyParent({ type: 'upgrade_complete', tier: 'web_locked', credentialId: result.credentialId }), 10000);
    } else {
      notifyParent({ type: 'upgrade_complete', tier: 'web_locked', credentialId: result.credentialId });
    }

  } catch (e) {
    errorDiv.textContent = e.name === 'NotAllowedError' ? 'Registration cancelled.' : (e.message || 'Registration failed');
    errorDiv.style.display = 'block';
    btn.disabled = false;
    btnText.textContent = 'Register Passkey';
  }
};
// Bind click handler via JS (not inline onclick — CSP blocks inline handlers)
document.getElementById('registerBtn').addEventListener('click', window.startRegistration);
</script>
</body>
</html>`);
    }

    // Standalone mode: full page for popup
    const sNonce = generateCspNonce();
    c.header('Content-Security-Policy', getCspHeader(sNonce));
    return c.html(`<!DOCTYPE html>
<html><head>
<title>Upgrade to Web Locked</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style nonce="${sNonce}">
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, system-ui, 'Segoe UI', sans-serif; background: radial-gradient(ellipse at 50% -5%, rgba(240,166,90,0.06) 0%, transparent 55%), #0B0B0F; background-attachment: fixed; color: #F5EFE6; min-height: 100vh; display: flex; justify-content: center; align-items: center; overflow: hidden; }
  .container { position: relative; max-width: 400px; width: 100%; padding: 2rem; }

  /* Brand */
  .brand { display: flex; align-items: center; justify-content: center; gap: 0.6rem; margin-bottom: 1.5rem; }
  .brand svg { width: 28px; height: 28px; }
  .brand span { font-size: 1.1rem; font-weight: 700; letter-spacing: -0.01em; color: #F5EFE6; }

  /* Card */
  .upgrade-card { background: rgba(19,19,26,0.85); border: 1px solid rgba(245,239,230,0.07); border-radius: 16px; padding: 2rem 1.75rem; backdrop-filter: blur(20px); }

  /* Lock visual */
  .lock-visual { text-align: center; margin-bottom: 1.25rem; }
  .lock-ring { width: 56px; height: 56px; margin: 0 auto 1rem; border-radius: 50%; border: 1.5px solid rgba(240, 166, 90,0.2); display: flex; align-items: center; justify-content: center; position: relative; }
  .lock-ring::before { content: ''; position: absolute; inset: -4px; border-radius: 50%; border: 1px solid rgba(240, 166, 90,0.06); }
  .lock-ring svg { width: 22px; height: 22px; color: #F0A65A; }
  .lock-visual h1 { font-size: 1rem; font-weight: 600; color: #f1f5f9; margin-bottom: 0.3rem; }
  .lock-visual p { font-size: 0.775rem; color: rgba(245,239,230,0.45); line-height: 1.4; }

  /* Tier comparison */
  .tier-upgrade { display: flex; align-items: center; justify-content: center; gap: 0.75rem; margin-bottom: 1.25rem; padding: 0.75rem; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.04); border-radius: 10px; }
  .tier-badge { font-size: 0.65rem; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; padding: 0.3rem 0.6rem; border-radius: 5px; }
  .tier-badge.current { background: rgba(100,116,139,0.15); color: rgba(245,239,230,0.45); border: 1px solid rgba(100,116,139,0.15); }
  .tier-badge.target { background: rgba(240, 166, 90,0.1); color: #F4B873; border: 1px solid rgba(240, 166, 90,0.2); }
  .tier-arrow { color: rgba(245,239,230,0.25); }
  .tier-arrow svg { width: 14px; height: 14px; }

  /* Feature list */
  .features { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 1.25rem; }
  .feature { display: flex; align-items: center; gap: 0.5rem; font-size: 0.75rem; color: rgba(245,239,230,0.6); }
  .feature svg { width: 14px; height: 14px; color: #F0A65A; flex-shrink: 0; }

  /* Divider */
  .divider { height: 1px; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.06), transparent); margin: 1.25rem 0; }

  /* Button */
  .auth-btn { width: 100%; padding: 0.8rem 1rem; border-radius: 10px; border: 1px solid rgba(240, 166, 90,0.25); background: linear-gradient(180deg, rgba(240, 166, 90,0.12) 0%, rgba(240, 166, 90,0.06) 100%); color: #F4B873; font-size: 0.85rem; cursor: pointer; font-weight: 500; display: flex; align-items: center; justify-content: center; gap: 8px; transition: all 0.2s ease; letter-spacing: 0.01em; }
  .auth-btn:hover { background: linear-gradient(180deg, rgba(240, 166, 90,0.2) 0%, rgba(240, 166, 90,0.1) 100%); border-color: rgba(240, 166, 90,0.45); color: #F4B873; transform: translateY(-1px); box-shadow: 0 4px 12px rgba(240, 166, 90,0.1); }
  .auth-btn:active { transform: translateY(0); }
  .auth-btn:disabled { opacity: 0.35; cursor: not-allowed; transform: none; box-shadow: none; }
  .auth-btn svg { width: 16px; height: 16px; }
  .error { background: rgba(239,68,68,0.06); border: 1px solid rgba(239,68,68,0.15); border-radius: 8px; padding: 0.6rem; margin-top: 0.75rem; color: #E5806B; font-size: 0.775rem; display: none; text-align: center; }
  .success { background: rgba(34,197,94,0.06); border: 1px solid rgba(34,197,94,0.15); border-radius: 8px; padding: 0.6rem; margin-top: 0.75rem; color: #86efac; font-size: 0.775rem; display: none; text-align: center; }

  /* Recovery */
  .recovery { background: rgba(255,255,255,0.015); border: 1px solid rgba(255,255,255,0.05); border-radius: 12px; padding: 1rem; margin-top: 0.75rem; display: none; }
  .recovery h3 { color: #E5806B; margin: 0 0 0.35rem 0; font-size: 0.775rem; font-weight: 600; display: flex; align-items: center; gap: 0.35rem; }
  .recovery h3 svg { width: 14px; height: 14px; }
  .recovery p { color: rgba(245,239,230,0.45); font-size: 0.7rem; margin: 0 0 0.5rem 0; line-height: 1.4; }
  .recovery code { display: block; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.04); padding: 0.4rem; border-radius: 4px; font-size: 0.7rem; color: #F5EFE6; margin: 0.2rem 0; font-family: 'SF Mono', 'Fira Code', monospace; letter-spacing: 1px; text-align: center; }

  @keyframes spin { to { transform: rotate(360deg); } }
  .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid rgba(240, 166, 90,0.2); border-top-color: #F4B873; border-radius: 50%; animation: spin 0.7s linear infinite; vertical-align: middle; }

  @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
  .fade { animation: fadeIn 0.3s ease; }

  /* Trust */
  .trust { display: flex; justify-content: center; gap: 1.25rem; margin-top: 1.5rem; }
  .trust-item { display: flex; align-items: center; gap: 0.3rem; }
  .trust-dot { width: 4px; height: 4px; border-radius: 50%; background: rgba(245,239,230,0.25); }
  .trust-item span { font-size: 0.55rem; color: rgba(245,239,230,0.25); letter-spacing: 0.06em; text-transform: uppercase; font-weight: 500; }
</style>
</head>
<body>
<div class="container">
  <div class="brand">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#F0A65A"/><text x="16" y="22" text-anchor="middle" font-family="ui-monospace, monospace" font-size="20" font-weight="700" fill="#0B0B0F">e</text></svg>
    <span>${PLATFORM_ZONE}</span>
  </div>

  <div class="upgrade-card fade">
    <div class="lock-visual">
      <div class="lock-ring">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
      </div>
      <h1>Upgrade to Web Locked</h1>
      <p>Enable the highest security tier for your server.</p>
    </div>

    <div class="tier-upgrade">
      <span class="tier-badge current">Standard</span>
      <span class="tier-arrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg></span>
      <span class="tier-badge target">Web Locked</span>
    </div>

    <div class="features">
      <div class="feature">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        Passkey required for all web access
      </div>
      <div class="feature">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        SSH permanently disabled
      </div>
      <div class="feature">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        Session-bound proof-of-possession
      </div>
    </div>

    <div class="divider"></div>

    <button class="auth-btn" id="registerBtn">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 11V7a5 5 0 0 1 10 0v4"/><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><circle cx="12" cy="16" r="1"/></svg>
      <span id="btnText">Register Passkey</span>
    </button>

    <div class="error" id="error"></div>
    <div class="success" id="success"></div>
    <div class="recovery" id="recovery">
      <h3><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg> Save Your Recovery Codes</h3>
      <p>These codes can be used if you lose your passkey. Each can only be used once. Save them now.</p>
      <div id="recoveryCodes"></div>
    </div>
  </div>

  <div class="trust">
    <div class="trust-item"><div class="trust-dot"></div><span>FIDO2</span></div>
    <div class="trust-item"><div class="trust-dot"></div><span>Zero-knowledge</span></div>
    <div class="trust-item"><div class="trust-dot"></div><span>On-device</span></div>
  </div>

</div>

<script nonce="${sNonce}" type="module">
import { startRegistration } from '/_auth/static/simplewebauthn-browser.js';

const passkeyName = ${JSON.stringify(name)};
const DASHBOARD_ORIGINS = ['${CONSOLE_ORIGIN}', 'https://${PLATFORM_ZONE}'];

function getOpenerOrigin() {
  try {
    const ref = document.referrer;
    if (!ref) return null;
    const origin = new URL(ref).origin;
    if (DASHBOARD_ORIGINS.includes(origin)) return origin;
    if (origin.startsWith('https://') && (origin.endsWith('.${PLATFORM_ZONE}') || origin.endsWith('.${APP_ZONE}'))) return origin;
    return null;
  } catch { return null; }
}

window.startRegistration = async function() {
  const btn = document.getElementById('registerBtn');
  const btnText = document.getElementById('btnText');
  const errorDiv = document.getElementById('error');
  const successDiv = document.getElementById('success');

  btn.disabled = true;
  btnText.textContent = 'Waiting for device...';
  errorDiv.style.display = 'none';

  try {
    const optRes = await fetch('/_auth/upgrade-to-web-locked', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: passkeyName })
    });

    if (!optRes.ok) {
      const err = await optRes.json();
      throw new Error(err.error || 'Failed to get registration options');
    }

    const { options } = await optRes.json();
    const credential = await startRegistration({ optionsJSON: options });

    btnText.innerHTML = '<span class="spinner"></span> Activating Web Locked...';

    const verifyRes = await fetch('/_auth/upgrade-to-web-locked/verify', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attestation: credential, name: passkeyName })
    });

    if (!verifyRes.ok) {
      const err = await verifyRes.json();
      throw new Error(err.error || 'Verification failed');
    }

    const result = await verifyRes.json();

    successDiv.innerHTML = '<strong>Web Locked enabled.</strong> Save your recovery information below. It will not be shown again.';
    successDiv.style.display = 'block';

    if (result.recoveryCodes && result.recoveryCodes.length > 0) {
      const codesHtml = result.recoveryCodes.map(c => '<code>' + c + '</code>').join('');
      document.getElementById('recoveryCodes').innerHTML = codesHtml;
      document.getElementById('recovery').style.display = 'block';
    }

    // SECURITY: Notify opener with validated origin only (never wildcard)
    if (window.opener) {
      const openerOrigin = getOpenerOrigin();
      if (openerOrigin) {
        window.opener.postMessage({ type: 'upgrade_complete', tier: 'web_locked', credentialId: result.credentialId }, openerOrigin);
      }
    }

    const delay = result.recoveryCodes ? 30000 : 2000;
    setTimeout(() => {
      if (window.opener) {
        window.close();
      } else {
        window.location.href = '/';
      }
    }, delay);

  } catch (e) {
    errorDiv.textContent = e.name === 'NotAllowedError' ? 'Registration cancelled.' : (e.message || 'Registration failed');
    errorDiv.style.display = 'block';
    btn.disabled = false;
    btnText.textContent = 'Register Passkey';
  }
};
// Bind click handler via JS (not inline onclick — CSP blocks inline handlers)
document.getElementById('registerBtn').addEventListener('click', window.startRegistration);

// Auto-trigger registration when opened as a popup from the console.
// The user already confirmed in the console dialog — just execute.
const autostart = new URLSearchParams(window.location.search).get('autostart') === '1';
if (autostart) {
  setTimeout(() => window.startRegistration(), 150);
}
</script>
</body>
</html>`);
  });

}
