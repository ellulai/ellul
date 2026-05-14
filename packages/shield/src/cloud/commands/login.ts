// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

// `ellul login`. Fast path = keychain device cred + PoP; fallback = browser passkey + device register.
// Domain: --domain → ~/.ellul/config.json → .ellul/project.json → prompt.

import * as crypto from 'crypto';
import * as http from 'http';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import type { ParsedArgs } from '../../lib/flags';
import { success, fail, info, EXIT, isJsonMode } from '../../lib/output';
import { showCommandHelp, registerCommand } from '../../lib/help';
import { prompt } from '../../lib/context';
import { CliHost, type StoredCliSession } from '@ellul.ai/shield-proxy/cli-host';
import { performMlKemBind, signDeviceChallenge, signRequest } from '@ellul.ai/shield-proxy';
import { openBrowser } from '../browser-callback';

const CONFIG_DIR = `${process.env.HOME}/.ellul`;
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const SIGNUP_URL = 'https://ellul.ai/signup';

// SSRF guard: ellul.ai subdomains + localhost only.
const DOMAIN_REGEX = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;
const ALLOWED_SUFFIXES = ['.ellul.ai'];
const ALLOWED_DEV_DOMAINS = ['localhost', '127.0.0.1'];

function validateDomain(domain: string): void {
  // Reject URL-structural characters that could break URL construction
  if (!DOMAIN_REGEX.test(domain)) {
    throw new Error(
      `Invalid domain: "${domain}". Domain must contain only alphanumeric characters, hyphens, and dots.`,
    );
  }

  // Must be an ellul.ai subdomain or a local dev domain
  const isAllowedSuffix = ALLOWED_SUFFIXES.some(s => domain.endsWith(s));
  const isDevDomain = ALLOWED_DEV_DOMAINS.includes(domain);

  if (!isAllowedSuffix && !isDevDomain) {
    throw new Error(
      `Untrusted domain: "${domain}". Only *.ellul.ai domains are allowed. ` +
      `If this is your VPS, check your domain configuration.`,
    );
  }
}

// ── Domain Discovery ──

interface GlobalConfig {
  domain?: string;
  [key: string]: unknown;
}

interface LocalProject {
  domain?: string;
  [key: string]: unknown;
}

function readGlobalConfig(): GlobalConfig {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function readLocalProject(): LocalProject {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(process.cwd(), '.ellul', 'project.json'), 'utf8'),
    );
  } catch {
    return {};
  }
}

function writeGlobalConfig(updates: Record<string, unknown>): void {
  const existing = readGlobalConfig();
  const merged = { ...existing, ...updates };
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2) + '\n');
}

// ── Domain Discovery ── (prompt() from ../lib/context)

async function discoverDomain(flagDomain?: string): Promise<{ domain: string; isNewAccount: boolean }> {
  // 1. Explicit --domain flag
  if (flagDomain) {
    validateDomain(flagDomain);
    return { domain: flagDomain, isNewAccount: false };
  }

  // 2. Global config from previous login
  const globalDomain = readGlobalConfig().domain;
  if (globalDomain) {
    validateDomain(globalDomain);
    return { domain: globalDomain, isNewAccount: false };
  }

  // 3. Local .ellul/project.json (may contain domain after provisioning)
  const localDomain = readLocalProject().domain;
  if (localDomain) {
    validateDomain(localDomain);
    return { domain: localDomain, isNewAccount: false };
  }

  // 4. Interactive prompt
  process.stderr.write('\n  How would you like to connect?\n\n');
  process.stderr.write('  1) I have an existing ellul VPS (enter domain)\n');
  process.stderr.write('  2) Create a new account at ellul.ai\n\n');

  const choice = await prompt('  Choice [1-2]: ');

  if (choice === '2') {
    return { domain: '', isNewAccount: true };
  }

  if (choice === '1') {
    const domain = await prompt('  Domain (e.g. srv-abc123.ellul.ai): ');
    if (!domain) {
      fail(EXIT.USAGE, 'login', 'No domain provided.', 'Usage: ellul login --domain=srv-xxx.ellul.ai');
    }
    validateDomain(domain);
    return { domain, isNewAccount: false };
  }

  fail(EXIT.USAGE, 'login', 'Invalid choice.', 'Enter 1 (existing VPS) or 2 (new account).');
}

// ── Browser Opener (imported from ../browser-callback) ──

// ── Callback Server ──

interface CallbackResult {
  code: string;
  nonce: string;
  domain?: string; // present only in new-account flow
}

/**
 * Create callback HTTP server bound to 127.0.0.1 on a random port.
 * Returns the server, its port, and a promise that resolves when a valid
 * callback is received (or rejects on timeout/error).
 *
 * The port is available synchronously after this call returns — Node's
 * `server.listen(0, '127.0.0.1')` binds immediately for localhost.
 */
function createCallbackServer(
  expectedNonce: string,
  signal: AbortSignal,
): { server: http.Server; port: number; resultPromise: Promise<CallbackResult> } {
  let resolveResult!: (result: CallbackResult) => void;
  let rejectResult!: (err: Error) => void;

  const resultPromise = new Promise<CallbackResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const server = http.createServer((req, res) => {
    // Only accept connections from localhost
    const remoteAddr = req.socket.remoteAddress;
    if (remoteAddr !== '127.0.0.1' && remoteAddr !== '::1' && remoteAddr !== '::ffff:127.0.0.1') {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const code = url.searchParams.get('code');
    const nonce = url.searchParams.get('nonce');
    const domain = url.searchParams.get('domain') ?? undefined;

    if (!code || !nonce) {
      res.writeHead(400);
      res.end('Missing code or nonce parameter.');
      return;
    }

    if (nonce !== expectedNonce) {
      res.writeHead(403);
      res.end('Nonce mismatch — possible CSRF attack. Login aborted.');
      return;
    }

    // Send success page to browser
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      '<!DOCTYPE html><html><body style="font-family:system-ui;text-align:center;padding:60px">' +
      '<h2>Login successful</h2>' +
      '<p>You can close this tab and return to the terminal.</p>' +
      '</body></html>',
    );

    server.close();
    resolveResult({ code, nonce, domain });
  });

  // Bind to 127.0.0.1 only — prevents external connections
  server.listen(0, '127.0.0.1');
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;

  if (port === 0) {
    server.close();
    throw new Error('Failed to bind callback server to a local port.');
  }

  // Abort handler for timeout
  const onAbort = () => {
    server.close();
    rejectResult(new Error('Login timed out — no callback received within 5 minutes.'));
  };

  if (signal.aborted) {
    server.close();
    throw new Error('Login timed out — no callback received within 5 minutes.');
  }
  signal.addEventListener('abort', onAbort, { once: true });

  server.on('error', (err) => {
    rejectResult(new Error(`Callback server failed: ${err.message}`));
  });

  return { server, port, resultPromise };
}

// ── Code Exchange ──

interface ExchangeResponse {
  sessionId: string;
  tier: 'standard' | 'web_locked';
  svcUser?: string;
  expiresAt: number;
}

async function exchangeCode(
  domain: string,
  code: string,
): Promise<ExchangeResponse> {
  const url = `https://srv.${domain}/_auth/client/exchange`;
  const body = JSON.stringify({ code });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
    throw new Error(`Exchange failed: ${errBody.error ?? `HTTP ${res.status}`}`);
  }

  return (await res.json()) as ExchangeResponse;
}

// ── Device Challenge-Response ──

interface ChallengeResponse {
  challenge: string;
  expiresIn: number;
}

interface DeviceAuthResponse {
  sessionId: string;
  tier: 'standard' | 'web_locked';
  svcUser?: string;
  expiresAt: number;
  deviceTrustExpiresAt: number;
}

interface DeviceRegisterResponse {
  deviceId: string;
  deviceName: string;
  expiresAt: number;
}

/**
 * Fast path: try to authenticate using a registered device credential.
 * Returns session data on success, null if device auth is unavailable
 * (no credential, trust expired, revoked, network error).
 *
 * Only deletes the device credential on definitive server rejection
 * or local corruption — never on transient/network errors.
 */
async function tryDeviceAuth(
  domain: string,
  cliHost: CliHost,
): Promise<{ session: DeviceAuthResponse; method: 'device' } | null> {
  const deviceCred = await cliHost.getDeviceCredential();
  if (!deviceCred) return null;

  // Client-side trust expiry check (don't delete — let server decide)
  if (deviceCred.trustExpiresAt < Date.now()) {
    process.stderr.write('[login] Device trust expired. Opening browser to re-authenticate...\n');
    return null;
  }

  info('login', `Found registered device for ${domain}`);
  info('login', 'Requesting challenge...');

  // Step 1: Request challenge
  let challengeRes: Response;
  try {
    challengeRes = await fetch(`https://srv.${domain}/_auth/device/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: deviceCred.deviceId }),
    });
  } catch {
    process.stderr.write('[login] Could not reach server. Falling back to browser login...\n');
    return null;
  }

  if (!challengeRes.ok) {
    if (challengeRes.status === 401) {
      // Definitive rejection: device revoked/unknown/expired — delete local credential
      await cliHost.deleteDeviceCredential();
      process.stderr.write('[login] Device was revoked. Opening browser to re-register...\n');
    } else {
      // 429 rate-limit or other transient error — preserve credential
      process.stderr.write('[login] Server rejected challenge. Falling back to browser login...\n');
    }
    return null;
  }

  const { challenge } = (await challengeRes.json()) as ChallengeResponse;

  // Step 2: Sign challenge with ML-KEM-derived HMAC key
  const { signature, timestamp } = signDeviceChallenge(
    { hmacKeyBase64: deviceCred.popHmacKeyBase64 },
    challenge,
  );

  // Step 3: Submit challenge response
  let authRes: Response;
  try {
    authRes = await fetch(`https://srv.${domain}/_auth/device/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        challenge,
        deviceId: deviceCred.deviceId,
        popTimestamp: timestamp,
        popSignature: signature,
      }),
    });
  } catch {
    process.stderr.write('[login] Could not reach server. Falling back to browser login...\n');
    return null;
  }

  if (!authRes.ok) {
    if (authRes.status === 401) {
      // Definitive rejection: bad signature / key mismatch — delete corrupted credential
      await cliHost.deleteDeviceCredential();
      process.stderr.write('[login] Device key invalid. Opening browser to re-register...\n');
    } else {
      // 429 rate-limit or other transient error — preserve credential
      process.stderr.write('[login] Authentication rejected. Falling back to browser login...\n');
    }
    return null;
  }

  const session = (await authRes.json()) as DeviceAuthResponse;

  // Update local trust expiry to match server's sliding renewal
  await cliHost.storeDeviceCredential({
    ...deviceCred,
    trustExpiresAt: session.deviceTrustExpiresAt,
  });

  return { session, method: 'device' };
}

/**
 * Register the CLI as a trusted device after a browser-based login.
 * Uses the active session + PoP headers for authentication.
 * Non-fatal: if registration fails, login still succeeds (just no fast path next time).
 */
async function registerDevice(
  domain: string,
  sessionId: string,
  popHmacKeyBase64: string,
  cliHost: CliHost,
): Promise<void> {
  const deviceName = os.hostname() || 'CLI Device';

  // Sign the register request with PoP (SESSION-gated endpoint).
  // Body MUST be passed to signRequest so the PoP signature covers the body hash —
  // server-side tier-gate computes getDeterministicBodyHash(rawBody) during verification.
  const bodyJson = JSON.stringify({ deviceName });
  const popHeaders = signRequest({ hmacKeyBase64: popHmacKeyBase64 }, 'POST', '/_auth/device/register', bodyJson);

  try {
    const res = await fetch(`https://srv.${domain}/_auth/device/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `__Host-shield_session=${sessionId}`,
        ...popHeaders,
      },
      body: bodyJson,
    });

    if (!res.ok) {
      // Non-fatal — login succeeded, just no fast path
      process.stderr.write('[login] Device registration skipped (server declined).\n');
      return;
    }

    const { deviceId, expiresAt } = (await res.json()) as DeviceRegisterResponse;

    // Store device credential (long-lived, survives session expiry)
    await cliHost.storeDeviceCredential({
      deviceId,
      popHmacKeyBase64,
      trustExpiresAt: expiresAt,
      domain,
    });

    info('login', 'Device registered.');
  } catch {
    // Non-fatal
    process.stderr.write('[login] Device registration skipped (network error).\n');
  }
}

// ── Help Registration ──

registerCommand({
  name: 'login',
  summary: 'Browser passkey login',
  usage: 'ellul login [options]',
  flags: [
    { name: 'domain', description: 'VPS domain (skips interactive discovery)', valueHint: 'srv-xxx.ellul.ai' },
  ],
  examples: [
    'ellul login',
    'ellul login --domain=srv-abc123.ellul.ai',
    'ellul login --domain=srv-abc123.ellul.ai --json',
  ],
  notes: [
    'Requires a GUI environment for browser-based passkey authentication.',
    'Fast path: if a trusted device exists, authenticates without browser.',
  ],
});

// ── Main Login Command ──

export async function loginCommand(args: ParsedArgs): Promise<void> {
  if (args.has('help')) {
    showCommandHelp('login');
    process.exit(0);
  }

  // Phase 1: Discover domain
  const { domain: discoveredDomain, isNewAccount } = await discoverDomain(args.get('domain'));

  // Phase 2: Fast path — device challenge-response (skip for new accounts)
  if (!isNewAccount && discoveredDomain) {
    const cliHost = new CliHost({ domain: discoveredDomain });

    const deviceResult = await tryDeviceAuth(discoveredDomain, cliHost);
    if (deviceResult) {
      const { session } = deviceResult;

      // Store session (without PoP key — lives in device credential)
      const storedSession: StoredCliSession = {
        sessionId: session.sessionId,
        tier: session.tier,
        domain: discoveredDomain,
        expiresAt: session.expiresAt,
      };

      try {
        await cliHost.storeSession(storedSession);
      } catch (err) {
        throw new Error(
          `Failed to store session in OS keychain: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      writeGlobalConfig({ domain: discoveredDomain });

      if (!isJsonMode()) {
        process.stderr.write(
          `\n  \x1b[32m\u2713\x1b[0m Authenticated via registered device.\n\n` +
          `  \x1b[2mdomain\x1b[0m   ${discoveredDomain}\n` +
          `  \x1b[2mtier\x1b[0m     ${session.tier}\n` +
          `  \x1b[2mexpires\x1b[0m  ${new Date(session.expiresAt).toLocaleString()}\n\n`,
        );
      }

      success({
        domain: discoveredDomain,
        tier: session.tier,
        method: 'device',
        expiresAt: session.expiresAt,
      });
      return;
    }
  }

  // Phase 3: Browser fallback — passkey authentication
  const nonce = crypto.randomBytes(32).toString('hex');
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), CALLBACK_TIMEOUT_MS);

  let server: http.Server | null = null;

  try {
    const callbackServer = createCallbackServer(nonce, abortController.signal);
    server = callbackServer.server;
    const { port, resultPromise } = callbackServer;

    if (isNewAccount) {
      const signupUrl = `${SIGNUP_URL}?callback_port=${port}&nonce=${encodeURIComponent(nonce)}&product=shield_proxy`;
      process.stderr.write('[login] Opening browser to create a new account...\n');
      openBrowser(signupUrl);
      process.stderr.write('[login] After account creation, you will be redirected back here.\n');
    } else {
      const loginUrl =
        `https://srv.${discoveredDomain}/_auth/login` +
        `?callback_port=${port}&nonce=${encodeURIComponent(nonce)}`;
      process.stderr.write(`[login] Opening browser for passkey login on ${discoveredDomain}...\n`);
      openBrowser(loginUrl);
    }

    process.stderr.write(`[login] Waiting for callback on http://127.0.0.1:${port}/callback ...\n`);

    const callback = await resultPromise;

    const finalDomain = callback.domain ?? discoveredDomain;
    if (!finalDomain) {
      throw new Error('No domain received. Login cannot proceed.');
    }
    validateDomain(finalDomain);

    info('login', 'Callback received. Exchanging auth code...');

    const session = await exchangeCode(finalDomain, callback.code);

    // Perform ML-KEM-1024 bind handshake to establish HMAC session key
    info('login', 'Performing ML-KEM session bind...');
    const sessionCookie = `shield_session=${session.sessionId}`;
    const popHmacKey = await performMlKemBind(`https://srv.${finalDomain}`, sessionCookie);

    // Store session with ML-KEM-derived HMAC key
    const storedSession: StoredCliSession = {
      sessionId: session.sessionId,
      tier: session.tier,
      domain: finalDomain,
      expiresAt: session.expiresAt,
      popHmacKeyBase64: popHmacKey.hmacKeyBase64,
    };

    const cliHost = new CliHost({ domain: finalDomain });
    try {
      await cliHost.storeSession(storedSession);
    } catch (err) {
      throw new Error(
        `Failed to store session in OS keychain: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    writeGlobalConfig({ domain: finalDomain });

    // Register device for fast path on next login (non-fatal)
    await registerDevice(
      finalDomain,
      session.sessionId,
      popHmacKey.hmacKeyBase64,
      cliHost,
    );

    if (!isJsonMode()) {
      process.stderr.write(
        `\n  \x1b[32m\u2713\x1b[0m Login successful.\n\n` +
        `  \x1b[2mdomain\x1b[0m   ${finalDomain}\n` +
        `  \x1b[2mtier\x1b[0m     ${session.tier}\n` +
        `  \x1b[2mexpires\x1b[0m  ${new Date(session.expiresAt).toLocaleString()}\n\n`,
      );
    }

    success({
      domain: finalDomain,
      tier: session.tier,
      method: 'browser',
      expiresAt: session.expiresAt,
    });
  } finally {
    clearTimeout(timeout);
    if (server) {
      server.close();
    }
  }
}
