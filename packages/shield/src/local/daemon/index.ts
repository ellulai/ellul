// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Local Daemon — Slim startup orchestrator
 *
 * Composes the daemon from focused modules:
 *   - state.ts:  types, constants, utilities, rate limiter, peer verification
 *   - exec.ts:   SSE streaming + buffered exec pipeline
 *   - routes.ts: all HTTP route handlers composed via LocalRouter middleware
 *   - repl.ts:   interactive operator control plane
 *   - router.ts: middleware-based HTTP request routing
 *
 * This file handles only daemon lifecycle: initialization, server start,
 * signal handling, and graceful shutdown with connection draining.
 */

import * as http from 'http';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

import { generateOperatorKeyPair } from '@ellul.ai/shield-proxy';

import { getAvailableTier } from '../infra/peercred';
import { initMasterSecret, deriveKeys } from '../crypto/index';
import { LocalProjectRegistry } from '../infra/project-registry';
import { LocalSecretStore } from '../secrets/index';
import { LocalGateManager } from '../gates/index';
import { LocalRuleStore } from '../guardrails/rule-store';
import { resolveGuardrailBinary } from '../guardrails/scanner';
import { LocalLogger } from '../infra/logger';
import { AuditLogger } from '../infra/audit';
import { loadMergedConfig } from '../infra/config';
import type { ExecMode } from '../gates/capability-allowlist';

import {
  type LocalDaemonState,
  CONFIG_DIR, SOCKET_PATH, PORT_FILE, NONCE_FILE, GUARDRAILS_DIR, LOGS_DIR,
  verifyPeer, getSecretStore, reloadSecretEntries, jsonResponse,
} from './state';
import { createRouter } from './routes';
import { startRepl } from './repl';

// Re-export the state type for other modules
export type { LocalDaemonState } from './state';

// ── Socket Cleanup ──

async function cleanStaleSocket(socketPath: string): Promise<void> {
  if (!fs.existsSync(socketPath)) return;

  return new Promise((resolve, reject) => {
    const testSock = new net.Socket();
    const timer = setTimeout(() => {
      testSock.destroy();
      try { fs.unlinkSync(socketPath); } catch {}
      resolve();
    }, 1000);

    testSock.once('connect', () => {
      clearTimeout(timer);
      testSock.destroy();
      reject(new Error(`Another daemon is already running on ${socketPath}`));
    });
    testSock.once('error', () => {
      clearTimeout(timer);
      testSock.destroy();
      try { fs.unlinkSync(socketPath); } catch {}
      resolve();
    });
    testSock.connect(socketPath);
  });
}

// ── Main Daemon Start ──

export async function startLocalDaemon(): Promise<LocalDaemonState> {
  // ── Phase 0: Logger ──
  const logger = new LocalLogger({ logDir: LOGS_DIR, minLevel: 'debug' });
  logger.info('daemon_start', 'ellul daemon v0.1.0 — local governance mode');
  process.stderr.write('ellul daemon v0.1.0 — local governance mode\n\n');

  // ── Phase 1: Master secret + key derivation ──
  const masterSecret = initMasterSecret((msg) => logger.info('crypto', msg));
  const derivedKeys = deriveKeys(masterSecret);
  logger.info('crypto_ready', 'HKDF keys derived');

  // ── Phase 2: Operator keypair (volatile RAM) ──
  const operatorKey = await generateOperatorKeyPair();
  logger.info('operator_key_generated', 'SLH-DSA-SHA2-128s keypair generated');
  process.stderr.write(`  operator key: ${operatorKey.publicKeyBase64.slice(0, 24)}... (volatile RAM)\n`);

  // ── Phase 3: Config validation ──
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const { config: daemonConfig, errors: configErrors, warnings: configWarnings } = loadMergedConfig(CONFIG_DIR, process.cwd());
  if (configErrors.length > 0) {
    for (const err of configErrors) {
      process.stderr.write(`  CONFIG ERROR: ${err}\n`);
      logger.error('config_invalid', err);
    }
    process.stderr.write('\nFix configuration errors and restart.\n');
    process.exit(1);
  }
  for (const warn of configWarnings) {
    process.stderr.write(`  config warning: ${warn}\n`);
    logger.warn('config_warning', warn);
  }

  // Exec mode: double-gate for unrestricted
  let execMode: ExecMode = daemonConfig.execMode || 'capability';
  if (execMode === 'unrestricted' && process.env.ELLUL_ALLOW_UNRESTRICTED !== '1') {
    execMode = 'capability';
    logger.warn('unrestricted_blocked', 'execMode=unrestricted but ELLUL_ALLOW_UNRESTRICTED=1 not set');
    process.stderr.write('  exec mode: capability (unrestricted requires ELLUL_ALLOW_UNRESTRICTED=1)\n');
  } else if (execMode === 'unrestricted') {
    process.stderr.write('  ⚠ UNRESTRICTED EXEC MODE\n');
    logger.warn('unrestricted_mode', 'Unrestricted exec mode active');
  } else {
    process.stderr.write('  exec mode: capability (test/build/lint/dev)\n');
  }

  // ── Phase 3b: Permissions enforcement ──
  try {
    const stat = fs.statSync(CONFIG_DIR);
    if ((stat.mode & 0o777) !== 0o700) {
      fs.chmodSync(CONFIG_DIR, 0o700);
      logger.security('permissions_fixed', 'Fixed ~/.ellul/ to 0700');
    }
  } catch {}

  // ── Phase 4: Audit logger ──
  const audit = new AuditLogger(LOGS_DIR);
  audit.record('daemon_start', 'system', { details: { version: '0.1.0', execMode } });

  // ── Phase 5: Guardrail rule store (graceful degradation) ──
  let ruleStore: LocalRuleStore | null = null;
  try {
    ruleStore = new LocalRuleStore(GUARDRAILS_DIR);
    const ruleCount = ruleStore.listRules().filter(r => r.enabled).length;
    logger.info('rules_loaded', `${ruleCount} guardrail rules active`);
    process.stderr.write(`  guardrail rules: ${ruleCount} active\n`);
  } catch (err) {
    logger.error('rules_failed', `Rule store failed: ${(err as Error).message}`);
    process.stderr.write('  ⚠ guardrail rules: UNAVAILABLE (scans will fail-closed)\n');
  }

  // ── Phase 6: Gate manager ──
  const gateManager = new LocalGateManager(operatorKey.publicKeyBase64);

  // ── Phase 7: Project registry ──
  const registry = new LocalProjectRegistry();

  // ── Phase 8: State assembly ──
  const secretStores = new Map<string, LocalSecretStore>();
  const state: LocalDaemonState = {
    operatorKey, derivedKeys, registry,
    cachedSecretEntries: [],
    secretStores, gateManager, ruleStore, logger, audit, execMode,
    server: null!, socketPath: null, port: null, nonce: null, rl: null,
    activeRequests: new Set(), shuttingDown: false,
  };

  // ── Phase 9: Auto-discover project + load secrets ──
  const cwdProjectFile = path.join(process.cwd(), '.ellul', 'project.json');
  if (fs.existsSync(cwdProjectFile)) {
    const project = await registry.registerProject(process.cwd());
    if (project) {
      process.stderr.write(`  project: ${project.projectName} (${project.projectSlug})\n`);
      process.stderr.write(`    workspace: ${project.directory}\n`);
      process.stderr.write(`    fingerprint: ${project.fingerprint.slice(0, 16)}...\n`);
      reloadSecretEntries(state);
      const store = getSecretStore(state, project.projectSlug);
      process.stderr.write(`  secrets: ${store?.count() ?? 0} loaded\n`);
    }
  }

  // ── Phase 10: Diagnostics ──
  const peercredTier = getAvailableTier();
  if (peercredTier === 'filesystem-only') {
    process.stderr.write('  ⚠ peercred: filesystem-only\n');
  } else {
    process.stderr.write(`  peercred: ${peercredTier}\n`);
  }

  const guardrailBin = resolveGuardrailBinary();
  if (!guardrailBin) {
    process.stderr.write('  ⚠ guardrail binary: NOT FOUND (fail-closed)\n');
  } else {
    process.stderr.write(`  guardrail binary: ${guardrailBin}\n`);
  }

  // ── Phase 11: Create router + HTTP server ──
  const router = createRouter(state);
  const routerHandler = router.handler();

  const server = http.createServer(async (req, res) => {
    try {
      await routerHandler(req, res);
    } catch (err) {
      if (!res.headersSent) jsonResponse(res, 500, { error: 'Internal server error' });
      logger.error('request_error', (err as Error).message);
    }
  });

  server.on('connection', (socket: net.Socket) => {
    if (state.socketPath && !verifyPeer(socket, logger)) {
      socket.destroy();
    }
  });

  state.server = server;

  // ── Phase 12: Listen ──
  const useUnixSocket = process.platform !== 'win32';

  if (useUnixSocket) {
    await cleanStaleSocket(SOCKET_PATH);
    await new Promise<void>((resolve, reject) => {
      server.listen(SOCKET_PATH, () => {
        try { fs.chmodSync(SOCKET_PATH, 0o600); } catch {}
        state.socketPath = SOCKET_PATH;
        resolve();
      });
      server.on('error', reject);
    });
    fs.writeFileSync(path.join(CONFIG_DIR, 'daemon.pid'), String(process.pid), { mode: 0o600 });
    process.stderr.write(`  socket: ${SOCKET_PATH}\n`);
  } else {
    const nonce = crypto.randomBytes(32).toString('hex');
    state.nonce = nonce;
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        state.port = (server.address() as net.AddressInfo).port;
        resolve();
      });
      server.on('error', reject);
    });
    fs.writeFileSync(PORT_FILE, `${state.port}:${process.pid}`, { mode: 0o600 });
    fs.writeFileSync(NONCE_FILE, nonce, { mode: 0o600 });
    process.stderr.write(`  port: ${state.port} (127.0.0.1)\n  ⚠ LOOPBACK TCP MODE\n`);
  }

  // ── Phase 13: Shutdown with connection draining ──
  const shutdown = () => {
    if (state.shuttingDown) { process.exit(1); }
    state.shuttingDown = true;

    audit.record('daemon_shutdown', 'system');
    logger.info('daemon_shutdown', 'Graceful shutdown — draining connections');
    process.stderr.write('\n[shutdown] Graceful shutdown...\n');

    server.close(() => finishShutdown());

    const drainStart = Date.now();
    const drainInterval = setInterval(() => {
      if (state.activeRequests.size === 0 || Date.now() - drainStart > 5000) {
        clearInterval(drainInterval);
        for (const res of state.activeRequests) { try { res.end(); } catch {} }
        server.close(() => finishShutdown());
      }
    }, 100);
    drainInterval.unref();
    setTimeout(() => process.exit(1), 8000).unref();

    function finishShutdown(): void {
      operatorKey.secretKey.fill(0);
      derivedKeys.stsSigningKey.fill(0);
      derivedKeys.receiptKey.fill(0);
      derivedKeys.secretsEncKey.fill(0);
      process.stderr.write('[shutdown] Keys zeroized\n');

      for (const store of secretStores.values()) { try { store.close(); } catch {} }
      if (ruleStore) { try { ruleStore.close(); } catch {} }
      gateManager.dispose();
      if (state.rl) state.rl.close();
      audit.close();
      logger.close();

      if (state.socketPath) {
        try { fs.unlinkSync(state.socketPath); } catch {}
        try { fs.unlinkSync(path.join(CONFIG_DIR, 'daemon.pid')); } catch {}
      }
      if (state.port) {
        try { fs.unlinkSync(PORT_FILE); } catch {}
        try { fs.unlinkSync(NONCE_FILE); } catch {}
      }
      process.stderr.write('[shutdown] Complete\n');
      process.exit(0);
    }
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // ── Phase 14: Start REPL ──
  process.stderr.write('\n  gates: all closed\n\n');
  state.rl = await startRepl(state);

  logger.info('daemon_ready', 'Daemon ready');
  return state;
}
