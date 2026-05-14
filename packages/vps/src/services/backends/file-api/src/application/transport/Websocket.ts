// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { exec } from 'child_process';
import { ROOT_DIR, DEBOUNCE_MS, IGNORED_PATTERNS } from '../../config';
import { safeReadFile, safeStat, safeReadDir } from '../../utils';
import { getTree, getActiveProject, getActiveApp } from '../files/Files';
import { detectApps } from '../files/Apps';
import { getAllPreviewHealth, registerPreviewBroadcast } from '../preview/Preview';

// ─── Protocol types ──────────────────────────────────────────────────────────
// Typed discriminated union for all outbound WebSocket messages.
// Frontend consumers can switch on `type` for exhaustive handling.

interface TreePayload { project: string; tree: unknown }
interface StatusPayload { project: string; modified: Array<{ status: string; file: string }> }
interface AppsChangedPayload { hint: 'refetch' }
interface PreviewAllStatusPayload { primary: unknown; companions: unknown[] }
interface PreviewInstallStatusPayload { app: string; phase: string; message: string; runtime?: string }
interface ServerStatusPayload { [key: string]: unknown }
interface WatchdogHealthPayload { [key: string]: unknown }
interface SessionStatusPayload { alive?: boolean; [key: string]: unknown }
interface ConnectedPayload { clientId: string }

type BroadcastType =
  | { type: 'tree'; data: TreePayload }
  | { type: 'status'; data: StatusPayload }
  | { type: 'apps_changed'; data: AppsChangedPayload }
  | { type: 'preview_all_status'; data: PreviewAllStatusPayload }
  | { type: 'preview_install_status'; data: PreviewInstallStatusPayload }
  | { type: 'server_status'; data: ServerStatusPayload }
  | { type: 'watchdog_health'; data: WatchdogHealthPayload }
  | { type: 'session_status'; data: SessionStatusPayload }
  | { type: 'connected'; data: ConnectedPayload };

interface WireFrame {
  type: string;
  data: unknown;
  seq: number;
  timestamp: number;
}

// ─── WebSocket interface (ws package is external runtime dependency) ──────────

interface WsClient {
  readyState: number;
  bufferedAmount: number;
  send(data: string, cb?: (err?: Error) => void): void;
  close(): void;
  ping(data?: unknown, mask?: boolean, cb?: (err: Error) => void): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

interface WsServer {
  on(event: string, listener: (...args: unknown[]) => void): void;
}

const WS_OPEN = 1;

// ─── Per-client connection state ─────────────────────────────────────────────
// Each connection is an isolated unit with its own sequence counter,
// backpressure tracking, and error budget. A slow or broken client
// cannot degrade the service for others.

const BACKPRESSURE_HIGH_WATER = 64 * 1024; // 64 KB buffered → start dropping
const MAX_DROPPED_BEFORE_CLOSE = 50;       // too many drops → close the connection

interface ClientConnection {
  ws: WsClient;
  id: string;
  seq: number;
  droppedMessages: number;
  isAlive: boolean;
  codeSessionId: string | null;
  connectedAt: number;
  timers: {
    absolute: NodeJS.Timeout;
    aliveCheck: NodeJS.Timeout;
    sessionPoll: NodeJS.Timeout | null;
  };
}

const connections = new Map<string, ClientConnection>();
let nextClientId = 1;

function generateClientId(): string {
  return `c_${Date.now().toString(36)}_${(nextClientId++).toString(36)}`;
}

// ─── Broadcast infrastructure ────────────────────────────────────────────────

function safeSend(conn: ClientConnection, type: BroadcastType['type'], data: unknown): boolean {
  if (conn.ws.readyState !== WS_OPEN) return false;

  if (conn.ws.bufferedAmount > BACKPRESSURE_HIGH_WATER) {
    conn.droppedMessages++;
    if (conn.droppedMessages > MAX_DROPPED_BEFORE_CLOSE) {
      console.warn(`[WS] Client ${conn.id} exceeded drop limit (${conn.droppedMessages}) — closing`);
      conn.ws.close();
      return false;
    }
    return false;
  }

  const frame: WireFrame = {
    type,
    data,
    seq: ++conn.seq,
    timestamp: Date.now(),
  };

  try {
    conn.ws.send(JSON.stringify(frame));
    return true;
  } catch {
    return false;
  }
}

export function broadcast(type: string, data: unknown): void {
  for (const conn of connections.values()) {
    safeSend(conn, type as BroadcastType['type'], data);
  }
}

// ─── Change detection state ──────────────────────────────────────────────────
// Global hashes track last-broadcast state. When a hash changes, ALL connected
// clients receive the update (they may individually drop it under backpressure).

let debounceTimer: NodeJS.Timeout | null = null;
let lastTreeHash = '';
let lastStatusHash = '';
let lastAppsHash = '';
let lastServerStatusHash = '';
let lastMultiPreviewHash = '';
let lastWatchdogHealth: unknown = null;
let lastWatchdogHealthHash = '';

const SERVER_STATUS_FILE = `${os.homedir()}/.ellul/server-status.json`;
let gitStatusInFlight = false;

const SHIELD_URL = 'http://127.0.0.1:3005';
const WATCHDOG_URL = 'http://127.0.0.1:7710';

// ─── Utilities ───────────────────────────────────────────────────────────────

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return hash.toString(36);
}

function run(
  cmd: string,
  cwd: string,
): Promise<{ stdout?: string; error?: string; stderr?: string }> {
  return new Promise((resolve) => {
    exec(cmd, { cwd, timeout: 5000 }, (err, stdout, stderr) => {
      if (err) resolve({ error: err.message, stderr });
      else resolve({ stdout: stdout.trim() });
    });
  });
}

// ─── Broadcast server status ─────────────────────────────────────────────────

function broadcastServerStatus(): void {
  try {
    if (!fs.existsSync(SERVER_STATUS_FILE)) return;
    const statusJson = fs.readFileSync(SERVER_STATUS_FILE, 'utf8');
    const statusHash = simpleHash(statusJson);
    if (statusHash !== lastServerStatusHash) {
      lastServerStatusHash = statusHash;
      const status = JSON.parse(statusJson);
      broadcast('server_status', status);
    }
  } catch {
    // Status file might not exist or be mid-write
  }
}

// ─── Compute and broadcast ───────────────────────────────────────────────────

async function computeAndBroadcast(): Promise<void> {
  try {
    const activeSandbox = getActiveProject();
    if (!activeSandbox) return;

    let appRoot: string | null = null;
    const persistedApp = getActiveApp(activeSandbox);
    if (persistedApp) {
      appRoot = `${activeSandbox}/${persistedApp}`;
    } else {
      const apps = detectApps().filter(a => a.kind === 'app' && a.sandboxId === activeSandbox);
      if (apps.length === 1) appRoot = apps[0]!.directory;
    }

    if (!appRoot) return;
    const projectPath = path.join(ROOT_DIR, appRoot);
    if (!fs.existsSync(projectPath)) return;

    // Tree
    try {
      const tree = getTree(projectPath);
      if (tree && !tree.error) {
        const treeJson = JSON.stringify({ project: appRoot, tree });
        const treeHash = simpleHash(treeJson);
        if (treeHash !== lastTreeHash) {
          lastTreeHash = treeHash;
          broadcast('tree', { project: appRoot, tree });
        }
      }
    } catch (e) {
      console.error('[file-api] Error computing tree:', (e as Error).message);
    }

    // Git status — serialized to prevent overlapping processes
    if (!gitStatusInFlight) {
      gitStatusInFlight = true;
      try {
        const status = await run(
          'git --no-optional-locks -c core.fsmonitor= status --porcelain --ignore-submodules --no-renames -unormal',
          projectPath,
        );
        const modified: Array<{ status: string; file: string }> = [];
        if (status.stdout) {
          for (const line of status.stdout.split('\n')) {
            if (line.trim()) {
              const statusCode = line.substring(0, 2);
              const file = line.substring(3);
              modified.push({ status: statusCode.trim() || 'M', file });
            }
          }
        }
        const statusJson = JSON.stringify(modified);
        const statusHash = simpleHash(statusJson);
        if (statusHash !== lastStatusHash) {
          lastStatusHash = statusHash;
          broadcast('status', { project: appRoot, modified });
        }
      } catch (e) {
        console.error('[file-api] Error computing git status:', (e as Error).message);
      } finally {
        gitStatusInFlight = false;
      }
    }

    // Apps changed
    try {
      const configPath = path.join(ROOT_DIR, '.ellul.json');
      const configContent = safeReadFile(configPath);
      const config = configContent
        ? (JSON.parse(configContent) as { hidden?: string[] })
        : { hidden: [] };
      const hiddenApps = new Set(config.hidden || []);
      const appDirs = detectApps()
        .filter(a => (a.kind === 'app' || a.kind === 'package') && !hiddenApps.has(a.directory))
        .map(a => a.directory)
        .sort();
      const appsJson = JSON.stringify(appDirs);
      const appsHash = simpleHash(appsJson);
      if (appsHash !== lastAppsHash) {
        lastAppsHash = appsHash;
        broadcast('apps_changed', { hint: 'refetch' });
      }
    } catch (e) {
      console.error('[file-api] Error computing apps:', (e as Error).message);
    }

    // Preview status
    try {
      const allHealth = await getAllPreviewHealth();
      const multiJson = JSON.stringify(allHealth);
      const multiHash = simpleHash(multiJson);
      if (multiHash !== lastMultiPreviewHash) {
        lastMultiPreviewHash = multiHash;
        broadcast('preview_all_status', allHealth);
      }
    } catch {}

    // Server status
    broadcastServerStatus();
  } catch (e) {
    console.error('[file-api] Error in computeAndBroadcast:', (e as Error).message);
  }
}

// ─── Debounced file change ───────────────────────────────────────────────────

function onFileChange(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    computeAndBroadcast();
  }, DEBOUNCE_MS);
}

function shouldIgnorePath(filepath: string): boolean {
  return IGNORED_PATTERNS.some(
    (p) => filepath.includes('/' + p + '/') || filepath.endsWith('/' + p),
  );
}

// ─── File watchers ───────────────────────────────────────────────────────────

const watchedDirs = new Set<string>();
const watcherInstances = new Map<string, fs.FSWatcher>();
let serverStatusWatcher: fs.FSWatcher | null = null;

function watchDir(dir: string): void {
  if (watchedDirs.has(dir) || shouldIgnorePath(dir)) return;

  const stat = safeStat(dir);
  if (!stat || !stat.isDirectory()) return;

  try {
    const watcher = fs.watch(dir, { persistent: true }, (_eventType, filename) => {
      if (filename && !shouldIgnorePath(filename)) {
        onFileChange();
      }
    });

    watcher.on('error', (err) => {
      console.error(`[Watch] Error on ${dir}:`, err.message);
      watchedDirs.delete(dir);
      watcherInstances.delete(dir);
      setTimeout(() => watchDir(dir), 5000);
    });

    watcher.on('close', () => {
      watchedDirs.delete(dir);
      watcherInstances.delete(dir);
    });

    watchedDirs.add(dir);
    watcherInstances.set(dir, watcher);
  } catch (e) {
    console.error(`[Watch] Failed to watch ${dir}:`, (e as Error).message);
  }
}

export function initWatchers(): void {
  const rootStat = safeStat(ROOT_DIR);
  if (!rootStat || !rootStat.isDirectory()) {
    console.error('[Watch] ROOT_DIR does not exist:', ROOT_DIR);
    return;
  }

  watchDir(ROOT_DIR);

  const entries = safeReadDir(ROOT_DIR);
  for (const entry of entries) {
    const subPath = path.join(ROOT_DIR, entry);
    const stat = safeStat(subPath);
    if (stat && stat.isDirectory() && !shouldIgnorePath(entry)) {
      watchDir(subPath);

      for (const srcDir of ['src', 'app', 'pages', 'components', 'lib', 'packages', 'apps']) {
        const deepPath = path.join(subPath, srcDir);
        const deepStat = safeStat(deepPath);
        if (deepStat && deepStat.isDirectory()) {
          watchDir(deepPath);
        }
      }
    }
  }

  console.log(`[Watch] Watching ${watchedDirs.size} directories`);
}

// ─── Preview status watcher ──────────────────────────────────────────────────

export function initPreviewStatusWatcher(): void {
  registerPreviewBroadcast(broadcast);

  setInterval(async () => {
    if (connections.size === 0) return;
    try {
      const allHealth = await getAllPreviewHealth();
      const multiJson = JSON.stringify(allHealth);
      const multiHash = simpleHash(multiJson);
      if (multiHash !== lastMultiPreviewHash) {
        lastMultiPreviewHash = multiHash;
        broadcast('preview_all_status', allHealth);
      }
    } catch {}
  }, 3000);
}

// ─── Watchdog health watcher ─────────────────────────────────────────────────

const WATCHDOG_POLL_INTERVAL_MS = 10_000;
let watchdogPollTimer: NodeJS.Timeout | null = null;

async function pollWatchdogHealth(): Promise<void> {
  try {
    const res = await fetch(`${WATCHDOG_URL}/health`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return;
    const health = await res.json();
    const healthJson = JSON.stringify(health);
    const healthHash = simpleHash(healthJson);
    if (healthHash !== lastWatchdogHealthHash) {
      lastWatchdogHealthHash = healthHash;
      lastWatchdogHealth = health;
      broadcast('watchdog_health', health);
    } else {
      lastWatchdogHealth = health;
    }
  } catch {
    // Watchdog restart / transient localhost hiccup
  }
}

export function initWatchdogHealthWatcher(): void {
  if (watchdogPollTimer) return;
  pollWatchdogHealth();
  watchdogPollTimer = setInterval(() => {
    if (connections.size === 0) return;
    pollWatchdogHealth();
  }, WATCHDOG_POLL_INTERVAL_MS);
  console.log('[Watch] Watching watchdog health');
}

// ─── Server status watcher ───────────────────────────────────────────────────

export function initServerStatusWatcher(): void {
  const statusDir = path.dirname(SERVER_STATUS_FILE);

  if (serverStatusWatcher) {
    try { serverStatusWatcher.close(); } catch {}
    serverStatusWatcher = null;
  }

  try {
    const stat = safeStat(statusDir);
    if (!stat || !stat.isDirectory()) {
      try { fs.mkdirSync(statusDir, { recursive: true }); } catch {}
    }

    serverStatusWatcher = fs.watch(statusDir, { persistent: true }, (_eventType, filename) => {
      if (filename === 'server-status.json') {
        setTimeout(broadcastServerStatus, 100);
      }
    });

    serverStatusWatcher.on('error', (err) => {
      console.error('[Watch] Server status watcher error:', err.message);
      setTimeout(initServerStatusWatcher, 5000);
    });

    serverStatusWatcher.on('close', () => {
      serverStatusWatcher = null;
    });

    console.log('[Watch] Watching server status file');
  } catch (e) {
    console.error('[Watch] Failed to watch server status:', (e as Error).message);
    setTimeout(initServerStatusWatcher, 5000);
  }
}

// ─── Polling fallback ────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 5000;
let pollTimer: NodeJS.Timeout | null = null;

export function startPollingFallback(): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (connections.size > 0) {
      computeAndBroadcast();
    }
  }, POLL_INTERVAL_MS);
}

// ─── Connection lifecycle ────────────────────────────────────────────────────

function teardownConnection(conn: ClientConnection): void {
  clearTimeout(conn.timers.absolute);
  clearInterval(conn.timers.aliveCheck);
  if (conn.timers.sessionPoll) clearInterval(conn.timers.sessionPoll);
  connections.delete(conn.id);
}

async function pollSessionStatus(conn: ClientConnection): Promise<void> {
  if (conn.ws.readyState !== WS_OPEN) return;
  if (!conn.codeSessionId) return;
  try {
    const res = await fetch(`${SHIELD_URL}/_auth/code/session/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codeSessionId: conn.codeSessionId }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return;
    const status = await res.json() as { alive?: boolean };
    safeSend(conn, 'session_status', status);
    if (status.alive === false) {
      console.log(`[WS] Client ${conn.id}: shield session not alive — closing`);
      conn.ws.close();
    }
  } catch {
    // Shield temporarily unavailable — retry next interval
  }
}

// ─── WebSocket server setup ──────────────────────────────────────────────────

export function setupWebSocket(server: import('http').Server): WsServer {
  const { WebSocketServer } = require('ws') as {
    WebSocketServer: new (opts: { server: unknown; path: string }) => WsServer;
  };
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('error', ((err: Error) => {
    console.error('[WS] Server error:', err.message);
  }) as (...args: unknown[]) => void);

  // Keepalive ping
  const PING_INTERVAL_MS = 30_000;
  setInterval(() => {
    for (const conn of connections.values()) {
      if (conn.ws.readyState === WS_OPEN) {
        try {
          conn.ws.ping();
        } catch {
          teardownConnection(conn);
        }
      }
    }
  }, PING_INTERVAL_MS);

  wss.on('connection', ((ws: WsClient, req: { headers?: Record<string, string | string[] | undefined> }) => {
    const clientId = generateClientId();

    // Extract session from upgrade cookies
    let codeSessionId: string | null = null;
    try {
      const cookieHeader = req?.headers?.cookie;
      if (typeof cookieHeader === 'string') {
        const match = cookieHeader.match(/(?:^|;\s*)__Host-code_session=([^;]+)/);
        if (match?.[1]) codeSessionId = match[1];
      }
    } catch {}

    // Absolute timeout: force re-auth after 24h
    const ABSOLUTE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
    const absoluteTimer = setTimeout(() => {
      console.log(`[WS] Client ${clientId}: absolute timeout (24h) — closing`);
      ws.close();
    }, ABSOLUTE_TIMEOUT_MS);

    // Liveness check paired with the ping interval
    const aliveCheck = setInterval(() => {
      const conn = connections.get(clientId);
      if (!conn) { clearInterval(aliveCheck); return; }
      if (!conn.isAlive) {
        teardownConnection(conn);
        ws.close();
        return;
      }
      conn.isAlive = false;
    }, PING_INTERVAL_MS);

    // Session status poll
    const SESSION_STATUS_INTERVAL_MS = 30_000;
    const sessionPoll = codeSessionId
      ? setInterval(() => {
          const conn = connections.get(clientId);
          if (conn) pollSessionStatus(conn);
        }, SESSION_STATUS_INTERVAL_MS)
      : null;

    const conn: ClientConnection = {
      ws,
      id: clientId,
      seq: 0,
      droppedMessages: 0,
      isAlive: true,
      codeSessionId,
      connectedAt: Date.now(),
      timers: { absolute: absoluteTimer, aliveCheck, sessionPoll },
    };

    connections.set(clientId, conn);
    console.log(`[WS] Client ${clientId} connected. Total: ${connections.size}`);

    // Initial handshake — client receives its ID + current seq baseline
    safeSend(conn, 'connected', { clientId });

    // Immediate state snapshots (isolated per-client — errors don't propagate).
    // Sequenced: preview snapshot first, then full compute pass, so the client
    // never sits on stale state waiting for the debounce timer.
    (async () => {
      try {
        const snapshot = await getAllPreviewHealth();
        if (conn.ws.readyState === WS_OPEN) safeSend(conn, 'preview_all_status', snapshot);
      } catch {}
      try {
        await computeAndBroadcast();
      } catch {}
      if (lastWatchdogHealth != null && conn.ws.readyState === WS_OPEN) {
        safeSend(conn, 'watchdog_health', lastWatchdogHealth);
      }
    })();

    if (codeSessionId) {
      setTimeout(() => pollSessionStatus(conn), 200);
    }

    // Pong tracks liveness
    ws.on('pong', () => {
      const c = connections.get(clientId);
      if (c) c.isAlive = true;
    });

    ws.on('close', () => {
      teardownConnection(conn);
      console.log(`[WS] Client ${clientId} disconnected. Total: ${connections.size}`);
    });

    ws.on('error', ((err: Error) => {
      console.error(`[WS] Client ${clientId} error:`, err.message);
      teardownConnection(conn);
    }) as (...args: unknown[]) => void);
  }) as (...args: unknown[]) => void);

  console.log('[WS] WebSocket server ready on /ws');
  return wss;
}
