// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Preview Service — per-preview systemd lifecycle.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import * as crypto from 'crypto';
import type { IncomingMessage } from 'http';
import { execSync } from 'child_process';
import { IS_ANDROID } from '@vps/shared/platform';
import { previewPlatform, type FrameworkDropinOpts } from './PreviewPlatform';
import { isSandboxId } from '@ellul.ai/types';
import { HOME, ROOT_DIR, getAppPath } from '../../config';
import {
  PREVIEW_PORT_MIN,
  PREVIEW_PORT_MAX,
  PREVIEW_LIMITS,
  resolvePortBindTimeoutMs,
  resolvePreviewMaxConcurrent,
} from '@vps/shared/constants';
import { PORT_REGISTRY } from '@vps/shared/ports';
import { reloadCaddy } from '@vps/shared/caddy';
import {
  readSpec,
  writeSpec,
  inferSpecFromRepo,
  type PreviewSpec,
} from '@vps/shared/preview-spec';
import { detectPackageManager, FRAMEWORK_DEV_PATHS, type PackageManagerInfo } from '@vps/shared/framework';
import {
  requestInstall as installManagerRequest,
  getInstallStatus as installManagerStatus,
  waitForInstall as installManagerWait,
  isInstallReady,
  type InstallErrorClass,
} from '../platform/InstallManager';

// Map an install failure class to a recovery hint for the UI. Each hint
function installRecoveryHint(cls: InstallErrorClass | null): string {
  switch (cls) {
    case 'oom':
      return 'Install ran out of memory. Stop another preview to free RAM, then click Restart.';
    case 'corrupted':
      return 'Install left the dependency tree in a bad state. Click Restart to wipe node_modules and retry.';
    case 'lockfile':
      return 'Lockfile or dependency pin is invalid. Fix the offending package and click Restart.';
    case 'registry':
      return 'Package registry fetch failed. Verify network access or the package version, then click Restart.';
    case 'timeout':
      return 'Install exceeded the time budget. Click Restart to retry.';
    case 'incomplete':
      return 'Install reported success but dependencies are missing. Fix the package.json entry and click Restart.';
    case 'crashed':
      return 'Install crashed before completing. Click Restart to retry.';
    default:
      return 'Click Restart to retry the install.';
  }
}
import type {
  OrphanReason,
  PreviewHealthResult,
  PreviewProbeResult,
  ProbeHealthState,
  PreviewLifecyclePhase,
} from '@vps/shared/preview-types';
// Re-export the canonical-phase set so tests and other modules already
export { CANONICAL_PREVIEW_PHASES } from '@vps/shared/preview-types';
import { CANONICAL_PREVIEW_PHASES } from '@vps/shared/preview-types';
const startUnit = (dir: string) => previewPlatform.startUnit(dir);
const stopUnit = (dir: string, opts?: { mode?: 'graceful' | 'immediate' }) => previewPlatform.stopUnit(dir, opts);
const restartUnit = (dir: string) => previewPlatform.restartUnit(dir);
const resetFailed = (dir: string) => previewPlatform.resetFailed(dir);
const isActive = (dir: string) => previewPlatform.isActive(dir);
const listActive = () => previewPlatform.listActive();
const unitStatus = (dir: string) => previewPlatform.unitStatus(dir);
const writeFrameworkDropin = (dir: string, opts: FrameworkDropinOpts) => previewPlatform.writeFrameworkDropin(dir, opts);
import { evaluateAdmission, resolveCandidateReservation } from './PreviewAdmission';
import { recordStart, recordStop } from './PreviewTracking';
import { withPreviewLock } from './PreviewMutex';
import { transition as lifecycleTransition, forget as lifecycleForget, markPhaseEmitted } from './PreviewLifecycle';
import { computeFrameworkCgroupCaps } from '@vps/shared/memory-budget';

const PREVIEW_FILE = `${HOME}/.ellul/preview-app`;
const PORT_REGISTRY_FILE = `${HOME}/.ellul/preview-ports.json`;
const COMPANIONS_FILE = `${HOME}/.ellul/preview-companions.json`;

// ---------------------------------------------------------------------------
// Broadcast Callback — registered by websocket.service.ts to avoid cycles
// ---------------------------------------------------------------------------

let _previewBroadcastFn: ((type: string, data: unknown) => void) | null = null;

export function registerPreviewBroadcast(
  fn: (type: string, data: unknown) => void,
): void {
  _previewBroadcastFn = fn;
}

// ---------------------------------------------------------------------------
// Request Ordering — only the latest switch wins
// ---------------------------------------------------------------------------

let latestRequestId = 0;

function getNextRequestId(): number {
  latestRequestId++;
  return latestRequestId;
}

function isLatestRequest(requestId: number): boolean {
  return requestId === latestRequestId;
}

// ---------------------------------------------------------------------------
// Structured Logger
// ---------------------------------------------------------------------------

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
function log(level: LogLevel, msg: string, ctx?: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, svc: 'preview', msg, ...ctx }));
}

// ---------------------------------------------------------------------------
// Self-Heal State — fire-and-forget POSTs to agent-bridge
// ---------------------------------------------------------------------------

interface HealState {
  errorHash: string;
  attempts: number;
  lastAttemptAt: number;
  resolved: boolean;
  // First poll that observed this failure window. Used to suppress the
  firstSeenAt: number;
  notified: boolean;
}
const healStates = new Map<string, HealState>();

const MAX_HEAL_ATTEMPTS = 2;
const HEAL_DEBOUNCE_MS = 60_000;
const HEAL_OBSERVE_DELAY_MS = 15_000;

// Steady-state HTTP probe budget. Dev servers (Next.js, Vite, etc.) on
// memory-constrained hosts can take 5-30s for a cold-route response even
// after the unit is healthy; the previous `curl -sI -m 1` ceiling treated
// every cold request as a hard failure and emitted a misleading
// "responding 0" error to the console. The probe yields phase=compiling on
// no-response, so a slow probe never escalates past the warming-page UX.
const PROBE_TIMEOUT_MS = 8_000;
const PROBE_CONNECT_TIMEOUT_MS = 1_500;
const PROBE_RETRY_COUNT = 2;
const PROBE_RETRY_BACKOFF_MS = 250;

interface OpenApiHealState {
  attempts: number;
  lastAttemptAt: number;
  resolved: boolean;
}
const openApiHealStates = new Map<string, OpenApiHealState>();
const MAX_OPENAPI_HEAL_ATTEMPTS = 2;
const OPENAPI_HEAL_DEBOUNCE_MS = 120_000;
const MAX_OPENAPI_HEAL_ENTRIES = 50;
const OPENAPI_HEAL_ENTRY_TTL_MS = 600_000;

const HEADLESS_RUNTIMES = new Set(['go', 'rust', 'ruby', 'php', 'python']);

function gcOpenApiHealStates(): void {
  if (openApiHealStates.size < MAX_OPENAPI_HEAL_ENTRIES) return;
  const now = Date.now();
  for (const [key, state] of openApiHealStates) {
    if (
      (state.resolved || state.attempts >= MAX_OPENAPI_HEAL_ATTEMPTS) &&
      now - state.lastAttemptAt > OPENAPI_HEAL_ENTRY_TTL_MS
    ) {
      openApiHealStates.delete(key);
    }
  }
  if (openApiHealStates.size >= MAX_OPENAPI_HEAL_ENTRIES) {
    const sorted = [...openApiHealStates.entries()].sort((a, b) => a[1].lastAttemptAt - b[1].lastAttemptAt);
    for (const [key] of sorted.slice(0, sorted.length - MAX_OPENAPI_HEAL_ENTRIES + 1)) {
      openApiHealStates.delete(key);
    }
  }
}

export function checkAndHealOpenApi(projectName: string, framework: string): void {
  const existing = openApiHealStates.get(projectName);
  if (existing) {
    if (existing.resolved) return;
    if (existing.attempts >= MAX_OPENAPI_HEAL_ATTEMPTS) return;
    if (Date.now() - existing.lastAttemptAt < OPENAPI_HEAL_DEBOUNCE_MS) return;
  }
  const body = JSON.stringify({ projectName, framework });
  const req = http.request(
    {
      hostname: '127.0.0.1',
      port: 7700,
      path: '/api/internal/openapi-missing',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 5000,
    },
    () => {},
  );
  req.on('error', (err: Error) => log('warn', 'openapi self-heal POST failed', { projectName, error: err.message }));
  req.write(body);
  req.end();

  const attempts = (existing?.attempts ?? 0) + 1;
  gcOpenApiHealStates();
  openApiHealStates.set(projectName, { attempts, lastAttemptAt: Date.now(), resolved: false });
  metrics.openapiHealAttempted++;
  if (attempts >= MAX_OPENAPI_HEAL_ATTEMPTS) metrics.openapiHealExhausted++;
  log('info', 'openapi self-heal triggered', { projectName, framework, attempt: attempts });
}

export function resolveOpenApiHeal(projectName: string): void {
  const existing = openApiHealStates.get(projectName);
  if (existing && !existing.resolved) {
    existing.resolved = true;
    metrics.openapiHealSucceeded++;
    log('info', 'openapi self-heal resolved', { projectName, attempts: existing.attempts });
  }
}

export function getOpenApiHealState(projectName: string): {
  healStatus: 'healing' | 'exhausted' | null;
  healAttempts: number;
  maxHealAttempts: number;
} {
  const state = openApiHealStates.get(projectName);
  if (!state || state.resolved) return { healStatus: null, healAttempts: 0, maxHealAttempts: MAX_OPENAPI_HEAL_ATTEMPTS };
  if (state.attempts >= MAX_OPENAPI_HEAL_ATTEMPTS) {
    return { healStatus: 'exhausted', healAttempts: state.attempts, maxHealAttempts: MAX_OPENAPI_HEAL_ATTEMPTS };
  }
  return { healStatus: 'healing', healAttempts: state.attempts, maxHealAttempts: MAX_OPENAPI_HEAL_ATTEMPTS };
}

function checkAndHeal(projectName: string, errorSummary: string, logTail: string): void {
  const errorHash = crypto.createHash('sha256').update(errorSummary).digest('hex').slice(0, 16);
  const now = Date.now();
  const existing = healStates.get(projectName);

  // New failure (no state, or different error) — record and wait. If the
  if (!existing || existing.errorHash !== errorHash) {
    healStates.set(projectName, {
      errorHash,
      attempts: 0,
      lastAttemptAt: 0,
      resolved: false,
      firstSeenAt: now,
      notified: false,
    });
    return;
  }

  if (existing.attempts >= MAX_HEAL_ATTEMPTS) return;
  if (existing.notified && now - existing.lastAttemptAt < HEAL_DEBOUNCE_MS) return;
  if (existing.notified && existing.attempts > 0) return;
  if (!existing.notified && now - existing.firstSeenAt < HEAL_OBSERVE_DELAY_MS) return;

  const body = JSON.stringify({ projectName, error: errorSummary, logTail });
  const req = http.request(
    {
      hostname: '127.0.0.1',
      port: 7700,
      path: '/api/internal/preview-error',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 5000,
    },
    () => {},
  );
  req.on('error', () => {});
  req.write(body);
  req.end();
  const attempts = existing.attempts + 1;
  metrics.healAttempted++;
  if (attempts >= MAX_HEAL_ATTEMPTS) metrics.healExhausted++;
  healStates.set(projectName, {
    errorHash,
    attempts,
    lastAttemptAt: now,
    resolved: false,
    firstSeenAt: existing.firstSeenAt,
    notified: true,
  });
  log('info', 'self-heal triggered', { projectName, errorHash, attempt: attempts });
}

// Invoked from the health path when the unit is no longer failed. Drops
function clearPendingHeal(projectName: string): void {
  const state = healStates.get(projectName);
  if (state && !state.notified) {
    healStates.delete(projectName);
    log('info', 'self-heal suppressed — unit recovered within observation window', {
      projectName,
      observedMs: Date.now() - state.firstSeenAt,
    });
  }
}

// ---------------------------------------------------------------------------
// Metrics — lightweight counters surfaced at GET /api/preview/metrics
// ---------------------------------------------------------------------------

const metrics = {
  // crash-loop healing (systemd unit → restart)
  healAttempted: 0,
  healSucceeded: 0,
  healExhausted: 0,
  // OpenAPI spec regeneration
  openapiHealAttempted: 0,
  openapiHealSucceeded: 0,
  openapiHealExhausted: 0,
  // Port registry GC
  gcPortsReclaimed: 0,
  // Load shedding
  backpressureRejections: 0,
  registryRebuilds: 0,
  // Spec inference / launch-time resolution
  previewSpecMissing: 0,
  previewBinaryNotFound: 0,
  // Orphan reconciliation — split-brain observability.
  orphansDetected: 0,
  orphansHealed: 0,
  orphansUnhealable: 0,
  orphanHealFailed: 0,
  // probePreview outcomes — feeds the agent's preview_verify tool.
  probeBlocked: 0,
  probeWarming: 0,
  probeOk: 0,
  // preview_verify result cache counters
  verifyCacheHits: 0,
  verifyCacheMisses: 0,
  startedAt: Date.now(),
};

// Increment the verify-cache hit/miss counters. Exported so the route
export function recordVerifyCacheOutcome(hit: boolean): void {
  if (hit) metrics.verifyCacheHits++;
  else metrics.verifyCacheMisses++;
}

export function getPreviewMetrics(): Record<string, unknown> {
  const registry = getPortRegistry();
  const usedPorts = Object.keys(registry).length;
  const totalPorts = PREVIEW_PORT_MAX - PREVIEW_PORT_MIN + 1;
  return {
    ...metrics,
    uptimeMs: Date.now() - metrics.startedAt,
    portsUsed: usedPorts,
    portsTotal: totalPorts,
    portsUtilization: Math.round((usedPorts / totalPorts) * 100),
    activeHeals: healStates.size,
    activeOpenapiHeals: openApiHealStates.size,
  };
}

// ---------------------------------------------------------------------------
// Port Registry — per-appDir preview port allocation (4000-4099)
// ---------------------------------------------------------------------------

function getPortRegistry(): Record<string, number> {
  try {
    const parsed = JSON.parse(fs.readFileSync(PORT_REGISTRY_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const valid = Object.entries(parsed).every(
        ([, v]) => typeof v === 'number' && v >= 1024 && v <= 65535,
      );
      if (valid) return parsed;
    }
    // File exists but malformed — start from empty. The next allocation
    log('warn', 'port registry corrupt, starting fresh');
    metrics.registryRebuilds++;
  } catch {
    // file missing — normal on first run
  }
  return {};
}

function readSpecSafe(appDir: string): PreviewSpec | null {
  try {
    return readSpec(getAppPath(appDir));
  } catch {
    return null;
  }
}

function savePortRegistry(registry: Record<string, number>): void {
  fs.mkdirSync(path.dirname(PORT_REGISTRY_FILE), { recursive: true });
  const tmp = PORT_REGISTRY_FILE + '.tmp';
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(registry, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, PORT_REGISTRY_FILE);
  syncPortRegistryToShield(registry);
}

function syncPortRegistryToShield(registry: Record<string, number>): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { callShieldInternal } = require('@vps/shared/shield-client');
    callShieldInternal('/api/internal/preview-ports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ registry }),
    }).catch(() => {});
  } catch {}
}

// declares a port, that port is canonical; otherwise we assign the
export function getProjectPort(projectName: string): number {
  // Never allocate a port for a bare sandbox slug — only app directories
  // (sbx-xyz/my-app) should have ports. Bare slugs reaching here is a bug
  if (isSandboxId(projectName)) {
    return 0;
  }
  const registry = getPortRegistry();
  if (registry[projectName] !== undefined) return registry[projectName]!;

  // Honor the spec's declared port when possible.
  const spec = readSpecSafe(projectName);
  const declared = spec?.port;
  const usedPorts = new Set(Object.values(registry));
  if (declared && declared >= PREVIEW_PORT_MIN && declared <= PREVIEW_PORT_MAX && !usedPorts.has(declared)) {
    registry[projectName] = declared;
    savePortRegistry(registry);
    return declared;
  }

  for (let port = PREVIEW_PORT_MIN; port <= PREVIEW_PORT_MAX; port++) {
    if (!usedPorts.has(port)) {
      registry[projectName] = port;
      savePortRegistry(registry);
      return port;
    }
  }
  throw new Error(`Preview port exhaustion: all ports ${PREVIEW_PORT_MIN}-${PREVIEW_PORT_MAX} allocated`);
}

export function releaseProjectPort(projectName: string): void {
  const registry = getPortRegistry();
  if (registry[projectName] !== undefined) {
    delete registry[projectName];
    savePortRegistry(registry);
  }
}

export function releasePortsByPrefix(prefix: string): number {
  const registry = getPortRegistry();
  const pfx = prefix.endsWith('/') ? prefix : prefix + '/';
  let count = 0;
  for (const key of Object.keys(registry)) {
    if (key === prefix || key.startsWith(pfx)) {
      delete registry[key];
      count++;
    }
  }
  if (count > 0) savePortRegistry(registry);
  return count;
}

export function portRegistryKeysForPrefix(prefix: string): string[] {
  const registry = getPortRegistry();
  const pfx = prefix.endsWith('/') ? prefix : prefix + '/';
  return Object.keys(registry).filter(k => k === prefix || k.startsWith(pfx));
}

// ---------------------------------------------------------------------------
// Companion Registry — extra previews routed at a user-configurable path prefix
// ---------------------------------------------------------------------------

export interface CompanionEntry {
  directory: string;
  port: number;
  startedAt: number;
  pathPrefix: string;
}

export function getCompanions(): CompanionEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(COMPANIONS_FILE, 'utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.every(
        (e: any) =>
          typeof e.directory === 'string' &&
          typeof e.port === 'number' &&
          typeof e.startedAt === 'number' &&
          typeof e.pathPrefix === 'string',
      )
    ) {
      return parsed;
    }
    log('warn', 'companions file corrupt or legacy format, resetting');
  } catch {
    // file missing — normal
  }
  return [];
}

function saveCompanions(entries: CompanionEntry[]): void {
  fs.mkdirSync(path.dirname(COMPANIONS_FILE), { recursive: true });
  const tmp = COMPANIONS_FILE + '.tmp';
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(entries, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, COMPANIONS_FILE);
}

function addCompanion(directory: string, port: number, pathPrefix: string): void {
  const companions = getCompanions().filter((c) => c.directory !== directory);
  companions.push({ directory, port, startedAt: Date.now(), pathPrefix });
  saveCompanions(companions);
}

function removeCompanion(directory: string): void {
  const companions = getCompanions().filter((c) => c.directory !== directory);
  saveCompanions(companions);
}

export function removeCompanionsByPrefix(prefix: string): string[] {
  const pfx = prefix.endsWith('/') ? prefix : prefix + '/';
  const all = getCompanions();
  const removed: string[] = [];
  const kept: CompanionEntry[] = [];
  for (const c of all) {
    if (c.directory === prefix || c.directory.startsWith(pfx)) {
      removed.push(c.directory);
    } else {
      kept.push(c);
    }
  }
  if (removed.length > 0) saveCompanions(kept);
  return removed;
}

// ---------------------------------------------------------------------------
// Caddy Dev Route — written atomically when active app changes
// ---------------------------------------------------------------------------

let caddyWriteMutex: Promise<void> = Promise.resolve();
let caddyWritesPending = 0;

const probeReadyCache = new Map<string, number>();
const PROBE_READY_CACHE_MS = 30_000;
function invalidateProbeCache(appDirectory: string): void {
  for (const key of probeReadyCache.keys()) {
    if (key.startsWith(appDirectory + ':')) probeReadyCache.delete(key);
  }
}

// Single HTTP GET probe against a dev server. Returns:
//   { httpStatus: number }       — server returned a status code (any value)
//   { httpStatus: 0, reason }    — connect/timeout/socket error; never returned
//                                  to callers as an "error" — only as compiling.
// Uses native http (no curl subprocess) so probes don't block the event loop.
// GET (not HEAD) because Next.js/Vite cold paths can be 10-30x slower on HEAD,
// and some user middleware refuses HEAD entirely. Body is consumed and discarded.
async function probeDevServerOnce(port: number): Promise<{ httpStatus: number; reason?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (httpStatus: number, reason?: string) => {
      if (settled) return;
      settled = true;
      resolve({ httpStatus, reason });
    };
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/',
        method: 'GET',
        // Disable the global keep-alive agent. Each probe gets its own
        // fresh socket which is closed when the response ends — no
        // accumulating 'timeout' / 'socket' listeners on a reused socket
        // (the prior code triggered MaxListenersExceededWarning after a
        // few hundred ticks).
        agent: false,
        timeout: PROBE_TIMEOUT_MS,
        headers: { Accept: 'text/html', Connection: 'close' },
      },
      (res: IncomingMessage) => {
        const status = res.statusCode || 0;
        res.resume();
        res.on('end', () => finish(status));
        res.on('error', () => finish(status));
      },
    );
    req.on('socket', (sock) => {
      // Set the connect-phase timeout once; with agent: false this socket
      // is never reused, so the listener attaches fresh per probe.
      sock.setTimeout(PROBE_CONNECT_TIMEOUT_MS);
      sock.once('timeout', () => {
        if (!settled) {
          req.destroy();
          finish(0, 'connect_timeout');
        }
      });
    });
    req.on('error', (err) => finish(0, (err as NodeJS.ErrnoException).code || 'error'));
    req.on('timeout', () => {
      req.destroy();
      finish(0, 'request_timeout');
    });
    req.end();
  });
}

// Probe with retry. Returns the highest httpStatus observed; if every attempt
// times out / errors, returns 0. The caller decides what 0 means (compiling).
async function probeDevServer(port: number): Promise<{ httpStatus: number; reason?: string }> {
  let last: { httpStatus: number; reason?: string } = { httpStatus: 0 };
  for (let attempt = 0; attempt <= PROBE_RETRY_COUNT; attempt++) {
    last = await probeDevServerOnce(port);
    if (last.httpStatus > 0) return last;
    if (attempt < PROBE_RETRY_COUNT) {
      await new Promise((r) => setTimeout(r, PROBE_RETRY_BACKOFF_MS));
    }
  }
  return last;
}

let baseCaddyfileHealAttempted = false;
function ensureBaseCaddyfile(): void {
  try {
    fs.accessSync('/etc/caddy/Caddyfile', fs.constants.R_OK);
    return;
  } catch {}
  if (baseCaddyfileHealAttempted) return;
  baseCaddyfileHealAttempted = true;
  if (IS_ANDROID) return;
  log('warn', 'base Caddyfile missing — attempting self-heal via ellul-update-identity');
  try {
    const serverId = fs.readFileSync('/etc/ellul-bootstrap/server-id', 'utf8').trim();
    const domain = fs.readFileSync('/etc/ellul/domain', 'utf8').trim();
    if (!serverId || !domain) return;
    execSync(
      `sudo -n /usr/local/bin/ellul-update-identity --server-id=${serverId} --domain=${domain}`,
      { timeout: 30_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    log('info', 'base Caddyfile self-heal succeeded');
  } catch (e) {
    log('error', 'base Caddyfile self-heal failed', {
      error: (e as Error).message.slice(0, 300),
    });
  }
}

function writeCaddyDevRoute(port: number): Promise<void> {
  const companions = getCompanions();
  caddyWritesPending++;
  const done = caddyWriteMutex
    .then(() => writeCaddyDevRouteImpl(port, companions))
    .catch(() => {})
    .finally(() => {
      caddyWritesPending--;
    });
  caddyWriteMutex = done;
  return done;
}

// string whenever writeCaddyDevRouteImpl's output shape changes in a way
const DEV_CADDY_TEMPLATE_VERSION = 'v3-warming-page';

// "Preview warming up" page. Served by Caddy's handle_errors when
const WARMING_HTML = '<!doctype html><html lang=en><head><meta charset=utf-8><title>Starting your preview…</title><meta http-equiv=refresh content=2><style>html,body{height:100%;margin:0;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#666;background:#fafafa}.box{text-align:center}.spin{display:inline-block;width:24px;height:24px;border:3px solid #ddd;border-top-color:#666;border-radius:50%;animation:s 0.7s linear infinite}@keyframes s{to{transform:rotate(360deg)}}</style></head><body><div class=box><div class=spin></div><p>Starting your preview…<br><small>First compile can take up to 90s. This page refreshes automatically.</small></p></div></body></html>';

// Caddy reverse_proxy + handle_errors block. Keeps the upstream
function caddyProxyWithWarmup(port: number, indent = '    '): string {
  // `expression` matcher catches every upstream-unreachable status
  return `reverse_proxy 127.0.0.1:${port} {
${indent}    header_up X-Real-IP {remote_host}
${indent}    flush_interval -1
${indent}    # Mark upstream unhealthy on connect failure so handle_errors
${indent}    # fires the warming page instead of a raw 502 / timeout.
${indent}    fail_duration 10s
${indent}    max_fails 2
${indent}}
${indent}handle_errors {
${indent}    @warming expression \`{err.status_code} >= 502 || {err.status_code} == 500\`
${indent}    respond @warming 200 {
${indent}        body \`${WARMING_HTML}\`
${indent}        close
${indent}    }
${indent}}`;
}

export function ensureCaddyRoute(port: number): Promise<void> {
  try {
    const existing = fs.readFileSync('/etc/caddy/app-routes.d/dev.caddy', 'utf8');
    const portMatches = existing.includes(`reverse_proxy 127.0.0.1:${port}`);
    const versionMatches = existing.includes(`# template: ${DEV_CADDY_TEMPLATE_VERSION}`);
    if (portMatches && versionMatches) return Promise.resolve();
  } catch {}
  // Return the queued write so callers that must observe the route landing
  return writeCaddyDevRoute(port);
}

async function writeCaddyDevRouteImpl(port: number, companions: CompanionEntry[] = []): Promise<void> {
  let devDomain = '';
  try {
    devDomain = fs.readFileSync('/etc/ellul/dev-domain', 'utf8').trim();
  } catch {}
  if (!devDomain) return;

  const forwardAuthBlock = `forward_auth 127.0.0.1:${PORT_REGISTRY.SOVEREIGN_SHIELD.port} {
            uri /api/auth/session
            header_up Cookie {http.request.header.Cookie}
            header_up Accept {http.request.header.Accept}
            header_up X-PoP-Signature {http.request.header.X-PoP-Signature}
            header_up X-PoP-Timestamp {http.request.header.X-PoP-Timestamp}
            header_up X-PoP-Nonce {http.request.header.X-PoP-Nonce}
            header_up User-Agent {http.request.header.User-Agent}
            header_up Sec-Ch-Ua {http.request.header.Sec-Ch-Ua}
            header_up Sec-Ch-Ua-Mobile {http.request.header.Sec-Ch-Ua-Mobile}
            header_up Sec-Ch-Ua-Platform {http.request.header.Sec-Ch-Ua-Platform}
            header_up Sec-Fetch-Dest {http.request.header.Sec-Fetch-Dest}
            header_up Sec-Fetch-Mode {http.request.header.Sec-Fetch-Mode}
            header_up X-Forwarded-Uri {uri}
            header_up X-Forwarded-Host {host}
            header_up -X-Auth-User
            header_up -X-Auth-Tier
            header_up -X-Auth-Session
            copy_headers X-Auth-User X-Auth-Tier X-Auth-Session X-Auth-Timestamp X-Auth-HMAC
        }`;

  // Framework dev-resource path matcher — only these paths get their Origin
  const frameworkPathsClause = FRAMEWORK_DEV_PATHS.join(' ');

  const companionBlocks = companions
    .map((c) => `
    # Companion: ${c.directory} at ${c.pathPrefix} → port ${c.port}
    handle_path ${c.pathPrefix}/* {
        ${forwardAuthBlock}
        uri query -_shield_session
        uri query -_preview_token
        reverse_proxy 127.0.0.1:${c.port} {
            header_up X-Forwarded-Prefix ${c.pathPrefix}
            header_up X-Real-IP {remote_host}
            flush_interval -1
            fail_duration 10s
            max_fails 2
        }
    }
`)
    .join('');

  // frame-ancestors: 'self' + platform console + optional customer custom domain.
  const frameAncestors: string[] = ["'self'"];
  try {
    const consoleOrigin = fs.readFileSync('/etc/ellul/console-origin', 'utf8').trim();
    if (consoleOrigin) frameAncestors.push(consoleOrigin);
  } catch {
    // console-origin file missing — no fallback, frame-ancestors stays 'self' only
  }
  try {
    const customDomain = fs.readFileSync('/etc/ellul/custom-domain', 'utf8').trim();
    if (customDomain) frameAncestors.push(`https://${customDomain}`);
  } catch {
    // No custom domain — normal case for default VPSes.
  }
  const cspFrameAncestors = `frame-ancestors ${frameAncestors.join(' ')}`;

  const isSingleHost = devDomain === "localhost";
  const devMatcher = isSingleHost
    ? `@dev {\n    host ${devDomain}\n    not path /browser /browser/* /api/*\n}`
    : `@dev host ${devDomain}`;
  const config = `# template: ${DEV_CADDY_TEMPLATE_VERSION}
${devMatcher}
handle @dev {
    @notAuth not path /_auth/*
    header @notAuth Content-Security-Policy "${cspFrameAncestors}"
${companionBlocks}
    # Primary preview
    route {
        ${forwardAuthBlock}
        uri query -_shield_session
        uri query -_preview_token
        @framework path ${frameworkPathsClause}
        # Next.js/Vite/etc. allowedDevOrigins accepts "localhost" but REJECTS
        # "127.0.0.1" — rewrite to the hostname the framework trusts.
        request_header @framework Origin "http://localhost:${port}"
        reverse_proxy 127.0.0.1:${port} {
            header_up X-Real-IP {remote_host}
            flush_interval -1
            # On upstream connect failure (dev server still compiling,
            # restart in progress, port temporarily unbound), treat as
            # unhealthy and let handle_errors serve our warming page
            # instead of a raw Bad Gateway. 2026-04-19 post-mortem.
            fail_duration 10s
            max_fails 2
        }
    }
}
# handle_errors is a site-level directive — Caddy rejects it inside
# handle/route/handle_path ("not an ordered HTTP handler"), and its first
# positional argument is a status-code list, not a matcher. Scope via the
# @warming expression (host + status) so other matchers in *.ellul.app fall
# through to Caddy's default error handling. Fires only during the compile
# window (502/503/504 from an unhealthy upstream) or an early crash (500);
# once the dev server binds the port, traffic skips this entirely.
handle_errors {
    @warming expression \`{http.request.host} == "${devDomain}" && ({err.status_code} >= 502 || {err.status_code} == 500)\`
    respond @warming 200 {
        body \`${WARMING_HTML}\`
        close
    }
}
`;
  const caddyDir = '/etc/caddy/app-routes.d';
  const caddyPath = `${caddyDir}/dev.caddy`;
  const caddyTmp = `${caddyPath}.tmp.${process.pid}`;
  let oldConfig = '';
  try {
    oldConfig = fs.readFileSync(caddyPath, 'utf8');
  } catch {}
  try {
    fs.mkdirSync(caddyDir, { recursive: true });
    const fd = fs.openSync(caddyTmp, 'w', 0o644);
    try {
      fs.writeSync(fd, config);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(caddyTmp, caddyPath);
    ensureBaseCaddyfile();
    try {
      await reloadCaddy();
    } catch (reloadErr) {
      log('error', 'caddy reload failed, rolling back', {
        error: (reloadErr as Error).message.slice(0, 500),
      });
      if (oldConfig) {
        fs.writeFileSync(caddyPath, oldConfig);
      } else {
        try {
          fs.unlinkSync(caddyPath);
        } catch {}
      }
      try {
        await reloadCaddy();
      } catch {}
      return;
    }
  } catch (e) {
    log('error', 'caddy dev route write/reload failed', {
      error: (e as Error).message.slice(0, 300),
    });
    try {
      fs.unlinkSync(caddyTmp);
    } catch {}
    if (oldConfig && fs.existsSync(caddyPath)) {
      try {
        fs.writeFileSync(caddyPath, oldConfig);
      } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// Utilities — app path, port probing, journal tail
// ---------------------------------------------------------------------------

function unitUptimeUs(activeEnterMonotonicUs: number): number {
  if (activeEnterMonotonicUs <= 0) return 0;
  try {
    const raw = fs.readFileSync('/proc/uptime', 'utf8');
    const secs = parseFloat(raw.split(' ')[0]!);
    return secs * 1_000_000 - activeEnterMonotonicUs;
  } catch {
    return 0;
  }
}

function getPidOnPort(port: number): number | null {
  return previewPlatform.getPidOnPort(port);
}

// Detect when a preview unit's process listens on a port OTHER than the
// allocated one (e.g. app hardcodes `port: 3000` ignoring PORT env).
// Scans all TCP listeners and matches PIDs that belong to the unit's
// process tree (MainPID's descendants).
function detectMismatchedPort(appDirectory: string, expectedPort: number): number | null {
  return previewPlatform.detectMismatchedPort(appDirectory, expectedPort);
}

// When a port mismatch is detected, rewrite the spec + registry + Caddy
// route to use the actual port. Returns the corrected port or null.
function autoCorrectPort(appDirectory: string, expectedPort: number, actualPort: number): number {
  log('warn', 'port mismatch: app ignores PORT env, auto-correcting', {
    appDirectory, expected: expectedPort, actual: actualPort,
  });

  // Update the port registry to the actual port.
  const registry = getPortRegistry();
  registry[appDirectory] = actualPort;
  savePortRegistry(registry);

  // Update the spec so future starts allocate the right port.
  const appPath = getAppPath(appDirectory);
  const spec = readSpecSafe(appDirectory);
  if (spec) {
    try {
      writeSpec(appPath, { ...spec, port: actualPort });
    } catch {}
  }

  // Rewrite Caddy route with the corrected port.
  ensureCaddyRoute(actualPort);

  return actualPort;
}

// ---------------------------------------------------------------------------
// the server outside the orchestrator, or a previous boot left a leaked PID.
// ---------------------------------------------------------------------------

// Every addition must be token-anchored. No unanchored `\bword\b` patterns —
const TS = String.raw`(?:^|[\s/])`; // token start
const TE = String.raw`(?:$|[\s/.])`; // token end
const DEV_SERVER_CMDLINE_PATTERNS: readonly RegExp[] = [
  // don't match (e.g. my-next-app-helper rejected; next-server accepted).
  new RegExp(`${TS}next-server${TE}`),
  new RegExp(`${TS}next${TE}.*\\b(dev|start)\\b`),
  new RegExp(`${TS}vite${TE}`),
  new RegExp(`${TS}nuxt${TE}`),
  new RegExp(`${TS}astro${TE}`),
  new RegExp(`${TS}remix${TE}`),
  new RegExp(`${TS}svelte-kit${TE}`),
  new RegExp(`${TS}webpack-dev-server${TE}`),
  new RegExp(`${TS}parcel${TE}`),
  // Package-manager wrappers that launch dev servers.
  /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:exec|run|start|dev)\b/,
  // node /path/to/dev.js or start.js — common fallback entrypoint.
  /(?:^|\s)node\s+\S*\/(?:dev|start)(?:\.[cm]?js)?(?:\s|$)/,
  // Python dev servers.
  /(?:^|\s)python\S*\s+.*\bmanage\.py\s+runserver\b/,
  /(?:^|\s)flask\s+run\b/,
  new RegExp(`${TS}uvicorn${TE}`),
  // Rails / Sinatra.
  /(?:^|\s)(?:ruby\s+\S*\/)?bin\/rails\s+(?:s|server)\b/,
  new RegExp(`${TS}puma${TE}`),
];

// Read `/proc/<pid>/{status,cmdline}` without throwing. Returns null if pid gone.
function readProcInfo(pid: number): { uid: number; cmdline: string } | null {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const uidMatch = status.match(/^Uid:\s+(\d+)/m);
    if (!uidMatch) return null;
    const uid = parseInt(uidMatch[1]!, 10);
    let cmdline = '';
    try {
      // cmdline is NUL-separated; join with spaces for pattern matching.
      const raw = fs.readFileSync(`/proc/${pid}/cmdline`);
      cmdline = raw.toString('utf8').replace(/\0/g, ' ').trim();
    } catch {
      // cmdline may be unreadable briefly; fall through
    }
    return { uid, cmdline };
  } catch {
    return null;
  }
}

// UID of the service user file-api runs as — loaded once on boot.
let _svcUidCache: number | null = null;
function getSvcUid(): number {
  if (_svcUidCache !== null) return _svcUidCache;
  try {
    _svcUidCache = process.getuid ? process.getuid() : -1;
  } catch {
    _svcUidCache = -1;
  }
  return _svcUidCache;
}

export interface OrphanReport {
  // True when port is held by a process but the systemd unit is NOT active.
  isOrphan: boolean;
  pid: number | null;
  port: number;
  unitActive: boolean;
  // Populated when isOrphan — why we would/wouldn't heal this orphan.
  reason: OrphanReason;
  cmdline: string | null;
}

// Pure classification step — given all observable inputs, return the orphan
export function classifyOrphan(inputs: {
  port: number;
  pid: number | null;
  activeState: 'active' | 'activating' | 'inactive' | 'failed' | 'unknown' | string;
  proc: { uid: number; cmdline: string } | null;
  svcUid: number;
  portRangeMin: number;
  portRangeMax: number;
}): OrphanReport {
  const { port, pid, activeState, proc, svcUid, portRangeMin, portRangeMax } = inputs;
  const unitActive = activeState === 'active' || activeState === 'activating';

  if (pid === null) {
    return { isOrphan: false, pid: null, port, unitActive, reason: 'no_listener', cmdline: null };
  }
  if (unitActive) {
    return {
      isOrphan: false,
      pid,
      port,
      unitActive: true,
      reason: activeState === 'activating' ? 'unit_activating' : 'unit_active',
      cmdline: null,
    };
  }
  if (port < portRangeMin || port > portRangeMax) {
    return { isOrphan: true, pid, port, unitActive: false, reason: 'port_out_of_range', cmdline: null };
  }
  if (!proc) {
    // Listener disappeared between checks — treat as no-op.
    return { isOrphan: false, pid: null, port, unitActive: false, reason: 'no_listener', cmdline: null };
  }
  if (svcUid >= 0 && proc.uid !== svcUid) {
    return { isOrphan: true, pid, port, unitActive: false, reason: 'foreign_user', cmdline: proc.cmdline };
  }
  const cmdlineOk = DEV_SERVER_CMDLINE_PATTERNS.some((re) => re.test(proc.cmdline));
  if (!cmdlineOk) {
    return { isOrphan: true, pid, port, unitActive: false, reason: 'unknown_cmdline', cmdline: proc.cmdline };
  }
  return { isOrphan: true, pid, port, unitActive: false, reason: 'orphan_healable', cmdline: proc.cmdline };
}

// every heal traces back to a concrete classification.
export async function detectOrphan(appDirectory: string): Promise<OrphanReport> {
  const port = getProjectPort(appDirectory);
  const pid = getPidOnPort(port);
  const status = await unitStatus(appDirectory);
  return classifyOrphan({
    port,
    pid,
    activeState: status.ActiveState,
    proc: pid !== null ? readProcInfo(pid) : null,
    svcUid: getSvcUid(),
    portRangeMin: PREVIEW_PORT_MIN,
    portRangeMax: PREVIEW_PORT_MAX,
  });
}

export interface OrphanHealResult {
  // True iff an orphan was present AND we killed it cleanly (SIGTERM or SIGKILL).
  healed: boolean;
  // Why we DIDN'T heal (when healed=false) — same taxonomy as OrphanReason.
  reason: OrphanReason;
  pid: number | null;
  port: number;
  // 'term' | 'kill' | null — which signal actually terminated the process.
  signalUsed: 'term' | 'kill' | null;
  durationMs: number;
}

// Heal an orphan: send SIGTERM, wait up to 2s for graceful exit, escalate to
export async function healOrphan(appDirectory: string): Promise<OrphanHealResult> {
  const start = Date.now();
  const report = await detectOrphan(appDirectory);
  if (report.isOrphan) metrics.orphansDetected++;
  if (!report.isOrphan || report.reason !== 'orphan_healable' || report.pid === null) {
    if (report.isOrphan) metrics.orphansUnhealable++;
    return {
      healed: false,
      reason: report.reason,
      pid: report.pid,
      port: report.port,
      signalUsed: null,
      durationMs: Date.now() - start,
    };
  }

  log('warn', 'orphan detected on preview port, healing', {
    appDirectory,
    port: report.port,
    pid: report.pid,
    cmdline: report.cmdline?.slice(0, 200),
  });

  const signalAndWait = async (sig: 'SIGTERM' | 'SIGKILL'): Promise<boolean> => {
    try {
      process.kill(report.pid!, sig);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // ESRCH = process already gone. That's the post-heal steady state.
      if (code === 'ESRCH') return true;
      log('error', 'orphan heal: kill failed', {
        pid: report.pid, sig, error: (err as Error).message,
      });
      return false;
    }
    // Poll /proc/<pid> every 100ms up to 2s.
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if (!fs.existsSync(`/proc/${report.pid}`)) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return !fs.existsSync(`/proc/${report.pid}`);
  };

  if (await signalAndWait('SIGTERM')) {
    metrics.orphansHealed++;
    return {
      healed: true,
      reason: 'orphan_healable',
      pid: report.pid,
      port: report.port,
      signalUsed: 'term',
      durationMs: Date.now() - start,
    };
  }
  // Escalate. SIGKILL is non-ignorable.
  if (await signalAndWait('SIGKILL')) {
    metrics.orphansHealed++;
    return {
      healed: true,
      reason: 'orphan_healable',
      pid: report.pid,
      port: report.port,
      signalUsed: 'kill',
      durationMs: Date.now() - start,
    };
  }
  // Neither signal cleared it — zombie or D-state. Surface to the operator.
  metrics.orphanHealFailed++;
  return {
    healed: false,
    reason: 'orphan_healable',
    pid: report.pid,
    port: report.port,
    signalUsed: null,
    durationMs: Date.now() - start,
  };
}

// Exported for tests — the pure part of orphan classification.
export const __orphanTestingInternals = {
  DEV_SERVER_CMDLINE_PATTERNS,
};

// Read the tail of the systemd journal for a preview unit. Requires
async function readJournalTail(appDirectory: string, lines = 40): Promise<string> {
  return previewPlatform.readJournalTail(appDirectory, lines);
}

function extractErrorSummary(logs: string): string | null {
  if (!logs) return null;
  const patterns = [
    /SyntaxError:\s*(.+)/,
    /Module not found:\s*(.+)/,
    /Cannot find module\s*['"]([^'"]+)['"]/,
    /Error:\s*listen EADDRINUSE/,
    /TypeError:\s*(.+)/,
    /ReferenceError:\s*(.+)/,
    /ModuleNotFoundError:\s*(.+)/,
    /ImportError:\s*(.+)/,
    /error\[E\d+\]:\s*(.+)/,
    /cannot find package\s*(.+)/,
    /(?:FATAL|FAIL):\s*(.+)/,
    /Error:\s*(.+)/,
  ];
  for (const line of logs.split('\n').reverse()) {
    const t = line.trim();
    if (!t) continue;
    for (const p of patterns) {
      const m = t.match(p);
      if (m) return m[0].slice(0, 200);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// OpenAPI Probe — framework-agnostic docs discovery
// ---------------------------------------------------------------------------

export interface OpenApiInfo {
  docsPath: string | null;
  specPath: string | null;
}

const OPENAPI_DOC_PATHS = [
  '/docs', '/documentation', '/swagger', '/swagger-ui', '/swagger-ui/', '/swagger/index.html',
  '/api-docs', '/api/docs', '/reference', '/redoc', '/apidocs',
  '/api/schema/swagger-ui/', '/api/schema/redoc/', '/ui/',
];
const OPENAPI_SPEC_PATHS = [
  '/openapi.json', '/documentation/json', '/documentation/yaml',
  '/openapi/v1.json', '/swagger.json', '/api-docs.json', '/v3/api-docs',
  '/api/schema/', '/swagger.yaml', '/openapi.yaml', '/apispec_1.json',
  '/swagger/doc.json', '/api-docs/v1/swagger.json',
];
const openApiCache = new Map<number, { result: OpenApiInfo; expiresAt: number }>();
const OPENAPI_CACHE_TTL_MS = 60_000;

async function probeOpenApiDocs(port: number, explicitPath?: string): Promise<OpenApiInfo> {
  const cached = openApiCache.get(port);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  const probeOnce = async (
    probePath: string,
  ): Promise<{ status: number; contentType: string; bodySnippet: string } | null> => {
    return new Promise((resolve) => {
      const req = http.request(
        { hostname: '127.0.0.1', port, path: probePath, method: 'GET', timeout: 1500 },
        (res: IncomingMessage) => {
          const status = res.statusCode || 0;
          const contentType = (res.headers['content-type'] as string) || '';
          let body = '';
          let bytes = 0;
          res.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (body.length < 4096) body += chunk.toString('utf8', 0, Math.min(chunk.length, 4096 - body.length));
            if (bytes > 16384) res.destroy();
          });
          res.on('end', () => resolve({ status, contentType, bodySnippet: body }));
          res.on('error', () => resolve(null));
        },
      );
      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      req.end();
    });
  };

  let docsPath: string | null = null;
  let specPath: string | null = null;

  const docsCandidates = explicitPath ? [explicitPath, ...OPENAPI_DOC_PATHS] : OPENAPI_DOC_PATHS;
  for (const candidate of docsCandidates) {
    const r = await probeOnce(candidate);
    if (!r || r.status !== 200) continue;
    if (!r.contentType.toLowerCase().includes('html')) continue;
    const lower = r.bodySnippet.toLowerCase();
    if (lower.includes('swagger') || lower.includes('openapi') || lower.includes('scalar') || lower.includes('redoc') || lower.includes('rapidoc')) {
      docsPath = candidate;
      break;
    }
  }

  for (const candidate of OPENAPI_SPEC_PATHS) {
    const r = await probeOnce(candidate);
    if (!r || r.status !== 200) continue;
    try {
      const parsed = JSON.parse(r.bodySnippet);
      if (parsed && (parsed.openapi || parsed.swagger)) {
        specPath = candidate;
        break;
      }
    } catch {
      const snippet = r.bodySnippet.slice(0, 512);
      if (snippet.includes('openapi:') || snippet.includes('swagger:') || snippet.includes('"openapi"')) {
        specPath = candidate;
        break;
      }
    }
  }

  const result: OpenApiInfo = { docsPath, specPath };
  openApiCache.set(port, { result, expiresAt: Date.now() + OPENAPI_CACHE_TTL_MS });
  return result;
}

export function invalidateOpenApiCache(port: number): void {
  openApiCache.delete(port);
}

export async function getOpenApiInfo(port: number): Promise<OpenApiInfo> {
  return probeOpenApiDocs(port);
}

// ---------------------------------------------------------------------------
// probePreview — two-phase liveness + correctness
// ---------------------------------------------------------------------------

// Probe state + result types live in @vps/shared/preview-types so both this
export type { ProbeHealthState as PreviewHealthState, PreviewProbeResult } from '@vps/shared/preview-types';

const PROBE_LIVENESS_BUDGET_MS = 60_000;
const PROBE_LIVENESS_BACKOFF_MS = 500;
const PROBE_SINGLE_REQUEST_TIMEOUT_MS = 3_000;

// resources because the platform Caddy rewrite hasn't reached it (shouldn't
const BLOCKED_RESPONSE_SIGNATURES = [
  'Blocked cross-origin request',       // Next.js
  'Blocked request. This host',         // Vite (>=5)
  'not allowed. Add this host to',      // Vite (alt phrasing)
  '<title>Blocked request',             // Vite error-page title
] as const;

// TCP-level liveness: can we connect to the dev server at all? Tolerant of
async function probeLiveness(
  port: number,
  budgetMs: number,
): Promise<{ alive: boolean; httpStatus: number | null }> {
  const deadline = Date.now() + budgetMs;
  let lastStatus: number | null = null;
  while (Date.now() < deadline) {
    const status = await new Promise<number | null>((resolve) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/',
          method: 'HEAD',
          timeout: PROBE_SINGLE_REQUEST_TIMEOUT_MS,
        },
        (res: IncomingMessage) => {
          res.resume();
          resolve(res.statusCode || 0);
        },
      );
      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      req.end();
    });
    if (status !== null) {
      lastStatus = status;
      // Any HTTP response means the server is alive. 5xx during cold compile
      return { alive: true, httpStatus: status };
    }
    await new Promise((r) => setTimeout(r, PROBE_LIVENESS_BACKOFF_MS));
  }
  return { alive: false, httpStatus: lastStatus };
}

// If the Caddy rewrite is in effect, the framework never sees this Origin
async function probeCorrectness(
  port: number,
  devDomain: string,
): Promise<{ status: number | null; body: string; blocked: boolean }> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        // Use a framework-reserved path: Next emits 404 for random paths but
        path: '/',
        method: 'GET',
        timeout: PROBE_SINGLE_REQUEST_TIMEOUT_MS,
        headers: {
          // Same Host Caddy would forward (so Next's HMR URL construction
          host: devDomain,
          origin: `https://${devDomain}`,
          accept: 'text/html',
        },
      },
      (res: IncomingMessage) => {
        const status = res.statusCode || 0;
        let body = '';
        let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (body.length < 8192) {
            body += chunk.toString('utf8', 0, Math.min(chunk.length, 8192 - body.length));
          }
          if (bytes > 32768) res.destroy();
        });
        res.on('end', () => {
          const blocked = BLOCKED_RESPONSE_SIGNATURES.some((sig) => body.includes(sig));
          resolve({ status, body, blocked });
        });
        res.on('error', () => resolve({ status, body, blocked: false }));
      },
    );
    req.on('error', () => resolve({ status: null, body: '', blocked: false }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: null, body: '', blocked: false });
    });
    req.end();
  });
}

// Two phases so we never flap on cold compile:
export async function probePreview(projectName: string): Promise<PreviewProbeResult> {
  const start = Date.now();
  const port = getProjectPort(projectName);
  let devDomain: string | null = null;
  try {
    devDomain = fs.readFileSync('/etc/ellul/dev-domain', 'utf8').trim() || null;
  } catch {
    // Probe without a dev-domain becomes liveness-only — still useful, just
  }
  const warnings: string[] = [];

  // Split-brain check FIRST — an orphan can respond 200 to liveness
  const orphanCheck = await detectOrphan(projectName);
  if (orphanCheck.isOrphan) {
    return {
      healthState: 'orphan',
      httpStatus: null,
      contentHash: null,
      warnings: [
        `Port ${port} held by pid ${orphanCheck.pid} but systemd unit is not active (${orphanCheck.reason}) — platform state is split-brained; restart_preview will heal it.`,
      ],
      devDomain,
      port,
      durationMs: Date.now() - start,
    };
  }

  const live = await probeLiveness(port, PROBE_LIVENESS_BUDGET_MS);
  if (!live.alive) {
    metrics.probeWarming++;
    return {
      healthState: 'warming',
      httpStatus: live.httpStatus,
      contentHash: null,
      warnings: ['liveness budget exhausted — server may still be compiling'],
      devDomain,
      port,
      durationMs: Date.now() - start,
    };
  }

  if (!devDomain) {
    // Liveness passed, but we can't run correctness without a dev-domain.
    return {
      healthState: 'ok',
      httpStatus: live.httpStatus,
      contentHash: null,
      warnings: ['/etc/ellul/dev-domain missing — correctness probe skipped'],
      devDomain: null,
      port,
      durationMs: Date.now() - start,
    };
  }

  const correctness = await probeCorrectness(port, devDomain);

  if (correctness.blocked) {
    metrics.probeBlocked++;
    warnings.push('framework cross-origin block detected — Caddy rewrite not reaching upstream');
    return {
      healthState: 'blocked',
      httpStatus: correctness.status,
      contentHash: null,
      warnings,
      devDomain,
      port,
      durationMs: Date.now() - start,
    };
  }

  if (correctness.status === null) {
    return {
      healthState: 'unreachable',
      httpStatus: null,
      contentHash: null,
      warnings: ['correctness request failed after liveness succeeded'],
      devDomain,
      port,
      durationMs: Date.now() - start,
    };
  }

  const contentHash = correctness.body
    ? crypto.createHash('sha256').update(correctness.body).digest('hex').slice(0, 16)
    : null;

  metrics.probeOk++;
  return {
    healthState: 'ok',
    httpStatus: correctness.status,
    contentHash,
    warnings,
    devDomain,
    port,
    durationMs: Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// Preview Lifecycle — startPreview, stopPreview, restartPreview
// ---------------------------------------------------------------------------

export interface PreviewStartResult {
  success: boolean;
  error?: string;
  ready?: boolean;
  port?: number;
  alreadyRunning?: boolean;
  installing?: boolean;
  installLogPath?: string;
  openApi?: OpenApiInfo;
  failReason?:
    | 'port_stuck'
    | 'no_spec'
    | 'backpressure'
    | 'concurrency_limit'
    | 'unit_start_failed'
    // The app has no detectable framework, no `package.json` dev/start
    | 'spec_missing'
    // The launcher's pre-flight `command -v` check rejected the first
    | 'binary_not_found'
    | null;
  // Set when the launcher had to fall back to npm-run-dev (spec missing).
  specMissing?: boolean;
  // Supplementary context for `spec_missing` / `binary_not_found`.
  manualConfig?: {
    suggestedStart?: string;
    suggestedPort?: number;
    packageManager?: 'npm' | 'yarn' | 'pnpm' | 'bun';
  };
  resourceContext?: {
    reason: string;
    estimatedPeakMB: number;
    estimatedSteadyMB: number;
    availableMB: number;
    totalMB: number;
    frameworkId: string | null;
    perPreviewCapMB: number;
    activePreviewCount: number;
    maxConcurrent: number;
  };
}

// Populate the `manualConfig` payload attached to `spec_missing` /
function computeManualConfigHint(
  appPath: string,
  port: number,
): { suggestedStart?: string; suggestedPort: number; packageManager?: PackageManagerInfo['pm'] } {
  const hint: { suggestedStart?: string; suggestedPort: number; packageManager?: PackageManagerInfo['pm'] } = {
    suggestedPort: port,
  };
  try {
    const existing = readSpecSafe(appPath);
    if (existing?.start) hint.suggestedStart = existing.start;
  } catch { /* not a blocker — surface the empty hint */ }
  try {
    const pmInfo = detectPackageManager(appPath, ROOT_DIR);
    hint.packageManager = pmInfo.pm;
    if (!hint.suggestedStart) hint.suggestedStart = `${pmInfo.scriptRunner} dev`;
  } catch { /* best-effort; the panel still renders with the port */ }
  return hint;
}

// already running before we got involved; we never saw it move into the
// adoption was the 2026-04-22 GET→adopt→emit→invalidate loop: each GET
async function adoptRunningPreview(
  appDirectory: string,
  port: number,
  skipCaddyRoute: boolean | undefined,
): Promise<PreviewStartResult> {
  if (!skipCaddyRoute) await ensureCaddyRoute(port);
  recordStart(appDirectory, port);
  emitPhaseTransition(appDirectory, 'ready', 'Preview running');
  invalidateOpenApiCache(port);
  broadcastAllPreviewHealth();
  return { success: true, ready: true, port, alreadyRunning: true };
}

// Start a preview:
export async function startPreview(
  appDirectory: string,
  requestId?: number,
  options?: { skipCaddyRoute?: boolean; _reinstallAttempted?: boolean },
): Promise<PreviewStartResult> {
  // directory. Per-directory mutex prevents:
  return withPreviewLock(appDirectory, PREVIEW_LIMITS.DELETE_STOP_TIMEOUT_MS * 3, () =>
    startPreviewLocked(appDirectory, requestId, options),
  );
}

async function startPreviewLocked(
  appDirectory: string,
  requestId?: number,
  options?: { skipCaddyRoute?: boolean; _reinstallAttempted?: boolean },
): Promise<PreviewStartResult> {
  // Android proot: no cgroups, no systemd units — the entire admission system
  // reads VPS-specific signals (cgroup memory, PSI, systemctl) that don't exist.
  let admission: Awaited<ReturnType<typeof evaluateAdmission>> | undefined;
  if (!IS_ANDROID) {
    admission = await evaluateAdmission(appDirectory, { log });
    if (admission.decision === 'reject') {
      metrics.backpressureRejections++;
      const backpressureReasons: Array<typeof admission.reason> = [
        'memory-critical',
        'load-critical',
        'drain-timeout',
        'budget-unavailable',
      ];
      const res = admission.candidateReservation;
      const sig = admission.signals;
      const bud = admission.budget;
      return {
        success: false,
        error: admission.message,
        failReason: backpressureReasons.includes(admission.reason)
          ? 'backpressure'
          : 'concurrency_limit',
        resourceContext: {
          reason: admission.reason,
          estimatedPeakMB: res?.devPeakMB ?? 0,
          estimatedSteadyMB: res?.steadyMB ?? 0,
          availableMB: Math.round(sig.memAvailableMB),
          totalMB: Math.round(sig.physicalMB),
          frameworkId: res?.frameworkId ?? null,
          perPreviewCapMB: bud?.perPreviewCapMB ?? 0,
          activePreviewCount: sig.activeCount,
          maxConcurrent: resolvePreviewMaxConcurrent(PREVIEW_LIMITS.MAX_CONCURRENT, sig.physicalMB),
        },
      };
    }
    if (admission.decision === 'accept-after-evict') {
      log('info', 'preview: admitted after LRU eviction', {
        appDirectory,
        evicted: admission.evictedDirectory,
        evictionMode: admission.evictionMode,
        drainElapsedMs: admission.drainElapsedMs,
        effectiveCapMB: admission.effectiveCapMB,
        admittedMode: admission.admittedMode,
        frameworkId: admission.frameworkId,
      });
    }
    if (admission.decision === 'accept' && admission.admittedMode === 'warm') {
      log('info', 'preview: admitted in warm mode (hot would exceed budget)', {
        appDirectory,
        effectiveCapMB: admission.effectiveCapMB,
        perPreviewCapMB: admission.budget.perPreviewCapMB,
        frameworkId: admission.frameworkId,
      });
    }
  }

  const appPath = getAppPath(appDirectory);
  if (!fs.existsSync(appPath)) {
    return { success: false, error: 'App path not found: ' + appPath };
  }

  if (requestId !== undefined && !isLatestRequest(requestId)) {
    return { success: false, error: 'Superseded by newer request' };
  }

  const projectPort = getProjectPort(appDirectory);

  // Ensure a spec exists. We allocate the spec's port from the registry
  let spec = readSpec(appPath);
  if (!spec) {
    spec = inferSpecFromRepo(appPath, projectPort);
    if (spec) {
      log('info', 'spec inferred and written', { appDirectory, runtime: spec.runtime, port: spec.port });
    } else {
      // No user spec, no framework match, no package.json dev/start
      metrics.previewSpecMissing++;
      log('info', 'preview: spec_missing — no framework match, no runnable scripts', { appDirectory });
      emitPhaseTransition(
        appDirectory,
        'deps_failed',
        'No preview command detected — write one manually',
      );
      return {
        success: false,
        error: 'No framework detected and no dev/start script in package.json. Provide a start command in .ellul/preview.json or via the manual-config panel.',
        failReason: 'spec_missing',
        manualConfig: computeManualConfigHint(appPath, projectPort),
      };
    }
  } else if (spec.port !== projectPort) {
    // Reconcile registry → spec drift. Only the port field needs
    const fixed = { ...spec, port: projectPort };
    try {
      writeSpec(appPath, fixed);
      spec = fixed;
    } catch (e) {
      log('warn', 'failed to reconcile spec port', { error: (e as Error).message });
    }
  }

  // Migrate legacy `python` → `python3` in existing specs (Ubuntu 24.04+
  // ships python3 only; older specs referenced bare `python`).
  if (spec && spec.runtime === 'python') {
    let migrated = false;
    let start = spec.start;
    let prodStart = spec.prodStart;
    if (start.startsWith('python ') || start.includes(' python ')) {
      start = start.replace(/\bpython\b/g, 'python3');
      migrated = true;
    }
    if (prodStart && (prodStart.startsWith('python ') || prodStart.includes(' python '))) {
      prodStart = prodStart.replace(/\bpython\b/g, 'python3');
      migrated = true;
    }
    if (migrated) {
      spec = { ...spec, start, ...(prodStart ? { prodStart } : {}) };
      try { writeSpec(appPath, spec); } catch {}
    }
  }

  // For monorepo packages, pre-write NODE_PATH via install check — the
  const pkgJsonPath = path.join(appPath, 'package.json');
  const hasPackageJson = fs.existsSync(pkgJsonPath);

  // Runtime install — non-Node frameworks (dotnet, go, rust, etc.) need
  if (spec?.runtime && spec.runtime !== 'node' && spec.runtime !== 'static') {
    const RUNTIME_BINS: Record<string, string> = {
      dotnet: 'dotnet', go: 'go', rust: 'cargo', ruby: 'ruby',
      php: 'php', elixir: 'elixir', java: 'java', bun: 'bun',
      dart: 'dart', flutter: 'flutter',
    };
    const bin = RUNTIME_BINS[spec.runtime];
    if (bin) {
      // Search the same PATH the preview instance-launcher uses (file-api's
      // own PATH doesn't include /usr/local/go/bin, ~/.cargo/bin, etc.)
      const svcHome = process.env.HOME || '/home/dev';
      const runtimeSearchPath = [
        `${svcHome}/.node/bin`,
        `${svcHome}/.cargo/bin`,
        `${svcHome}/.local/bin`,
        '/usr/local/go/bin',
        '/usr/lib/dart/bin',
        '/opt/flutter/bin',
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
      ].join(':');
      try {
        execSync(`which ${bin}`, { encoding: 'utf8', timeout: 3000, stdio: 'ignore', env: { PATH: runtimeSearchPath } });
      } catch {
        log('info', 'runtime not found, installing on demand (one-time)', {
          runtime: spec.runtime, binary: bin, appDirectory,
        });
        // Broadcast so the UI shows a toast: "Installing .NET (one-time setup)..."
        emitPhaseTransition(
          appDirectory,
          'installing_runtime',
          `Installing ${spec.runtime} runtime (one-time setup)...`,
          { runtime: spec.runtime },
        );
        try {
          if (IS_ANDROID) throw new Error('runtime install not supported on android');
          execSync(`sudo -n /usr/local/bin/ellul-install-runtime ${spec.runtime}`, {
            timeout: 300_000,
            stdio: 'ignore',
          });
          log('info', 'runtime installed', { runtime: spec.runtime });
          emitPhaseTransition(
            appDirectory,
            'runtime_installed',
            `${spec.runtime} runtime installed`,
            { runtime: spec.runtime },
          );
        } catch (e) {
          emitPhaseTransition(
            appDirectory,
            'runtime_failed',
            `${spec.runtime} installation failed`,
            { runtime: spec.runtime },
          );
          return {
            success: false,
            error: `${spec.runtime} runtime installation failed: ${(e as Error).message}. ` +
              `This is a one-time setup that requires internet access.`,
            failReason: 'runtime_install' as 'backpressure',
          };
        }
      }
    }
  }

  // so races across callers are structurally impossible.
  const installKickoff = installManagerRequest(appPath);
  if (!(installKickoff.phase === 'failed' && installKickoff.errorClass === 'no_manifest')) {
    if (installKickoff.phase === 'running' || installKickoff.phase === 'queued') {
      emitPhaseTransition(
        appDirectory,
        'installing_deps',
        `Installing ${installKickoff.packageManager ?? 'dependencies'}...`,
      );
    }
    const installFinal = await installManagerWait(appPath, 120_000, {
      intervalMs: 1_000,
    });
    if (installFinal.phase === 'failed') {
      emitPhaseTransition(
        appDirectory,
        'deps_failed',
        installFinal.error ?? 'Dependency install failed',
      );
      return {
        success: false,
        error: installFinal.error ?? 'Dependency install failed',
        installing: false,
        installLogPath: installFinal.logPath,
        failReason: 'unit_start_failed',
      };
    }
    if (installFinal.phase !== 'ready') {
      // Didn't terminate in the wait budget — still installing in the
      return {
        success: true,
        ready: false,
        installing: true,
        installLogPath: installFinal.logPath,
        failReason: null,
      };
    }
    if (installKickoff.phase === 'running' || installKickoff.phase === 'queued') {
      emitPhaseTransition(appDirectory, 'deps_installed', 'Dependencies installed');
    }
  }

  // If heal fails, surface an error — we don't mask split-brain.
  // deliberately ran their own dev server; we don't kill their work.
  if (getPidOnPort(projectPort) !== null) {
    const orphanCheck = await detectOrphan(appDirectory);
    if (!orphanCheck.isOrphan) {
      // Case 1: managed unit already listening.
      log('info', 'preview port already bound by active unit — routing Caddy', {
        appDirectory, port: projectPort,
      });
      return await adoptRunningPreview(appDirectory, projectPort, options?.skipCaddyRoute);
    }
    if (orphanCheck.reason === 'orphan_healable') {
      // Case 2: heal, then fall through to unit start.
      const heal = await healOrphan(appDirectory);
      if (!heal.healed) {
        return {
          success: false,
          error: `Orphan on port ${projectPort} (pid ${heal.pid}) did not respond to SIGTERM/SIGKILL`,
          failReason: 'unit_start_failed',
        };
      }
      log('warn', 'startPreview: healed orphan before unit start', {
        appDirectory, port: projectPort, pid: heal.pid, signal: heal.signalUsed,
      });
      // Fall through to the unit-start path below.
    } else {
      // Case 3: foreign listener — user-launched manual dev server.
      log('warn', 'preview port already bound by foreign process — adopting', {
        appDirectory, port: projectPort, pid: orphanCheck.pid, reason: orphanCheck.reason,
      });
      return await adoptRunningPreview(appDirectory, projectPort, options?.skipCaddyRoute);
    }
  }

  // Clear any prior failed state so StartLimitBurst doesn't short-circuit.
  await resetFailed(appDirectory);

  // Framework-aware cgroup drop-in. The unit template carries no resource caps —
  // this drop-in is the sole source of truth for MemoryHigh/Max, TasksMax, CPUQuota.
  // Failure aborts the start: a unit without sized caps would compete with the
  // control plane unbounded.
  const admittedMode: 'hot' | 'warm' = IS_ANDROID ? 'hot' : admission!.admittedMode;
  const budget = IS_ANDROID
    ? { physicalMB: 2048, reservedMB: 512, previewBudgetMB: 1536, perPreviewCapMB: 1536, perPreviewHighMB: 1200, maxConcurrent: 1, slicePercent: 70 }
    : admission!.budget;
  let reservation;
  try {
    reservation = resolveCandidateReservation(appDirectory);
  } catch (err) {
    log('error', 'framework reservation resolution failed', {
      appDirectory, error: (err as Error).message,
    });
    return { success: false, error: 'Failed to size preview cgroup', failReason: 'unit_start_failed' };
  }

  const baseCaps = computeFrameworkCgroupCaps(
    reservation.frameworkId,
    reservation.framework?.runtime ?? null,
    budget,
  );
  const finalCaps = admittedMode === 'warm' && reservation.prodSteadyMB !== null
    ? {
        ...baseCaps,
        memoryMaxMB: Math.min(baseCaps.memoryMaxMB, Math.round(reservation.prodSteadyMB * 1.4)),
        memoryHighMB: Math.min(baseCaps.memoryHighMB, Math.round(reservation.prodSteadyMB * 1.1)),
      }
    : baseCaps;
  const dropinResult = await writeFrameworkDropin(appDirectory, {
    memoryHighMB: finalCaps.memoryHighMB,
    memoryMaxMB: finalCaps.memoryMaxMB,
    tasksMax: finalCaps.tasksMax,
    cpuQuotaPercent: finalCaps.cpuQuotaPercent,
  });
  if (!dropinResult.ok) {
    // Fail-soft: log and continue. The aggregate previews-slice cap
    // (ManagedOOMMemoryPressure + MemoryMax on the slice) is the
    // backstop — a unit without per-instance caps still can't take
    // the host down. EROFS here means the host's file-api unit was
    // provisioned before /etc/systemd/system was added to ReadWritePaths;
    // the next rebuild-all run picks up the new bundle.ts and the dropin
    // path becomes writable again.
    log('warn', 'framework cgroup dropin write failed — falling back to slice-level caps', {
      appDirectory, error: dropinResult.error,
    });
  }

  // ── Persist the admitted mode into the spec so the launcher picks
  try {
    const currentSpec = readSpec(appPath);
    if (currentSpec && currentSpec.mode !== admittedMode) {
      writeSpec(appPath, { ...currentSpec, mode: admittedMode });
    }
  } catch (err) {
    log('warn', 'failed to persist admittedMode to spec', {
      appDirectory,
      error: (err as Error).message,
    });
  }

  // Lifecycle: cold → starting. Transition to hot/warm happens after
  try {
    lifecycleTransition({
      directory: appDirectory,
      next: 'starting',
      mode: admittedMode,
      force: true,
    });
  } catch { /* never let lifecycle bookkeeping break startup. */ }

  const result = await startUnit(appDirectory);
  if (!result.ok) {
    try {
      lifecycleTransition({ directory: appDirectory, next: 'cold', force: true });
    } catch {}
    return {
      success: false,
      error: result.error || 'Failed to start preview unit',
      failReason: 'unit_start_failed',
    };
  }

  // Unit-start accepted → advance lifecycle to the serving state.
  try {
    lifecycleTransition({
      directory: appDirectory,
      next: admittedMode === 'warm' ? 'warm' : 'hot',
      mode: admittedMode,
      force: true,
    });
  } catch {}

  if (!options?.skipCaddyRoute) ensureCaddyRoute(projectPort);

  // Register in the activity tracker so admission + reconciler can
  recordStart(appDirectory, projectPort);

  // Wait for the app to actually bind the port before reporting ready.
  const bindResult = await waitForPortBind(appDirectory, projectPort);
  if (bindResult.unitFailed) {
    // Exit-code triage. Our launcher emits three well-known codes that
    const status = bindResult.execMainStatus;
    const specMissingAtLaunch = status === '66';
    const binaryNotFound = status === '64' || status === '127';
    if (specMissingAtLaunch) {
      metrics.previewSpecMissing++;
      return {
        success: false,
        error: `Preview start failed: no .ellul/preview.json (exit ${status}). The launcher refuses to guess a dev command.`,
        failReason: 'spec_missing',
        manualConfig: computeManualConfigHint(appPath, projectPort),
      };
    }
    if (binaryNotFound) {
      metrics.previewBinaryNotFound++;
      if (!options?._reinstallAttempted) {
        log('warn', 'binary_not_found — forcing re-install before retry', { appDirectory });
        emitPhaseTransition(appDirectory, 'installing_deps', 'Dev binary not found, re-installing dependencies…');
        const reinstall = installManagerRequest(appPath, { force: true });
        if (reinstall.phase === 'running' || reinstall.phase === 'queued') {
          const result = await installManagerWait(appPath, 120_000, { intervalMs: 1_000 });
          if (result.phase === 'ready') {
            await resetFailed(appDirectory);
            return startPreview(appDirectory, requestId, { ...options, _reinstallAttempted: true });
          }
        }
      }
      return {
        success: false,
        error: `Preview start command failed: binary not on PATH (exit ${status}). Check your dev command or run install.`,
        failReason: 'binary_not_found',
        manualConfig: computeManualConfigHint(appPath, projectPort),
      };
    }
    return {
      success: false,
      error: `Preview unit entered failed state (${bindResult.unitResult ?? 'unknown'}) before binding port ${projectPort}.`,
      failReason: 'unit_start_failed',
    };
  }

  return {
    success: true,
    ready: bindResult.ready,
    port: projectPort,
    specMissing: spec === null,
    failReason: null,
  };
}

// Never throws — every failure case returns a typed result the caller
async function waitForPortBind(
  appDirectory: string,
  port: number,
): Promise<{ ready: boolean; unitFailed: boolean; correctedPort?: number; unitResult?: string; execMainStatus?: string }> {
  emitPhaseTransition(appDirectory, 'starting_server', 'Starting dev server…');
  const timeoutMs = resolvePortBindTimeoutMs();
  const pollIntervalMs = PREVIEW_LIMITS.PORT_BIND_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (getPidOnPort(port) !== null) {
      emitPhaseTransition(appDirectory, 'ready', 'Preview ready');
      return { ready: true, unitFailed: false };
    }

    // Check for port mismatch before timeout — app might have already
    // bound a hardcoded port while we're waiting on the allocated one.
    const elapsed = Date.now() - (deadline - timeoutMs);
    if (elapsed > 3000) {
      const actualPort = detectMismatchedPort(appDirectory, port);
      if (actualPort !== null) {
        const corrected = autoCorrectPort(appDirectory, port, actualPort);
        emitPhaseTransition(appDirectory, 'ready', 'Preview ready (port auto-corrected)');
        return { ready: true, unitFailed: false, correctedPort: corrected };
      }
    }

    // Short-circuit on a failed unit rather than waiting the full
    try {
      const st = await unitStatus(appDirectory);
      if (st?.ActiveState === 'failed') {
        emitPhaseTransition(
          appDirectory,
          'deps_failed',
          `Preview unit failed: ${st.Result ?? 'unknown'}`,
        );
        return {
          ready: false,
          unitFailed: true,
          unitResult: st.Result,
          execMainStatus: st.ExecMainStatus,
        };
      }
    } catch { /* unit query transient error — keep polling */ }
    await new Promise<void>(r => setTimeout(r, pollIntervalMs));
  }

  // Final mismatch check at timeout boundary.
  const actualPort = detectMismatchedPort(appDirectory, port);
  if (actualPort !== null) {
    const corrected = autoCorrectPort(appDirectory, port, actualPort);
    emitPhaseTransition(appDirectory, 'ready', 'Preview ready (port auto-corrected)');
    return { ready: true, unitFailed: false, correctedPort: corrected };
  }

  log('warn', 'preview unit started but port did not bind within timeout', {
    appDirectory, port, timeoutMs,
  });
  return { ready: false, unitFailed: false };
}

// Stop a preview (or all previews when appDirectory omitted).
export async function stopPreview(appDirectory?: string): Promise<void> {
  if (appDirectory) {
    try {
      invalidateOpenApiCache(getProjectPort(appDirectory));
    } catch {}
    invalidateProbeCache(appDirectory);
    try {
      lifecycleTransition({ directory: appDirectory, next: 'stopping', force: true });
    } catch {}
    await stopUnit(appDirectory);
    recordStop(appDirectory);
    try {
      lifecycleTransition({ directory: appDirectory, next: 'cold', force: true });
    } catch {}
    const port = getProjectPort(appDirectory);
    const strayPid = getPidOnPort(port);
    if (strayPid !== null) {
      try {
        if (IS_ANDROID) {
          process.kill(strayPid, 'SIGKILL');
        } else {
          execSync(`fuser -KILL ${port}/tcp 2>/dev/null || true`, { timeout: 3000 });
        }
      } catch {}
    }
  } else {
    const actives = await listActive();
    for (const appDir of actives) {
      try {
        lifecycleTransition({ directory: appDir, next: 'stopping', force: true });
      } catch {}
      await stopUnit(appDir);
      try {
        lifecycleTransition({ directory: appDir, next: 'cold', force: true });
      } catch {}
    }
    try {
      fs.writeFileSync(PREVIEW_FILE, '');
    } catch {}
    saveCompanions([]);
  }
  broadcastAllPreviewHealth();
}

// Restart a preview — reset-failed + restart, clearing any crash-loop lockout.
export async function restartPreview(appDirectory: string): Promise<{ ok: boolean; error?: string }> {
  const appPath = getAppPath(appDirectory);
  if (!fs.existsSync(appPath)) {
    return { ok: false, error: 'App path not found' };
  }
  try {
    invalidateOpenApiCache(getProjectPort(appDirectory));
  } catch {}
  invalidateProbeCache(appDirectory);
  // Heal any orphan holding the port before restart. If unit is inactive
  try {
    const heal = await healOrphan(appDirectory);
    if (heal.healed) {
      log('info', 'restart: healed orphan before restart', {
        appDirectory, pid: heal.pid, signal: heal.signalUsed,
      });
    }
  } catch {}
  const r = await restartUnit(appDirectory);
  // After restart, Caddy route may or may not already be correct.
  try {
    ensureCaddyRoute(getProjectPort(appDirectory));
  } catch {}
  // would otherwise persist and mislead the UI into showing "auto-fixing..."
  if (r.ok) {
    const prior = healStates.get(appDirectory);
    if (prior && !prior.resolved) {
      prior.resolved = true;
      metrics.healSucceeded++;
      log('info', 'restart: cleared prior heal state', { appDirectory, attempts: prior.attempts });
    }
    healStates.delete(appDirectory);
    // lie was measurable in the Nest post-mortem (2026-04-19).
    try {
      await waitForPortBind(appDirectory, getProjectPort(appDirectory));
    } catch { /* best-effort; Caddy retry handles the rest */ }
  }
  return r;
}

// ---------------------------------------------------------------------------
// Health — unit state + port probe + HTTP probe + openapi
// ---------------------------------------------------------------------------

// PreviewHealthResult is defined in @vps/shared/preview-types. Re-exported
export type { PreviewHealthResult };

// Get preview health for a specific app (or the active primary).
export async function getPreviewHealth(directory?: string): Promise<PreviewHealthResult> {
  let activeApp: string | null = null;
  if (fs.existsSync(PREVIEW_FILE)) {
    activeApp = fs.readFileSync(PREVIEW_FILE, 'utf8').trim() || null;
  }

  let current: string | null;
  if (directory) {
    if (activeApp === directory || (activeApp && activeApp.startsWith(directory + '/'))) {
      current = activeApp;
    } else {
      return {
        app: null,
        phase: 'idle',
        active: false,
        port: getProjectPort(directory),
      };
    }
  } else {
    current = activeApp;
  }

  if (!current) {
    return { app: null, phase: 'idle', active: false, port: PREVIEW_PORT_MIN };
  }

  const projectPort = getProjectPort(current);
  const appPath = getAppPath(current);

  // language. We render its state; we don't duplicate its logic.
  {
    const installState = installManagerStatus(appPath, { withLogTail: true });
    const nothingToInstall =
      (installState.phase === 'idle' && installState.lang === null) ||
      (installState.phase === 'failed' && installState.errorClass === 'no_manifest');
    if (!nothingToInstall) {
      if (installState.phase === 'queued' || installState.phase === 'running') {
        return { app: current, phase: 'installing', active: false, port: projectPort };
      }
      if (installState.phase === 'failed') {
        if (installState.errorClass === 'incomplete') {
          installManagerRequest(appPath);
          return { app: current, phase: 'installing', active: false, port: projectPort };
        }
        return {
          app: current,
          phase: 'crashed',
          active: false,
          port: projectPort,
          error: installState.error ?? 'Dependency install failed',
          logTail: installState.logTail,
          failReason: 'install_failed',
          recoveryHint: installRecoveryHint(installState.errorClass),
        };
      }
      // Either 'idle' with a manifest present (install never requested —
      if (installState.phase === 'idle' || !isInstallReady(appPath)) {
        installManagerRequest(appPath);
        return { app: current, phase: 'installing', active: false, port: projectPort };
      }
      // phase === 'ready' && isInstallReady → fall through to unit status.
    }
  }

  const status = await unitStatus(current);
  // when the unit isn't currently running, otherwise we false-positive
  const running = status.ActiveState === 'active' || status.ActiveState === 'activating';
  const isFailed = !running && (
    status.ActiveState === 'failed' ||
    status.SubState === 'failed' ||
    status.Result === 'start-limit-hit' ||
    status.Result === 'exit-code' ||
    status.Result === 'signal'
  );

  if (!isFailed) clearPendingHeal(current);

  if (isFailed) {
    const logTail = await readJournalTail(current, 40);
    const error = extractErrorSummary(logTail) || `preview unit failed (${status.Result})`;
    checkAndHeal(current, error, logTail);
    const heal = healStates.get(current);
    const recoveryHint =
      status.Result === 'start-limit-hit'
        ? 'Preview crashed too many times; systemd paused restart attempts. Fix the error and use restart_preview (or click Restart).'
        : 'Preview failed to start. Fix the error and use restart_preview (or click Restart).';
    return {
      app: current,
      phase: 'crashed',
      active: false,
      port: projectPort,
      error,
      logTail,
      healAttempts: heal?.attempts ?? 0,
      healStatus: heal ? (heal.attempts >= MAX_HEAL_ATTEMPTS ? 'exhausted' : 'healing') : null,
      recoveryHint,
      failReason: 'unit_failed',
    };
  }

  if (status.ActiveState === 'inactive' || status.ActiveState === 'unknown') {
    // Before declaring the preview idle, check for the split-brain case:
    const orphanCheck = await detectOrphan(current);
    if (orphanCheck.isOrphan && orphanCheck.reason === 'orphan_healable') {
      // Fire-and-forget heal — caller polls health; next call will see
      healOrphan(current)
        .then((r) => {
          if (r.healed) log('info', 'health: background heal ok', { current, pid: r.pid });
        })
        .catch(() => {});
      return {
        app: current,
        phase: 'orphan',
        active: false,
        port: projectPort,
        orphanReason: 'orphan_healable',
        recoveryHint: 'Healing orphaned process holding the preview port — try again in a few seconds, or click Restart.',
      };
    }
    if (orphanCheck.isOrphan) {
      // Foreign owner — don't kill, just surface.
      return {
        app: current,
        phase: 'orphan',
        active: false,
        port: projectPort,
        orphanReason: orphanCheck.reason,
        recoveryHint:
          orphanCheck.reason === 'foreign_user'
            ? 'Port is held by a process owned by a different user. You may have started a dev server manually — stop it or pick a different port.'
            : 'Port is held by an unrecognised process. If it is yours, stop it manually and restart the preview.',
      };
    }
    return { app: current, phase: 'idle', active: false, port: projectPort };
  }

  if (status.ActiveState === 'activating') {
    return { app: current, phase: 'starting', active: false, port: projectPort };
  }

  // ActiveState=active — check actual readiness
  let effectivePort = projectPort;
  let pid = getPidOnPort(projectPort);
  if (pid === null) {
    // Nothing on the allocated port — check if the app hardcoded a
    // different port and auto-correct the route to match.
    const actualPort = detectMismatchedPort(current, projectPort);
    if (actualPort !== null) {
      effectivePort = autoCorrectPort(current, projectPort, actualPort);
      pid = getPidOnPort(effectivePort);
    }
    if (pid === null) {
      const uptimeUs = unitUptimeUs(status.ActiveEnterTimestampMonotonic);
      if (uptimeUs > 30_000_000) {
        const logTail = await readJournalTail(current, 30);
        return {
          app: current,
          phase: 'crashed',
          active: false,
          port: effectivePort,
          error: `Process is running but not listening on port ${effectivePort}`,
          logTail,
          failReason: 'unit_failed',
          recoveryHint:
            'Your app started but never bound to the expected port. ' +
            'Make sure it reads process.env.PORT and calls listen(). ' +
            'For Hono, add: import { serve } from "@hono/node-server"; serve({ fetch: app.fetch, port: Number(process.env.PORT) || 3000 })',
        };
      }
      return { app: current, phase: 'starting', active: false, port: effectivePort };
    }
  }

  // HTTP probe — three outcomes:
  //   - 2xx/3xx/404/500     → reachable, dev server is alive and serving
  //   - 4xx (other) / 5xx   → genuine error; surface with logTail
  //   - 0 (no response)     → probe could not reach the server within the
  //                            timeout; treat as compiling regardless of unit
  //                            uptime. Cold routes on Next.js / Vite under
  //                            memory pressure can take 10-30s; "responding
  //                            0" must NEVER reach the user — Caddy's
  //                            handle_errors warming page covers UX while
  //                            we re-poll.
  //
  // Probe throttle: once a dev server is confirmed reachable, skip the
  // HTTP probe for PROBE_READY_CACHE_MS. The 3-second health poller
  // otherwise hammers GET / which triggers Next.js compilation indicator
  // and wastes CPU. The cache is keyed on app+port+pid — any change
  // (restart, port switch, crash) invalidates it instantly.
  const probeCacheKey = `${current}:${effectivePort}:${pid}`;
  const cachedProbe = probeReadyCache.get(probeCacheKey);
  const probeSkip = cachedProbe && (Date.now() - cachedProbe) < PROBE_READY_CACHE_MS;
  let httpStatus: number;
  if (probeSkip) {
    httpStatus = 200;
  } else {
    ({ httpStatus } = await probeDevServer(effectivePort));
  }
  const reachable = httpStatus >= 200 && (httpStatus < 400 || httpStatus === 404 || httpStatus === 500);
  const probeNoResponse = httpStatus === 0;

  if (probeNoResponse) {
    ensureCaddyRoute(effectivePort);
    return { app: current, phase: 'compiling', active: true, port: effectivePort };
  }

  if (!reachable) {
    const logTail = await readJournalTail(current, 30);
    return {
      app: current,
      phase: 'error',
      active: false,
      port: effectivePort,
      httpStatus,
      error: `Dev server listening but responding ${httpStatus}`,
      logTail,
      recoveryHint:
        httpStatus >= 400 && httpStatus < 500
          ? `Dev server is up but returning ${httpStatus} on /. Check your routes, middleware, or auth.`
          : `Dev server is up but returning ${httpStatus} on /. Check recent logs for a runtime error.`,
    };
  }

  probeReadyCache.set(probeCacheKey, Date.now());
  ensureCaddyRoute(effectivePort);

  // Contamination guard: only return active=true if Caddy is caught up.
  try {
    const routeContent = fs.readFileSync('/etc/caddy/app-routes.d/dev.caddy', 'utf8');
    if (!routeContent.includes(`reverse_proxy 127.0.0.1:${effectivePort}`)) {
      return { app: current, phase: 'starting', active: false, port: effectivePort };
    }
  } catch {
    return { app: current, phase: 'starting', active: false, port: effectivePort };
  }
  if (caddyWritesPending > 0) {
    return { app: current, phase: 'starting', active: false, port: effectivePort };
  }

  // Reset heal state on successful recovery
  const heal = healStates.get(current);
  if (heal && !heal.resolved) {
    heal.resolved = true;
    metrics.healSucceeded++;
    log('info', 'self-heal succeeded', { projectName: current, attempts: heal.attempts });
  }

  // OpenAPI probe — fire-and-forget on first hit, serve cached after.
  const spec = readSpecSafe(current);
  const cached = openApiCache.get(effectivePort)?.result;
  if (!cached) {
    probeOpenApiDocs(effectivePort, spec?.openApiPath).catch(() => {});
  }

  const specMissing = spec === null;

  const hasOpenApi = !!(cached && (cached.docsPath || cached.specPath));
  const isHeadless = spec?.headless ?? (
    !hasOpenApi && !!spec?.runtime && HEADLESS_RUNTIMES.has(spec.runtime)
  );

  return {
    app: current,
    phase: 'ready',
    active: true,
    port: effectivePort,
    ...(hasOpenApi ? { openApi: cached } : {}),
    ...(specMissing ? { specMissing: true } : {}),
    ...(isHeadless ? { headless: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Companion Health
// ---------------------------------------------------------------------------

export interface CompanionHealthResult extends PreviewHealthResult {
  pathPrefix: string;
}

export async function getCompanionHealth(directory: string, port: number, pathPrefix: string): Promise<CompanionHealthResult> {
  const appPath = getAppPath(directory);

  if (!isInstallReady(appPath)) {
    const installState = installManagerStatus(appPath);
    const nothingToInstall =
      (installState.phase === 'idle' && installState.lang === null) ||
      (installState.phase === 'failed' && installState.errorClass === 'no_manifest');
    if (!nothingToInstall) {
      return { app: directory, phase: 'installing', active: false, port, pathPrefix };
    }
  }

  const status = await unitStatus(directory);
  const running = status.ActiveState === 'active' || status.ActiveState === 'activating';
  const isFailed = !running && (
    status.ActiveState === 'failed' ||
    status.SubState === 'failed' ||
    status.Result === 'start-limit-hit' ||
    status.Result === 'exit-code' ||
    status.Result === 'signal'
  );

  if (!isFailed) clearPendingHeal(directory);

  if (isFailed) {
    const logTail = await readJournalTail(directory, 40);
    const error = extractErrorSummary(logTail) || `preview unit failed (${status.Result})`;
    checkAndHeal(directory, error, logTail);
    const heal = healStates.get(directory);
    return {
      app: directory,
      phase: 'crashed',
      active: false,
      port,
      pathPrefix,
      error,
      logTail,
      healAttempts: heal?.attempts ?? 0,
      healStatus: heal ? (heal.attempts >= MAX_HEAL_ATTEMPTS ? 'exhausted' : 'healing') : null,
      failReason: 'unit_failed',
    };
  }

  if (status.ActiveState !== 'active') {
    return { app: directory, phase: 'starting', active: false, port, pathPrefix };
  }

  let effectivePort = port;
  let pid = getPidOnPort(port);
  if (pid === null) {
    const actualPort = detectMismatchedPort(directory, port);
    if (actualPort !== null) {
      effectivePort = autoCorrectPort(directory, port, actualPort);
      pid = getPidOnPort(effectivePort);
      // Update the companion entry with the corrected port.
      const companions = getCompanions();
      const idx = companions.findIndex((c) => c.directory === directory);
      if (idx >= 0) {
        companions[idx]!.port = effectivePort;
        saveCompanions(companions);
      }
      // Rewrite the primary Caddy route to include the corrected companion port.
      let primaryApp: string | null = null;
      try { primaryApp = fs.readFileSync(PREVIEW_FILE, 'utf8').trim() || null; } catch {}
      if (primaryApp) writeCaddyDevRoute(getProjectPort(primaryApp));
    }
    if (pid === null) {
      return { app: directory, phase: 'starting', active: false, port: effectivePort, pathPrefix };
    }
  }

  const { httpStatus } = await probeDevServer(effectivePort);
  const reachable = httpStatus >= 200 && (httpStatus < 400 || httpStatus === 404 || httpStatus === 500);
  if (!reachable) {
    return { app: directory, phase: 'starting', active: false, port: effectivePort, pathPrefix };
  }

  if (caddyWritesPending > 0) {
    return { app: directory, phase: 'starting', active: false, port: effectivePort, pathPrefix };
  }

  const heal = healStates.get(directory);
  if (heal && !heal.resolved) {
    heal.resolved = true;
    metrics.healSucceeded++;
  }

  return { app: directory, phase: 'ready', active: true, port: effectivePort, pathPrefix };
}

export interface MultiPreviewHealth {
  primary: PreviewHealthResult;
  companions: CompanionHealthResult[];
}

export async function getAllPreviewHealth(): Promise<MultiPreviewHealth> {
  const primary = await getPreviewHealth();
  const companions = await Promise.all(getCompanions().map((c) => getCompanionHealth(c.directory, c.port, c.pathPrefix)));
  return { primary, companions };
}

export function broadcastAllPreviewHealth(): void {
  if (!_previewBroadcastFn) return;
  getAllPreviewHealth()
    .then((state) => _previewBroadcastFn?.('preview_all_status', state))
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Lifecycle emit — the single entry point for every preview phase transition
// ---------------------------------------------------------------------------

// PreviewLifecyclePhase + CANONICAL_PREVIEW_PHASES are imported from

// transition caused the 2026-04-22 GET→adopt→emit→invalidate loop.
// (useCurrentApp, preview dashboards) never lag a canonical state
export function emitPhaseTransition(
  appDirectory: string,
  phase: PreviewLifecyclePhase,
  message: string,
  extra?: { runtime?: string },
): void {
  if (!markPhaseEmitted(appDirectory, phase)) {
    // Same phase already broadcast since the last transition — suppressing
    log('debug', 'preview phase emit suppressed (duplicate)', {
      app: appDirectory,
      phase,
    });
    return;
  }
  const canonical = CANONICAL_PREVIEW_PHASES.has(phase);
  // Structured log — lets operators confirm from journalctl that the
  log('info', 'preview phase emit', {
    app: appDirectory,
    phase,
    canonical,
    hasBroadcastFn: _previewBroadcastFn !== null,
  });
  _previewBroadcastFn?.('preview_install_status', {
    app: appDirectory,
    phase,
    message,
    ...extra,
  });
  if (canonical) {
    broadcastAllPreviewHealth();
  }
}

// ---------------------------------------------------------------------------
// Set Preview App — the primary/active switch
// ---------------------------------------------------------------------------

export async function setPreviewApp(
  appDirectory: string | null,
  script?: string,
): Promise<{
  success: boolean;
  app: string | null;
  preview?: PreviewStartResult;
  superseded?: boolean;
}> {
  const requestId = getNextRequestId();
  log('info', 'setPreviewApp', { appDirectory, requestId });

  fs.mkdirSync(`${HOME}/.ellul`, { recursive: true });

  if (!isLatestRequest(requestId)) {
    return { success: true, app: appDirectory, superseded: true };
  }

  if (appDirectory && !fs.existsSync(getAppPath(appDirectory))) {
    log('error', 'setPreviewApp: rejecting — app directory does not exist', {
      appDirectory, resolvedPath: getAppPath(appDirectory),
    });
    return { success: false, app: appDirectory };
  }

  // Switch = clean slate: stop ALL companions + old primary before starting new.
  if (appDirectory) {
    let oldPrimary: string | null = null;
    try {
      oldPrimary = fs.readFileSync(PREVIEW_FILE, 'utf8').trim() || null;
    } catch {}

    const existingCompanions = getCompanions();
    if (existingCompanions.length > 0) {
      log('info', 'app switch: stopping all companions', { count: existingCompanions.length });
      for (const c of existingCompanions) {
        await stopPreview(c.directory);
      }
      saveCompanions([]);
    }

    if (oldPrimary && oldPrimary !== appDirectory) {
      await stopPreview(oldPrimary);
    }
  }

  fs.writeFileSync(PREVIEW_FILE, appDirectory || '');
  if (script) {
    fs.writeFileSync(`${HOME}/.ellul/preview-script`, script);
  }

  if (appDirectory) await resetFailed(appDirectory);
  broadcastAllPreviewHealth();

  if (!appDirectory) {
    await stopPreview();
    return { success: true, app: null };
  }

  // Write Caddy route and AWAIT the reload before returning. The UI
  const projectPort = getProjectPort(appDirectory);
  await writeCaddyDevRoute(projectPort);

  if (!isLatestRequest(requestId)) {
    return { success: true, app: appDirectory, superseded: true };
  }

  const result = await startPreview(appDirectory, requestId);

  if (!isLatestRequest(requestId)) {
    return { success: true, app: appDirectory, preview: result, superseded: true };
  }

  broadcastAllPreviewHealth();

  return { success: true, app: appDirectory, preview: result };
}

// ---------------------------------------------------------------------------
// Monorepo helpers
// ---------------------------------------------------------------------------

function getMonorepoRoot(directory: string): string {
  const parts = directory.split('/');
  return parts.slice(0, 2).join('/');
}

// ---------------------------------------------------------------------------
// Companion Start / Stop
// ---------------------------------------------------------------------------

export async function startCompanionPreview(
  appDirectory: string,
  pathPrefix: string = '/api',
): Promise<{
  success: boolean;
  port?: number;
  pathPrefix?: string;
  error?: string;
  warning?: string;
}> {
  // Validate pathPrefix
  if (!pathPrefix.startsWith('/') || pathPrefix.length < 2) {
    return { success: false, error: 'Path prefix must start with / and be at least 2 characters' };
  }
  if (pathPrefix === '/') {
    return { success: false, error: 'Path prefix cannot be / (would shadow the primary)' };
  }
  const cleanPrefix = pathPrefix.replace(/\/+$/, '');
  if (/[^a-zA-Z0-9/_-]/.test(cleanPrefix)) {
    return { success: false, error: 'Path prefix contains invalid characters' };
  }

  let primaryApp: string | null = null;
  try {
    primaryApp = fs.readFileSync(PREVIEW_FILE, 'utf8').trim() || null;
  } catch {}
  if (!primaryApp) {
    return { success: false, error: 'No primary preview running. Start a primary first.' };
  }

  const primaryRoot = getMonorepoRoot(primaryApp);
  const companionRoot = getMonorepoRoot(appDirectory);
  if (primaryRoot !== companionRoot) {
    return { success: false, error: 'Companion must be in the same project as the primary' };
  }
  if (appDirectory === primaryApp) {
    return { success: false, error: 'This package is already the primary preview' };
  }

  const companions = getCompanions();
  const existing = companions.find((c) => c.directory === appDirectory);
  if (existing) {
    return { success: true, port: existing.port, pathPrefix: existing.pathPrefix };
  }

  // Check for prefix conflict with other companions
  if (companions.some((c) => c.pathPrefix === cleanPrefix)) {
    return { success: false, error: `Path prefix "${cleanPrefix}" is already used by another companion` };
  }

  const result = await startPreview(appDirectory, undefined, { skipCaddyRoute: true });
  if (!result.success) {
    return { success: false, error: result.error || 'Failed to start companion' };
  }

  const port = getProjectPort(appDirectory);
  addCompanion(appDirectory, port, cleanPrefix);

  const primaryPort = getProjectPort(primaryApp);
  writeCaddyDevRoute(primaryPort);

  broadcastAllPreviewHealth();
  log('info', 'companion started', { directory: appDirectory, port, pathPrefix: cleanPrefix });
  return { success: true, port, pathPrefix: cleanPrefix };
}

export async function stopCompanionPreview(appDirectory: string): Promise<void> {
  removeCompanion(appDirectory);
  await stopPreview(appDirectory);

  let primaryApp: string | null = null;
  try {
    primaryApp = fs.readFileSync(PREVIEW_FILE, 'utf8').trim() || null;
  } catch {}
  if (primaryApp) {
    writeCaddyDevRoute(getProjectPort(primaryApp));
  }

  broadcastAllPreviewHealth();
  log('info', 'companion stopped', { directory: appDirectory });
}

// ---------------------------------------------------------------------------
// Reconciliation & GC — called from file-api startup + periodic timers
// ---------------------------------------------------------------------------

export async function reconcileCompanions(): Promise<void> {
  const companions = getCompanions();
  if (companions.length === 0) return;
  const actives = new Set(await listActive());
  const valid = companions.filter((c) => {
    if (!actives.has(c.directory)) {
      log('info', 'reconcile: removing stale companion', { directory: c.directory });
      return false;
    }
    return true;
  });
  if (valid.length !== companions.length) saveCompanions(valid);
}

export async function reconcilePortRegistry(): Promise<void> {
  try {
    const registry = getPortRegistry();
    const actives = new Set(await listActive());
    let changed = false;
    for (const [project, port] of Object.entries(registry)) {
      // Bare sandbox slugs should never have ports — clean up stale entries
      // from the bug where getPreviewHealth was called with sandbox slugs.
      if (isSandboxId(project)) {
        delete registry[project];
        changed = true;
        metrics.gcPortsReclaimed++;
        log('info', 'GC: removed sandbox-slug port registry entry', { project, port });
        continue;
      }
      const projectDir = path.join(ROOT_DIR, project);
      const pidOnPort = getPidOnPort(port);
      if (!fs.existsSync(projectDir) && !actives.has(project) && pidOnPort === null) {
        delete registry[project];
        changed = true;
        metrics.gcPortsReclaimed++;
        log('info', 'GC: removed orphaned port registry entry', { project, port });
        continue;
      }
      // but the port has a listener. That's a previous-boot leak or a
      if (
        fs.existsSync(projectDir)
        && !actives.has(project)
        && pidOnPort !== null
      ) {
        try {
          const heal = await healOrphan(project);
          if (heal.healed) {
            log('warn', 'GC: healed boot-time orphan', {
              project, port, pid: heal.pid, signal: heal.signalUsed,
            });
          } else if (heal.reason === 'foreign_user' || heal.reason === 'unknown_cmdline') {
            // Don't touch it — report only. Surfaced to the UI via
            log('warn', 'GC: orphan on preview port but not healable', {
              project, port, pid: heal.pid, reason: heal.reason,
            });
          }
        } catch (err) {
          log('error', 'GC: healOrphan threw', {
            project, port, error: (err as Error).message,
          });
        }
      }
    }
    if (changed) savePortRegistry(registry);
  } catch (e) {
    log('error', 'reconcilePortRegistry failed', { error: (e as Error).message });
  }
}

export async function cleanupOrphanedPreviews(): Promise<void> {
  try {
    // ── Pass 1: unit-owned orphans ────────────────────────────────────
    // systemd unit is active but its target is unreachable (app dir gone)
    const actives = await listActive();
    for (const appDir of actives) {
      const dir = path.join(ROOT_DIR, appDir);
      if (!fs.existsSync(dir)) {
        log('info', 'GC: stopping orphaned preview unit (app dir missing)', { appDir });
        await stopUnit(appDir);
        continue;
      }
      // Sandbox-level orphan: dir exists, but sandbox/ellul.json is gone
      const sandboxId = appDir.split('/')[0];
      if (sandboxId) {
        const sandboxMeta = path.join(ROOT_DIR, sandboxId, 'ellul.json');
        if (!fs.existsSync(sandboxMeta)) {
          log('info', 'GC: stopping orphaned preview unit (sandbox ellul.json missing)', {
            appDir, sandboxId,
          });
          await stopUnit(appDir);
        }
      }
    }

    // ── Pass 2: port-held orphans without any unit at all ────────────
    // unit-owned sweep above won't catch this because listActive() only
    // returns systemd-managed units. On 2026-04-20 this left a Next.js
    const registry = getPortRegistry();
    const registeredPorts = new Set<number>(Object.values(registry));
    const actualActives = new Set(actives);
    for (let port = PREVIEW_PORT_MIN; port <= PREVIEW_PORT_MAX; port++) {
      const pid = getPidOnPort(port);
      if (pid === null) continue;
      // Skip ports tracked by the registry — reconcilePortRegistry owns
      if (registeredPorts.has(port)) continue;
      // Skip if any active unit has claimed this port recently.
      let claimedByUnit = false;
      for (const app of actualActives) {
        if (getProjectPort(app) === port) {
          claimedByUnit = true;
          break;
        }
      }
      if (claimedByUnit) continue;
      // (which keys off appDirectory we don't have for a leaked port).
      const proc = readProcInfo(pid);
      const classification = classifyOrphan({
        port,
        pid,
        activeState: 'inactive',
        proc,
        svcUid: getSvcUid(),
        portRangeMin: PREVIEW_PORT_MIN,
        portRangeMax: PREVIEW_PORT_MAX,
      });
      if (!classification.isOrphan || classification.reason !== 'orphan_healable') {
        log('warn', 'GC: leaked port held by non-healable process', {
          port, pid, reason: classification.reason,
          cmdline: proc?.cmdline?.slice(0, 120),
        });
        continue;
      }
      // SIGTERM, wait up to 2s, then SIGKILL. Same escalation pattern as
      try { process.kill(pid, 'SIGTERM'); } catch {}
      const killDeadline = Date.now() + 2000;
      while (Date.now() < killDeadline && getPidOnPort(port) === pid) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (getPidOnPort(port) === pid) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
      metrics.orphansDetected++;
      log('warn', 'GC: reaped leaked preview process on unregistered port', {
        port, pid, cmdline: proc?.cmdline?.slice(0, 120),
      });
    }
  } catch (e) {
    log('error', 'cleanupOrphanedPreviews failed', { error: (e as Error).message });
  }
}

// Status bundle for /api/preview GET.
export async function getPreviewStatus(): Promise<{ app: string | null; running: boolean; port: number }> {
  let current: string | null = null;
  if (fs.existsSync(PREVIEW_FILE)) {
    current = fs.readFileSync(PREVIEW_FILE, 'utf8').trim() || null;
  }
  const running = current ? await isActive(current) : false;
  const port = current ? getProjectPort(current) : PREVIEW_PORT_MIN;
  return { app: current, running, port };
}
