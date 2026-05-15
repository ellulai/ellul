import type { Hono } from 'hono';
import crypto from 'crypto';
import { db } from '../database';
import {
  RP_NAME,
  readAllowedOrigins,
  resolveRpId,
} from '../config';
import { logAuditEvent } from '../application/audit/Audit';
import { dbg } from '../application/audit/DebugLog';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  storeChallenge,
  getChallenge,
} from '../auth/webauthn';
import { generateCspNonce, getCspHeader } from '../utils/csp';

const BRIDGE_SESSION_TTL_MS = 300_000;

const bridgeSessions = new Map<string, { createdAt: number; migrationId: string }>();

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of bridgeSessions) {
    if (now - s.createdAt > BRIDGE_SESSION_TTL_MS) {
      bridgeSessions.delete(id);
    }
  }
}, 30_000);

function validateBridgeSession(c: any): string | null {
  const match = (c.req.header('cookie') || '').match(/migration_session=([^;]+)/);
  if (!match) return null;
  const session = bridgeSessions.get(match[1]);
  if (!session) return null;
  if (Date.now() - session.createdAt > BRIDGE_SESSION_TTL_MS) {
    bridgeSessions.delete(match[1]);
    return null;
  }
  return match[1];
}

export function registerMigrationRoutes(app: Hono, hostname: string): void {
  const ORIGINS = readAllowedOrigins();

  app.post('/_auth/migration/bridge-session', async (c) => {
    const body = await c.req.json();
    const migrationToken = body?.migrationToken;

    if (!migrationToken || typeof migrationToken !== 'string') {
      return c.json({ error: 'missing migration token' }, 400);
    }

    const sessionId = crypto.randomBytes(32).toString('hex');
    const migrationId = body.migrationId || 'unknown';

    bridgeSessions.set(sessionId, {
      createdAt: Date.now(),
      migrationId,
    });

    dbg('migration', `bridge session created: ${sessionId.slice(0, 8)}... for migration ${migrationId}`);

    logAuditEvent({
      type: 'migration_bridge_session',
      details: { migrationId },
    });

    c.header('Set-Cookie', `migration_session=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${BRIDGE_SESSION_TTL_MS / 1000}`);

    return c.json({ sessionId, expiresIn: BRIDGE_SESSION_TTL_MS / 1000 });
  });

  app.get('/auth/migrate', async (c) => {
    const nonce = generateCspNonce();
    const csp = getCspHeader(nonce);

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ellul — Passkey Migration</title>
<style nonce="${nonce}">
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0a0a0a;color:#e5e5e5;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{max-width:400px;width:90%;text-align:center;padding:2.5rem}
h1{font-size:1.5rem;margin-bottom:0.5rem;color:#fff}
p{font-size:0.9rem;color:#999;margin-bottom:1.5rem;line-height:1.5}
button{background:#fff;color:#000;border:none;padding:0.75rem 2rem;border-radius:8px;font-size:1rem;cursor:pointer;font-weight:600;transition:opacity 0.2s}
button:hover{opacity:0.85}
button:disabled{opacity:0.3;cursor:not-allowed}
.status{margin-top:1rem;font-size:0.85rem;min-height:1.5em}
.ok{color:#22c55e}
.err{color:#ef4444}
</style>
</head>
<body>
<div class="card">
<h1>Passkey Migration</h1>
<p>Register your passkey on this new origin to complete the migration.</p>
<button id="enroll" onclick="startEnrollment()">Enroll Passkey</button>
<div class="status" id="status"></div>
</div>
<script nonce="${nonce}">
async function startEnrollment(){
  const btn=document.getElementById('enroll');
  const st=document.getElementById('status');
  btn.disabled=true;
  st.textContent='Generating registration options...';
  st.className='status';
  try{
    const optRes=await fetch('/_auth/migration/register/options',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({migration:true}),credentials:'include'});
    if(!optRes.ok)throw new Error('Failed to get options: '+optRes.status);
    const opts=await optRes.json();
    st.textContent='Touch your authenticator...';
    const{startRegistration}=await import('https://cdn.jsdelivr.net/npm/@simplewebauthn/browser@10/dist/bundle/index.min.js');
    const attResp=await startRegistration(opts);
    st.textContent='Verifying...';
    const verRes=await fetch('/_auth/migration/register/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(attResp),credentials:'include'});
    if(!verRes.ok)throw new Error('Verification failed: '+verRes.status);
    const result=await verRes.json();
    if(result.verified){
      st.textContent='Passkey enrolled successfully! You can close this tab.';
      st.className='status ok';
    }else{
      throw new Error('Verification rejected');
    }
  }catch(e){
    st.textContent='Error: '+e.message;
    st.className='status err';
    btn.disabled=false;
  }
}
</script>
</body>
</html>`;

    return c.html(html, 200, { 'Content-Security-Policy': csp });
  });

  app.post('/_auth/migration/register/options', async (c) => {
    if (!validateBridgeSession(c)) {
      return c.json({ error: 'invalid or expired migration session' }, 403);
    }
    const rpId = resolveRpId(c.req.header('host') || hostname);
    const userId = crypto.randomBytes(16);
    const userName = 'migration-user';

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: rpId,
      userID: userId,
      userName,
      userDisplayName: 'Migration User',
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
    });

    storeChallenge(options.challenge, {
      type: 'registration',
      userId: userId.toString('hex'),
    });

    return c.json(options);
  });

  app.post('/_auth/migration/register/verify', async (c) => {
    if (!validateBridgeSession(c)) {
      return c.json({ error: 'invalid or expired migration session' }, 403);
    }
    const body = await c.req.json();
    const rpId = resolveRpId(c.req.header('host') || hostname);
    const origin = c.req.header('origin') || `https://${hostname}`;

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body,
        expectedChallenge: (challenge: string) => {
          const stored = getChallenge(challenge);
          return stored !== null;
        },
        expectedOrigin: ORIGINS.concat([origin, `https://${hostname}`, 'https://localhost']),
        expectedRPID: rpId,
      });
    } catch (e: any) {
      dbg('migration', `registration verification failed: ${e.message}`);
      return c.json({ verified: false, error: e.message }, 400);
    }

    if (!verification.verified || !verification.registrationInfo) {
      return c.json({ verified: false }, 400);
    }

    const { credential } = verification.registrationInfo;

    const credId = Buffer.from(credential.id).toString('base64url');
    const publicKey = Buffer.from(credential.publicKey).toString('base64');

    db.prepare(`
      INSERT INTO credential (id, credential_id, public_key, counter, transports, name)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      credId,
      publicKey,
      credential.counter,
      JSON.stringify(credential.transports || []),
      'migration-passkey',
    );

    logAuditEvent({
      type: 'migration_passkey_enrolled',
      details: { credentialId: credId.slice(0, 16) },
    });

    dbg('migration', `passkey enrolled: ${credId.slice(0, 16)}...`);

    return c.json({ verified: true });
  });

  app.get('/_auth/migration/status', async (c) => {
    const row = db.prepare("SELECT COUNT(*) as count FROM credential WHERE name = 'migration-passkey'").get() as any;
    return c.json({ enrolled: row?.count > 0 });
  });
}
