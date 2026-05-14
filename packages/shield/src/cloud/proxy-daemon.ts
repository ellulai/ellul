// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Proxy daemon: AuthProxyEngine + StsManager + ProjectRegistry + BackgroundSync + GateStream + REPL.
// /_internal/* routes on same port serve MCP subprocess coordination (sync-receipt, gate-grant, etc.).
// getProxyUrl() verifies PID liveness; stale port files from crashed procs are ignored.

import * as net from 'net';
import * as http from 'http';
import fs from 'fs';
import path from 'path';
import { AuthProxyEngine, StsManager, generateOperatorKeyPair, signDeviceChallenge } from '@ellul.ai/shield-proxy';
import { CliHost } from '@ellul.ai/shield-proxy/cli-host';
import { ProjectRegistry } from './project-registry';
import { GateStream, type GateEvent } from './gate-stream';
import { BackgroundSyncManager } from './background-sync';
import { ContentHasher } from '../shared/content-hash';
import { startRepl, handleGateRequest, type ReplDeps } from './repl';

const CONFIG_DIR = `${process.env.HOME}/.ellul`;
const PORT_FILE = path.join(CONFIG_DIR, 'proxy.port');

/** API base URL for wake/heartbeat (talks to API server, not VPS) */
const API_URL = process.env.ELLUL_API_URL || 'https://api.ellul.ai';

/** CLI heartbeat interval (30s — idle-manager considers stale after 90s) */
const CLI_HEARTBEAT_INTERVAL_MS = 30_000;

/** Interval between redaction dictionary refreshes (5 minutes). */
const REDACTION_REFRESH_MS = 5 * 60 * 1000;

// Port file format: "port:pid" — PID enables liveness check without TCP probe.
interface PortRecord {
  port: number;
  pid: number;
}

function writePortFile(record: PortRecord): void {
  fs.writeFileSync(PORT_FILE, `${record.port}:${record.pid}`, { mode: 0o600 });
}

function readPortFile(): PortRecord | null {
  try {
    const raw = fs.readFileSync(PORT_FILE, 'utf8').trim();
    const [portStr, pidStr] = raw.split(':');
    const port = parseInt(portStr, 10);
    const pid = pidStr ? parseInt(pidStr, 10) : 0;
    if (isNaN(port) || port <= 0) return null;
    return { port, pid };
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Fallback when PID check ambiguous (PID reuse).
function probePort(port: number, timeoutMs: number = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, timeoutMs);

    sock.connect(port, '127.0.0.1', () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(true);
    });

    sock.on('error', () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(false);
    });
  });
}

// Silent no-op when no project bound or fetch fails.
async function loadRedactionSecrets(engine: AuthProxyEngine, proxyUrl: string, projectName: string): Promise<void> {
  try {
    const resp = await fetch(`${proxyUrl}/_auth/secrets/values?app=${encodeURIComponent(projectName)}`);
    if (!resp.ok) return;
    const data = await resp.json() as { values?: Record<string, string> };
    const values = data.values ?? (data as Record<string, string>);
    const entries = Object.entries(values).map(([name, value]) => ({ name, value }));
    if (entries.length > 0) {
      engine.setRedactionSecrets(entries);
      process.stderr.write(`[proxy] Redaction dictionary loaded: ${entries.length} secrets\n`);
    }
  } catch {
    // Secrets not available yet — redaction remains inactive until next refresh
  }
}

// ── Internal request body reader ──

function readRequestBody(req: http.IncomingMessage, maxSize: number = 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > maxSize) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ── Internal route handlers ──

function handleSyncReceipt(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  registry: ProjectRegistry,
): void {
  const url = new URL(req.url || '/', `http://localhost`);
  const project = url.searchParams.get('project');

  if (!project) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing project query parameter' }));
    return;
  }

  readRequestBody(req).then((body) => {
    let data: { hash?: string };
    try {
      data = JSON.parse(body.toString('utf8'));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    if (data.hash && typeof data.hash === 'string') {
      registry.updateSyncState(project, data.hash);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }).catch(() => {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal error' }));
    }
  });
}

function handleGateGrant(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  replState: ReturnType<typeof startRepl> | null,
): void {
  readRequestBody(req).then((body) => {
    let data: { requestId?: string; gate?: string; reason?: string; project?: string };
    try {
      data = JSON.parse(body.toString('utf8'));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    if (!data.requestId || !data.gate || !data.project) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required fields: requestId, gate, project' }));
      return;
    }

    // Forward to REPL gate handler if available
    if (replState) {
      handleGateRequest(replState, {
        requestId: data.requestId,
        gate: data.gate,
        reason: data.reason || '',
        project: data.project,
      });
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }).catch(() => {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal error' }));
    }
  });
}

function handleGateRevoke(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  engine: AuthProxyEngine,
): void {
  readRequestBody(req).then((body) => {
    let data: { gate?: string; project?: string };
    try {
      data = JSON.parse(body.toString('utf8'));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    if (!data.gate || !data.project) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required fields: gate, project' }));
      return;
    }

    // Forward the revocation to the VPS through the proxy
    const proxyUrl = `http://127.0.0.1:${engine.getPort()}/_auth/gates/revoke`;
    fetch(proxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: data.project, gate: data.gate }),
    }).then((upstream) => {
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
      upstream.text().then((text) => res.end(text)).catch(() => res.end('{}'));
    }).catch(() => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Upstream error' }));
    });
  }).catch(() => {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal error' }));
    }
  });
}

function handlePolicySet(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  engine: AuthProxyEngine,
): void {
  readRequestBody(req).then((body) => {
    let data: { gate?: string; project?: string; policy?: string };
    try {
      data = JSON.parse(body.toString('utf8'));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    if (!data.gate || !data.project || !data.policy) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required fields: gate, project, policy' }));
      return;
    }

    const validPolicies = ['ask', 'allow_always', 'never'];
    if (!validPolicies.includes(data.policy)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Invalid policy. Must be one of: ${validPolicies.join(', ')}` }));
      return;
    }

    // Forward the policy change to the VPS through the proxy
    const proxyUrl = `http://127.0.0.1:${engine.getPort()}/_auth/gates/permissions`;
    fetch(proxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: data.project, gate: data.gate, policy: data.policy }),
    }).then((upstream) => {
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
      upstream.text().then((text) => res.end(text)).catch(() => res.end('{}'));
    }).catch(() => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Upstream error' }));
    });
  }).catch(() => {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal error' }));
    }
  });
}

function handleConnect(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  registry: ProjectRegistry,
  syncManager: BackgroundSyncManager,
  gateStream: GateStream,
): void {
  readRequestBody(req).then(async (body) => {
    let data: { projectId?: string; projectSlug?: string; projectName?: string; directory?: string };
    try {
      data = JSON.parse(body.toString('utf8'));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    if (!data.directory) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required field: directory' }));
      return;
    }

    const project = await registry.registerProject(data.directory);
    if (!project) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No valid .ellul/project.json found in directory' }));
      return;
    }

    // Start background sync for the new project
    await syncManager.startProject(project.projectSlug, project.directory);

    // Connect gate stream
    gateStream.connect(project.projectSlug);
    registry.setConnected(project.projectSlug, true);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }).catch(() => {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal error' }));
    }
  });
}

function handleDisconnect(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  registry: ProjectRegistry,
  syncManager: BackgroundSyncManager,
  gateStream: GateStream,
): void {
  readRequestBody(req).then((body) => {
    let data: { projectId?: string; projectSlug?: string };
    try {
      data = JSON.parse(body.toString('utf8'));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    // Resolve slug — either directly provided or found by scanning registry for projectId
    let slug: string | null = null;

    if (data.projectSlug) {
      slug = data.projectSlug;
    } else if (data.projectId) {
      // Scan registered projects to find the one with this projectId
      const allProjects = registry.getAllProjects();
      for (const p of allProjects) {
        try {
          const raw = fs.readFileSync(path.join(p.directory, '.ellul', 'project.json'), 'utf8');
          const config = JSON.parse(raw) as { projectId?: string };
          if (config.projectId === data.projectId) {
            slug = p.projectSlug;
            break;
          }
        } catch {
          // Skip unreadable project files
        }
      }
    }

    if (!slug) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing projectSlug or projectId, or project not found' }));
      return;
    }

    // Verify project exists in registry
    const project = registry.getProject(slug);
    if (!project) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Project "${slug}" not registered` }));
      return;
    }

    // Stop background sync
    syncManager.stopProject(slug);

    // Disconnect gate stream
    gateStream.disconnect(slug);

    // Remove from registry
    registry.removeProject(slug);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }).catch(() => {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal error' }));
    }
  });
}

// ── Main daemon entry point ──

export async function startProxyDaemon(opts?: { domain?: string; projectName?: string }): Promise<void> {
  const host = new CliHost(opts);

  if (!host.getDomain()) {
    process.stderr.write('[proxy] No domain configured. Run `ellul init` first.\n');
    process.exit(1);
  }

  // Check if another proxy is already running
  const existing = readPortFile();
  if (existing && isPidAlive(existing.pid)) {
    const alive = await probePort(existing.port);
    if (alive) {
      process.stderr.write(`[proxy] Already running on http://127.0.0.1:${existing.port} (pid ${existing.pid})\n`);
      process.exit(0);
    }
  }

  // ── Phase 1: STS Manager ──
  const stsManager = new StsManager(host);

  // ── Phase 2: Auth Proxy Engine + STS attachment ──
  const engine = new AuthProxyEngine(host);
  engine.setStsManager(stsManager);

  // ── Phase 3: Start engine → get port ──
  const port = await engine.start();
  stsManager.setProxyPort(port);
  const proxyUrl = `http://127.0.0.1:${port}`;

  // ── Phase 4: Write port file ──
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writePortFile({ port, pid: process.pid });

  process.stderr.write(`[proxy] Auth proxy listening on ${proxyUrl}\n`);
  process.stderr.write(`[proxy] Vault UI: ${proxyUrl}/_vault\n`);
  process.stderr.write(`[proxy] PID: ${process.pid}\n`);

  // ── Phase 4.5: Operator Key Binding ──
  // Generate SLH-DSA-SHA2-128s keypair in volatile RAM (never persisted).
  // This key makes it mathematically impossible for MCP subprocesses
  // (separate OS processes) to approve/deny gates or change permissions.
  const operatorKey = await generateOperatorKeyPair();

  // Re-authenticate via device trust to get a fresh session + bind nonce.
  // This ensures a clean operator binding even after daemon restart.
  const deviceCred = await host.getDeviceCredential();
  if (deviceCred && deviceCred.trustExpiresAt > Date.now() && deviceCred.popHmacKeyBase64) {
    try {
      // Step 1: Challenge
      const challengeRes = await fetch(`${proxyUrl}/_auth/device/challenge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: deviceCred.deviceId }),
      });

      if (challengeRes.ok) {
        const { challenge } = (await challengeRes.json()) as { challenge: string };

        // Step 2: Authenticate (gets fresh session + operatorBindNonce)
        const { signature, timestamp } = signDeviceChallenge(
          { hmacKeyBase64: deviceCred.popHmacKeyBase64 },
          challenge,
        );
        const authRes = await fetch(`${proxyUrl}/_auth/device/authenticate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            challenge,
            deviceId: deviceCred.deviceId,
            popTimestamp: timestamp,
            popSignature: signature,
          }),
        });

        if (authRes.ok) {
          const authData = (await authRes.json()) as {
            sessionId: string;
            tier: 'standard' | 'web_locked';
            expiresAt: number;
            deviceTrustExpiresAt: number;
            operatorBindNonce: string;
          };

          // Store fresh session
          await host.storeSession({
            sessionId: authData.sessionId,
            tier: authData.tier,
            domain: host.getDomain(),
            expiresAt: authData.expiresAt,
          });

          // Update device trust expiry
          await host.storeDeviceCredential({
            ...deviceCred,
            trustExpiresAt: authData.deviceTrustExpiresAt,
          });

          // Step 3: Bind operator key with the nonce (only we know it)
          const bindRes = await fetch(`${proxyUrl}/_auth/gates/bind-operator`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              operatorPublicKey: operatorKey.publicKeyBase64,
              operatorBindNonce: authData.operatorBindNonce,
            }),
          });

          if (bindRes.ok) {
            process.stderr.write('[proxy] Operator key bound to session\n');
          } else {
            process.stderr.write(`[proxy] Warning: operator binding failed (${bindRes.status})\n`);
          }
        } else {
          process.stderr.write('[proxy] Warning: device re-auth failed, gate control unavailable\n');
        }
      } else {
        process.stderr.write('[proxy] Warning: device challenge failed, gate control unavailable\n');
      }
    } catch (err) {
      process.stderr.write(`[proxy] Warning: operator binding error: ${err instanceof Error ? err.message : err}\n`);
    }
  } else if (deviceCred) {
    process.stderr.write('[proxy] Device trust expired, gate control unavailable until re-login\n');
  }

  // ── Phase 5: Project Registry ──
  const registry = new ProjectRegistry(stsManager, port);

  // ── Phase 6: Auto-discover project from cwd ──
  const projectConfig = host.getProjectConfig();
  if (projectConfig) {
    await registry.registerProject(process.cwd());

    // Load redaction dictionary
    // Use slug for secrets endpoint — VPS keys secrets by slug
    const registeredProject = registry.getAllProjects()[0];
    const secretsKey = registeredProject?.projectSlug;
    await loadRedactionSecrets(engine, proxyUrl, secretsKey);

    // Periodically refresh the redaction dictionary to catch secret rotations
    const refreshTimer = setInterval(() => {
      loadRedactionSecrets(engine, proxyUrl, secretsKey);
    }, REDACTION_REFRESH_MS);
    refreshTimer.unref();

    // Warn if .env files exist in project directory (agent can read local files)
    try {
      const projectDir = process.cwd();
      const envFiles = fs.readdirSync(projectDir).filter(
        (f: string) => f === '.env' || (f.startsWith('.env.') && !f.endsWith('.example') && !f.endsWith('.sample') && !f.endsWith('.template')),
      );
      if (envFiles.length > 0) {
        process.stderr.write(
          `\x1b[33m[warn]\x1b[0m .env file(s) detected: ${envFiles.join(', ')}\n` +
          `       The agent can read local files. Use /secrets paste or /vault instead.\n`,
        );
      }
    } catch {}
  }

  // ── Phase 7: Content Hasher + Background Sync Manager ──
  const hasher = new ContentHasher();
  const syncManager = new BackgroundSyncManager({
    proxyPort: port,
    hasher,
    log: (msg) => process.stderr.write(`${msg}\n`),
  });

  // Start background sync for all registered projects
  for (const project of registry.getAllProjects()) {
    await syncManager.startProject(project.projectSlug, project.directory);
  }

  // ── Phase 8: Gate Stream (SSE) ──
  // The REPL state is needed for gate request forwarding, but the REPL
  // is created last. We store a mutable reference that gets set after
  // REPL initialization.
  let replState: ReturnType<typeof startRepl> | null = null;

  const gateStream = new GateStream(
    port,
    (event: GateEvent) => {
      if (event.type === 'gate_request' && replState) {
        handleGateRequest(replState, {
          requestId: event.data.requestId as string,
          gate: event.data.gate as string,
          reason: (event.data.reason as string) || '',
          project: event.project,
        });
      }
    },
    (msg) => process.stderr.write(`${msg}\n`),
  );

  // Connect SSE for all registered projects
  for (const project of registry.getAllProjects()) {
    gateStream.connect(project.projectSlug);
    registry.setConnected(project.projectSlug, true);
  }

  // ── Phase 9: Register /_internal/* routes ──
  engine.setInternalHandler((req, res, reqPath) => {
    // Strip query string for route matching
    const routePath = reqPath.split('?')[0];

    if (req.method === 'POST' && routePath === '/_internal/sync-receipt') {
      handleSyncReceipt(req, res, registry);
      return true;
    }

    if (req.method === 'POST' && routePath === '/_internal/gate-grant') {
      handleGateGrant(req, res, replState);
      return true;
    }

    if (req.method === 'POST' && routePath === '/_internal/gate-revoke') {
      // BLOCKED: Gate revocation requires operator signature (agent-proof).
      // Use the REPL /revoke command instead.
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Gate revocation requires operator approval' }));
      return true;
    }

    if (req.method === 'POST' && routePath === '/_internal/policy-set') {
      // BLOCKED: Policy changes require operator signature (agent-proof).
      // Use the REPL /policy command instead.
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Policy changes require operator approval' }));
      return true;
    }

    if (req.method === 'POST' && routePath === '/_internal/connect') {
      handleConnect(req, res, registry, syncManager, gateStream);
      return true;
    }

    if (req.method === 'POST' && routePath === '/_internal/disconnect') {
      handleDisconnect(req, res, registry, syncManager, gateStream);
      return true;
    }

    return false; // Not handled — fall through to 404
  });

  // ── Phase 10: Graceful shutdown with sync ──
  let forceExit = false;
  const shutdown = async () => {
    if (forceExit) {
      process.stderr.write('\n[proxy] Force exit.\n');
      process.exit(1);
    }
    forceExit = true;

    process.stderr.write('\n[proxy] Shutting down...\n');

    // Layer 2: sync all projects before exit
    process.stderr.write('[sync] Syncing projects before exit...\n');
    await syncManager.syncAllBeforeExit();

    // Cleanup all subsystems
    gateStream.dispose();
    syncManager.dispose();
    registry.dispose();
    stsManager.dispose();
    engine.clearRedactionSecrets();
    engine.dispose();
    try { fs.unlinkSync(PORT_FILE); } catch {}
    process.exit(0);
  };

  process.on('SIGINT', () => { shutdown(); });
  process.on('SIGTERM', () => { shutdown(); });

  // ── Phase 11: Start REPL (last — everything else is ready) ──
  replState = startRepl({
    engine,
    stsManager,
    host,
    getProjects: () => registry.getAllProjects(),
    getDefaultProject: () => registry.getDefaultProject(),
    domain: host.getDomain(),
    operatorKey,
  } as ReplDeps);

  // ── Phase 12: CLI Heartbeat (keeps VPS alive while daemon runs) ──
  // Pings VPS /health directly (bypasses proxy auth injection — /health is
  // a PUBLIC endpoint, no session/PoP needed). Avoids wasting a PoP signature
  // computation every 30s for a no-auth health check.
  const vpsHealthUrl = `https://srv.${host.getDomain()}/health`;
  const heartbeatTimer = setInterval(async () => {
    try {
      await fetch(vpsHealthUrl);
    } catch {
      // VPS unreachable — may have been externally hibernated.
      // Don't crash; the user will see errors on next command.
    }
  }, CLI_HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref(); // don't prevent process exit
}

// ── Exported discovery functions (consumed by other CLI commands) ──

// null if file missing, PID dead, or port not listening.
export function readProxyPort(): number | null {
  const record = readPortFile();
  if (!record) return null;

  // Fast path: PID check (synchronous, avoids TCP probe for common case)
  if (!isPidAlive(record.pid)) {
    // Stale port file — clean up
    try { fs.unlinkSync(PORT_FILE); } catch {}
    return null;
  }

  return record.port;
}

// Async TCP liveness variant.
export async function getProxyUrlAsync(): Promise<string | null> {
  const record = readPortFile();
  if (!record) return null;

  if (!isPidAlive(record.pid)) {
    try { fs.unlinkSync(PORT_FILE); } catch {}
    return null;
  }

  // Verify TCP connectivity
  const alive = await probePort(record.port);
  if (!alive) {
    try { fs.unlinkSync(PORT_FILE); } catch {}
    return null;
  }

  return `http://127.0.0.1:${record.port}`;
}

// Sync, PID-liveness only.
export function getProxyUrl(): string | null {
  const port = readProxyPort();
  return port ? `http://127.0.0.1:${port}` : null;
}
