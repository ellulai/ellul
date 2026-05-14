// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Namespace Spawn Service
 *
 * Drives `ellul-namespaced` from the bridge side:
 *   - setupNamespace(project)    — admin-socket SETUP; daemon stages mounts in-process
 *   - teardownNamespace(project) — admin-socket TEARDOWN
 *   - spawnInNamespace(...)      — per-project ENTER over sealed memfds via fd-pass
 *
 * Linux only. macOS throws on project-scoped spawns (BYOS planned).
 *
 * No sudo, no /tmp env files, no bash on the trust boundary. argv + env
 * travel as F_SEAL_WRITE-sealed memfds; the daemon validates seals before
 * read. Failures surface as thrown errors — there is no fallback path.
 */

import { isSandboxId } from '@ellul.ai/types';
import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { createHash, createHmac } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';

import { logEvent, serializeError } from '../../shared/event-log';
import { EllulNamespacedClient } from './EllulNamespacedClient';
import { callShieldInternal } from '@vps/shared/shield-client';

const NSD_ADMIN_SOCK = '/run/ellul-ns/admin.sock';

// Bump when iptables/DNAT rules change. Namespaces with a lower version are
// treated as stale by isNamespaceRunning → torn down and re-staged.
// v1: PREROUTING DNAT for MCP endpoint port 7702.
const REQUIRED_NET_VERSION = 1;

export type Platform = 'linux' | 'darwin';

/** Detect the host platform. */
function detectPlatform(): Platform {
  const p = os.platform();
  if (p === 'linux') return 'linux';
  if (p === 'darwin') return 'darwin';
  throw new Error(`Unsupported platform "${p}" — only linux and darwin are supported`);
}

// Resolved once at startup
const PLATFORM: Platform = detectPlatform();

let nsAvailable: boolean | null = null;

const SECCOMP_BIN = '/usr/local/bin/ellul-seccomp-exec';
let seccompAvailable: boolean | null = null;

/**
 * Check if namespace isolation is available — daemon admin socket present.
 * Linux-only; macOS always false.
 */
export function isNamespaceAvailable(): boolean {
  if (PLATFORM === 'darwin') return false;
  if (nsAvailable !== null) return nsAvailable;
  try {
    fs.accessSync(NSD_ADMIN_SOCK, fs.constants.R_OK | fs.constants.W_OK);
    nsAvailable = true;
  } catch {
    nsAvailable = false;
  }
  return nsAvailable;
}

/**
 * Check if seccomp-BPF enforcement is available.
 *
 * - Linux: requires the seccomp binary to be compiled and executable.
 *   If missing on Linux, this is a deployment failure — callers should throw.
 * - macOS: always false (seccomp-BPF is Linux-only).
 *
 * The cache is invalidated when the binary appears (the enforcer's drift
 * detection can recompile it at runtime).
 */
export function isSeccompAvailable(): boolean {
  if (PLATFORM === 'darwin') return false;
  // Re-check if previously unavailable (enforcer may have recompiled it)
  if (seccompAvailable === true) return true;
  try {
    fs.accessSync(SECCOMP_BIN, fs.constants.X_OK);
    seccompAvailable = true;
  } catch {
    seccompAvailable = false;
  }
  return seccompAvailable;
}

/** Returns the detected host platform. */
export function getHostPlatform(): Platform {
  return PLATFORM;
}

/**
 * Server-local secret for namespace IP derivation.
 *
 * SECURITY: Uses HMAC-SHA256 keyed by a per-server secret instead of plain MD5.
 * This prevents attackers from pre-computing namespace IPs from project slugs
 * without access to the server's local key material.
 *
 * Falls back to machine-id if jwt-secret is unavailable (development).
 */
let nsIpKey: Buffer | null = null;

function getNsIpKey(): Buffer {
  if (nsIpKey) return nsIpKey;
  // Primary: use jwt-secret (already exists on all provisioned servers)
  try {
    const secret = fs.readFileSync('/etc/ellul/jwt-secret', 'utf8').trim();
    if (secret.length >= 32) {
      // Use as raw UTF-8 string — must match the shell's `openssl dgst -hmac "$SECRET"`
      // which passes the hex string literally as the HMAC key, NOT decoded to bytes.
      nsIpKey = Buffer.from(secret, 'utf8');
      return nsIpKey;
    }
  } catch {}
  // Fallback: machine-id (always exists on Linux, stable across reboots)
  try {
    const machineId = fs.readFileSync('/etc/machine-id', 'utf8').trim();
    nsIpKey = createHash('sha256').update(machineId).digest();
    return nsIpKey;
  } catch {}
  // Last resort: random key (changes on restart — not ideal but safe)
  const { randomBytes } = require('crypto') as typeof import('crypto');
  nsIpKey = randomBytes(32);
  return nsIpKey!;
}

/**
 * Get the deterministic namespace IP for a project.
 *
 * Must match the bash computation in the namespace script.
 * Uses HMAC-SHA256 keyed by a server-local secret for derivation.
 *
 * Computes: HMAC-SHA256(server_key, project_slug) → first 3 bytes → IP octets
 *   OCTET1 = (byte[0] % 55) + 200    → range 200-254
 *   OCTET2 = byte[1]                  → range 0-255
 *   OCTET3 = byte[2] & 0xFC           → range 0-252 (aligned to /30)
 *   NS_IP  = 10.OCTET1.OCTET2.(OCTET3+2)
 *
 * ~900K possible /30 subnets (10.200-254.0-255.0-252).
 * Returns null if namespace isolation is not available (macOS, shared mode).
 */
export function getNamespaceIp(project: string): string | null {
  // Gate on platform + per-project namespace existence, NOT the daemon
  // admin socket. The veth IP is deterministic and is needed any time a
  // namespace exists for this project — including when the daemon is
  // unreachable but a namespace anchor is still alive (post-fallback
  // recovery, or daemon restart-loops). Falling back to 0.0.0.0:port
  // here breaks every bridge→opencode HTTP call from the host network.
  if (PLATFORM === 'darwin') return null;
  if (!isProjectNamespaceRunning(project)) return null;
  const key = getNsIpKey();
  const hash = createHmac('sha256', key).update(project).digest();
  const octet1 = (hash[0]! % 55) + 200;
  const octet2 = hash[1]!;
  const octet3 = hash[2]! & 0xFC;
  return `10.${octet1}.${octet2}.${octet3 + 2}`;
}

function isProjectNamespaceRunning(project: string): boolean {
  if (PLATFORM === 'darwin') return false;
  try {
    fs.accessSync(`/run/.ns-${project}/anchor.pid`, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the deterministic host-side veth IP for a project.
 *
 * Same derivation as getNamespaceIp() but returns the host-side address (+1)
 * instead of the namespace-side address (+2). Used by the MCP relay to
 * address the bridge from inside the namespace via the veth pair.
 *
 * In a /30 subnet: .0 = network, .1 = host, .2 = namespace, .3 = broadcast.
 */
export function getHostVethIp(project: string): string | null {
  if (PLATFORM === 'darwin') return null;
  if (!isProjectNamespaceRunning(project)) return null;
  const key = getNsIpKey();
  const hash = createHmac('sha256', key).update(project).digest();
  const octet1 = (hash[0]! % 55) + 200;
  const octet2 = hash[1]!;
  const octet3 = hash[2]! & 0xFC;
  return `10.${octet1}.${octet2}.${octet3 + 1}`;
}

// Namespace-side veth IP — .2 in the /30 (peer of getHostVethIp's .1).
// Used by agent-bridge to reach a server bound inside the namespace.
export function getNsVethIp(project: string): string | null {
  const host = getHostVethIp(project);
  if (!host) return null;
  const parts = host.split('.');
  return `${parts[0]}.${parts[1]}.${parts[2]}.${Number(parts[3]) + 1}`;
}

/**
 * Compute a per-project HMAC token for MCP endpoint authentication.
 *
 * Deterministic: both the bridge (verifier) and the .mcp.json generator
 * derive the same token from the server's jwt-secret and project slug.
 * Not stored — computed on demand.
 */
export function computeMcpToken(project: string): string | null {
  try {
    const key = getNsIpKey();
    return createHmac('sha256', key).update(`mcp-gateway:${project}`).digest('hex');
  } catch {
    return null;
  }
}

// ── Namespace Config Pre-Parsing ─────────────────────────────
// Reads JSON configs the daemon's mount-staging worker consumes. The bridge
// pre-parses so the daemon SETUP RPC arguments are typed and small.

const SHIELD_DATA = '/etc/ellul/shield-data';
const CROSS_PROJECT_CONFIG = `${SHIELD_DATA}/cross-project-access.json`;
const PREVIEW_PORTS_FILE = `${SHIELD_DATA}/preview-ports.json`;

interface NamespaceConfig {
  sharedProjects: string;    // space-separated project slugs
  sharedPreviews: string;    // space-separated "1"/"0"
  sharedPorts: string;       // space-separated port numbers or "0"
}

/**
 * Pre-parse namespace config from shield-data JSON files. Result is shipped
 * to the daemon's SETUP RPC as typed CBOR strings (see EllulNamespacedClient).
 */
export function parseNamespaceConfig(project: string): NamespaceConfig {
  // Cross-project access
  let sharedNames: string[] = [];
  let sharedPreviews: string[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(CROSS_PROJECT_CONFIG, 'utf8'));
    const entries = raw[project] || [];
    for (const e of entries) {
      if (typeof e === 'object' && e !== null) {
        const n = e.sandbox || '';
        // Tighten the cross-project allowlist to the canonical sandbox slug.
        // A tampered cross-project-access.json that smuggles a non-sbx name
        // through the TS gate would still be rejected by the daemon's signed
        // manifest regex, but rejecting here keeps logs/UX coherent.
        if (n && n !== project && /^sbx-[a-z0-9]{7}$/.test(n)) {
          sharedNames.push(n);
          sharedPreviews.push(e.preview ? '1' : '0');
        }
      }
    }
  } catch { /* config missing or invalid — no shared projects */ }

  // Preview ports
  let sharedPorts: string[] = [];
  if (sharedNames.length > 0) {
    try {
      const ports = JSON.parse(fs.readFileSync(PREVIEW_PORTS_FILE, 'utf8'));
      for (let i = 0; i < sharedNames.length; i++) {
        if (sharedPreviews[i] === '1') {
          const port = parseInt(ports[sharedNames[i]!] || '0', 10);
          sharedPorts.push(port >= 4000 && port <= 4099 ? String(port) : '0');
        } else {
          sharedPorts.push('0');
        }
      }
    } catch { sharedPorts = sharedNames.map(() => '0'); }
  }

  return {
    sharedProjects: sharedNames.join(' '),
    sharedPreviews: sharedPreviews.join(' '),
    sharedPorts: sharedPorts.join(' '),
  };
}

// ── Per-Project Quiescence Lock ──────────────────────────────
// Structurally enforced mutex: namespace-mutating operations (deferred shared
// mounts) and command execution (spawnInNamespace) both acquire this lock.
// No code path can bypass it — the lock is the only entry point for both.
const projectLocks = new Map<string, Promise<void>>();

/**
 * Acquire exclusive lock on a project namespace.
 * Returns a release function. Both deferred mount and command spawn use this.
 */
export async function acquireProjectLock(project: string): Promise<() => void> {
  while (projectLocks.has(project)) {
    await projectLocks.get(project);
  }
  let release!: () => void;
  projectLocks.set(project, new Promise<void>(r => { release = r; }));
  return () => { projectLocks.delete(project); release(); };
}

// ── Persistent Namespace Lifecycle ──────────────────────────

// Deduplicates concurrent setupNamespace() calls for the same project.
const pendingSetups = new Map<string, Promise<void>>();

function healNetVersion(project: string): void {
  const netVerFile = `/run/.ns-${project}/net-version`;
  try {
    const raw = fs.readFileSync(netVerFile, 'utf8').trim();
    const ver = parseInt(raw, 10);
    if (!isNaN(ver) && ver >= REQUIRED_NET_VERSION) return;
  } catch { /* missing or unreadable */ }
  try {
    fs.writeFileSync(netVerFile, `${REQUIRED_NET_VERSION}\n`);
    logEvent('ns.net-version-healed', { project });
  } catch { /* /run/.ns-{project}/ may not exist */ }
}

// "Recently confirmed healthy" cache. setupNamespace is called from many
// hot paths (every WS reconnect, every CLI spawn, every preview activation).
// Without this cache each call re-walks the FS + ready-marker probe and a
// rare anchor death triggers a full daemon-driven setup. The cache short-
// circuits the steady state — confirmed healthy < CACHE_TTL ago, skip.
const healthyUntil = new Map<string, number>();
const HEALTH_CACHE_TTL_MS = 30_000;

/**
 * Check if a persistent namespace is running for a project.
 * Reads the anchor PID file and checks if the process is alive.
 *
 * Uses process.kill(pid, 0) signal probe:
 *   - Returns normally → process alive (same UID)
 *   - Throws EPERM → process alive (different UID — anchor runs as root)
 *   - Throws ESRCH → process dead
 *
 * Previous approach used /proc/<pid>/status which fails with hidepid=2
 * (kernel hides root-owned processes from non-root users in /proc).
 *
 * Safety: anchor PID file is written ONLY after the READY_FIFO is signaled
 * (setup mode waits for all namespace phases to complete before writing the PID).
 * PID file exists → namespace is fully functional.
 */
export function isNamespaceRunning(project: string): boolean {
  if (!isNamespaceAvailable()) return false;
  try {
    // Check anchor process is alive
    const pidFile = `/run/.ns-${project}/anchor.pid`;
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (isNaN(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EPERM') return false; // ESRCH → dead
      // EPERM → alive (root-owned), continue checking ready
    }
    // Anchor alive — verify the ready marker exists too. /run/ is tmpfs;
    // after reboot the ready file is gone even if the anchor survived (e.g.
    // vault restored PID file but /run/ is fresh). A namespace without the
    // ready file has incomplete setup (no /proc, no DNS, no isolation);
    // treat as dead. The next setupNamespace will drive the daemon to
    // teardown + restage cleanly.
    const readyFile = `/run/.ns-ready-${project}`;
    if (!fs.existsSync(readyFile)) {
      logEvent('ns.stale-detected', { project, pid });
      return false;
    }
    // Network version check: namespaces created before the 7702 DNAT rule
    // lack MCP endpoint connectivity. Treat them as dead so setupNamespace
    // drives a teardown + re-stage with the current iptables ruleset.
    const netVerFile = `/run/.ns-${project}/net-version`;
    try {
      const ver = parseInt(fs.readFileSync(netVerFile, 'utf8').trim(), 10);
      if (isNaN(ver) || ver < REQUIRED_NET_VERSION) {
        logEvent('ns.stale-net-version', { project, pid, ver });
        return false;
      }
    } catch {
      logEvent('ns.stale-net-version', { project, pid, ver: 0 });
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Set up a persistent namespace for a project via the daemon's admin
 * socket. The namespace persists until teardownNamespace() is called or
 * the anchor
 * process dies. Subsequent exec calls use `enter` (fast nsenter).
 *
 * Idempotent — if namespace is already running, returns immediately.
 * Concurrent calls are deduplicated via promise cache.
 */
export async function setupNamespace(project: string): Promise<void> {
  if (!isNamespaceAvailable()) return;

  // Fast path — if we recently confirmed the namespace healthy, skip every
  // syscall. UI reconnects can fire setupNamespace dozens of times per
  // minute; without this gate each one walks the filesystem.
  const fresh = healthyUntil.get(project);
  if (fresh && fresh > Date.now()) return;

  if (isNamespaceRunning(project)) {
    healthyUntil.set(project, Date.now() + HEALTH_CACHE_TTL_MS);
    return;
  }

  // Stale DNAT migration: anchor alive but net-version missing/outdated.
  // Try teardown for a clean re-stage; if it fails, the daemon's idempotent
  // SETUP will heal the net-version marker in-place.
  if (isProjectNamespaceRunning(project)) {
    logEvent('ns.stale-teardown', { project });
    try { await teardownNamespace(project); } catch { /* best-effort */ }
  }

  // Deduplicate concurrent setup calls
  const pending = pendingSetups.get(project);
  if (pending) return pending;

  const setupPromise = setupNamespaceInner(project).then(() => {
    healNetVersion(project);
    healthyUntil.set(project, Date.now() + HEALTH_CACHE_TTL_MS);
  });
  pendingSetups.set(project, setupPromise);
  try {
    await setupPromise;
  } finally {
    pendingSetups.delete(project);
  }
}

async function setupNamespaceInner(project: string): Promise<void> {
  const startedAt = Date.now();
  logEvent('ns.setup.begin', { project });

  const cfg = parseNamespaceConfig(project);

  const client = await EllulNamespacedClient.tryConnectAdmin();
  if (!client) {
    logEvent('ns.setup.daemon-required', {
      project,
      durationMs: Date.now() - startedAt,
      reason: 'admin-connect-failed',
    });
    throw new Error(
      `Namespace setup failed for ${project}: nsd admin socket unreachable`,
    );
  }
  try {
    const res = await client.setup(project, {
      sharedProjects: cfg.sharedProjects || undefined,
      sharedPreviews: cfg.sharedPreviews || undefined,
      sharedPorts: cfg.sharedPorts || undefined,
    });
    const durationMs = Date.now() - startedAt;
    if (res.ok && res.success) {
      logEvent('ns.setup.success', {
        project, durationMs,
        anchorPid: res.anchorPid ?? null,
        unit: res.unitName ?? null,
      });
      if (cfg.sharedProjects) {
        reconcileSharedSnapshotsAsync(project);
      }
      return;
    }
    logEvent('ns.setup.daemon-required', {
      project, durationMs,
      reason: 'nsd-rejected',
      errcode: res.errcode ?? null,
      errorMessage: res.errorMessage ?? null,
    });
    throw new Error(
      `Namespace setup failed for ${project}: nsd errcode=${res.errcode ?? 'unknown'} msg=${res.errorMessage ?? ''}`,
    );
  } finally {
    client.close();
  }
}

function reconcileSharedSnapshotsAsync(project: string): void {
  callShieldInternal('/api/internal/cross-project-access/reconcile', {
    method: 'POST',
    body: { sandboxId: project },
    timeout: 60_000,
  }).then((res) => {
    if (!res.ok) {
      logEvent('ns.reconcile-shared.fail', { project, status: res.status });
    }
  }).catch(() => {
    logEvent('ns.reconcile-shared.fail', { project, reason: 'fetch-error' });
  });
}

/**
 * Tear down a persistent namespace for a project. Cleans up iptables rules,
 * kills the anchor process, removes artifacts. Idempotent — safe to call
 * when the namespace isn't running.
 */
export async function teardownNamespace(project: string): Promise<void> {
  if (!isNamespaceAvailable()) return;
  const startedAt = Date.now();
  logEvent('ns.teardown.begin', { project });
  healthyUntil.delete(project);

  const client = await EllulNamespacedClient.tryConnectAdmin();
  if (!client) {
    logEvent('ns.teardown.daemon-required', {
      project,
      durationMs: Date.now() - startedAt,
      reason: 'admin-connect-failed',
    });
    throw new Error(
      `Namespace teardown failed for ${project}: nsd admin socket unreachable`,
    );
  }
  try {
    const res = await client.teardown(project);
    const durationMs = Date.now() - startedAt;
    if (res.ok && res.success) {
      logEvent('ns.teardown.done', { project, durationMs });
      return;
    }
    logEvent('ns.teardown.daemon-required', {
      project, durationMs,
      reason: 'nsd-rejected',
      errcode: res.errcode ?? null,
      errorMessage: res.errorMessage ?? null,
    });
    throw new Error(
      `Namespace teardown failed for ${project}: nsd errcode=${res.errcode ?? 'unknown'} msg=${res.errorMessage ?? ''}`,
    );
  } finally {
    client.close();
  }
}

// ── Spawn API ───────────────────────────────────────────────

/**
 * Pool / Pro Claude slot routing into per-sandbox transient cgroup slices.
 * The bridge spawns an `ellul-spawn-scope` sleeper to materialize the
 * per-pool transient unit, then passes the resolved cgroup-v2 path to the
 * daemon as the ENTER body's target_cgroup field. The daemon's worker
 * joins that cgroup before setns, so the child runs under the per-sandbox
 * slice instead of inheriting the daemon's own cgroup.
 *
 * Spec: docs/v2/architecture/resource-v2/03-spawn-routing.md
 */
export interface AdapterScope {
  /** Adapter family: claude | opencode | cursor | codex. */
  adapter: "claude" | "opencode" | "cursor" | "codex";
  /** Short scope id; matches /^[a-zA-Z0-9_-]{1,32}$/. Unique per (sandbox, adapter) pool entry. */
  scopeId: string;
  /** Per-sandbox slice MemoryHigh soft-hint, MB. From computeWorkloadSliceBudget(). */
  softHintMB: number;
}

export interface NamespaceSpawnOptions extends SpawnOptions {
  /** Environment variables to pass through to the namespaced process. */
  env?: NodeJS.ProcessEnv;
  /** Thread ID for per-thread isolation (CLI state separation). */
  threadId?: string | null;
  /**
   * If set, the spawn is wrapped with `ellul-spawn-scope` to land in a per-sandbox
   * cgroup slice. Required for pool processes; optional for ad-hoc commands.
   */
  adapterScope?: AdapterScope;
}

const SPAWN_SCOPE_BIN = "/usr/local/bin/ellul-spawn-scope";
const SCOPE_ID_RE = /^[a-zA-Z0-9_-]{1,32}$/;
const ADAPTER_ALLOWLIST = new Set(["claude", "opencode", "cursor", "codex"]);

function buildSpawnScopeArgs(project: string, scope: AdapterScope): string[] {
  if (!ADAPTER_ALLOWLIST.has(scope.adapter)) {
    throw new Error(`[Namespace] Invalid adapter "${scope.adapter}" in adapterScope`);
  }
  if (!SCOPE_ID_RE.test(scope.scopeId)) {
    throw new Error(`[Namespace] Invalid scopeId "${scope.scopeId}" — must match /^[a-zA-Z0-9_-]{1,32}$/`);
  }
  if (!Number.isFinite(scope.softHintMB) || scope.softHintMB <= 0 || scope.softHintMB > 8192) {
    throw new Error(`[Namespace] Invalid softHintMB ${scope.softHintMB} — must be in (0, 8192]`);
  }
  const short = project.replace(/^sbx-/, "");
  const slice = `ellul-user-workload-sbx-${short}.slice`;
  const unit = `ellul-pool-sbx-${short}-${scope.adapter}-${scope.scopeId}`;
  const props = `MemoryHigh=${scope.softHintMB}M,MemorySwapMax=0,TasksMax=512`;
  return [SPAWN_SCOPE_BIN, slice, unit, props, "--"];
}

/**
 * Mirror of buildSpawnScopeArgs that returns the cgroup-v2 path the resulting
 * scope unit will live at. systemd nests slices via dash-separated unit names:
 * `ellul-user-workload-sbx-<short>.slice` is a child of
 * `ellul-user-workload.slice`, which is a child of `ellul.slice`. The scope
 * unit (created via systemd-run --scope) lands as a child of its slice.
 */
function computeAdapterScopeCgroup(project: string, scope: AdapterScope): string {
  const short = project.replace(/^sbx-/, "");
  return (
    `/sys/fs/cgroup/ellul.slice/ellul-user-workload.slice/` +
    `ellul-user-workload-sbx-${short}.slice/` +
    `ellul-pool-sbx-${short}-${scope.adapter}-${scope.scopeId}.scope`
  );
}

/**
 * Spawn an ellul-spawn-scope sleeper to materialize the per-pool transient
 * scope cgroup. Returns the sleeper ChildProcess (detached, unref'd) so the
 * caller can SIGKILL its process group on exit. The caller MUST kill the
 * pgrp; otherwise sleep keeps the scope unit alive forever.
 *
 * The scope unit uses --collect, so the unit auto-cleans when the cgroup
 * empties. The daemon's ENTER worker joins the scope cgroup and exits when
 * the spawned child exits; killing the sleeper after EXIT_NOTIFY drops the
 * last process and triggers --collect cleanup.
 */
function spawnAdapterScopeAnchor(
  project: string,
  scope: AdapterScope,
): ChildProcess {
  const args = buildSpawnScopeArgs(project, scope);
  const sleeper = spawn(
    "sudo",
    [...args, "/usr/bin/sleep", "infinity"],
    {
      stdio: "ignore",
      detached: true,
      env: {
        PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
      },
    },
  );
  /* unref so the sleeper does not keep the bridge from exiting if the
   * caller forgets to kill it; we still own the pgrp via sleeper.pid. */
  sleeper.unref();
  return sleeper;
}

/**
 * Spawn a command inside a project's persistent namespace via the daemon's
 * ENTER opcode. Throws if isolation is unavailable, the namespace is not
 * pre-staged, or the daemon connection fails — no fallback path.
 *
 * @param project  Project slug (null = skip namespace for global commands).
 * @param command  Binary to exec inside the namespace.
 * @param args     Command arguments.
 * @param options  Spawn options (env, cwd, stdio, adapterScope, …).
 */
export function spawnInNamespace(
  project: string | null | undefined,
  command: string,
  args: string[],
  options: NamespaceSpawnOptions = {},
): ChildProcess {
  if (!project) {
    return spawn(command, args, options);
  }
  if (PLATFORM === 'darwin') {
    throw new Error(`macOS project isolation not yet implemented — refusing to spawn "${command}" for project "${project}"`);
  }
  if (!isNamespaceAvailable()) {
    throw new Error(`nsd admin socket missing at ${NSD_ADMIN_SOCK} — refusing to spawn "${command}" for project "${project}"`);
  }
  if (!isSeccompAvailable()) {
    throw new Error(`Seccomp binary missing at ${SECCOMP_BIN} — refusing to spawn "${command}" for project "${project}" without syscall filter`);
  }
  if (!isSandboxId(project)) {
    throw new Error(`[Namespace] Invalid project slug "${project}" — expected sbx-{7char} format`);
  }
  if (!isNamespaceRunning(project)) {
    throw new Error(
      `Namespace anchor for ${project} is not running — call setupNamespace(${project}) before spawning`,
    );
  }

  const startedAt = Date.now();
  const spawnId = `${process.pid}-${startedAt.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

  let scopeAnchor: ChildProcess | null = null;
  let targetCgroup: string | undefined;
  if (options.adapterScope) {
    /* Compute path first so a malformed scope id throws before we spawn
     * the sleeper. computeAdapterScopeCgroup runs the same allowlist
     * regex the daemon enforces. */
    targetCgroup = computeAdapterScopeCgroup(project, options.adapterScope);
    scopeAnchor = spawnAdapterScopeAnchor(project, options.adapterScope);
    logEvent('ns.adapter-scope.materialize', {
      spawnId,
      project,
      adapter: options.adapterScope.adapter,
      scopeId: options.adapterScope.scopeId,
      targetCgroup,
      anchorPid: scopeAnchor.pid ?? null,
    });
  }

  let childlike: ReturnType<typeof EllulNamespacedClient.enter>;
  try {
    childlike = EllulNamespacedClient.enter(project, [command, ...args], {
      env: options.env || process.env,
      cwd: typeof options.cwd === 'string' ? options.cwd : undefined,
      ...(targetCgroup ? { targetCgroup } : {}),
    });
  } catch (err) {
    if (scopeAnchor && scopeAnchor.pid) {
      try { process.kill(-scopeAnchor.pid, 'SIGKILL'); } catch { /* ignore */ }
    }
    throw err;
  }

  const argvSummary = args.slice(0, 16).map((a) =>
    a.length > 64 ? a.slice(0, 64) + `…[+${a.length - 64}]` : a,
  );
  logEvent('cli.spawn', {
    spawnId,
    project,
    command,
    argv: argvSummary,
    argvLen: args.length,
    threadId: options.threadId || null,
    cwd: options.cwd || null,
    adapterScope: options.adapterScope
      ? {
          adapter: options.adapterScope.adapter,
          scopeId: options.adapterScope.scopeId,
          softHintMB: options.adapterScope.softHintMB,
        }
      : null,
  });

  const reapAnchor = (reason: string) => {
    if (!scopeAnchor) return;
    const anchorPid = scopeAnchor.pid;
    scopeAnchor = null;
    if (!anchorPid || anchorPid <= 0) return;
    try {
      process.kill(-anchorPid, 'SIGKILL');
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH') {
        logEvent('ns.adapter-scope.reap-error', {
          spawnId, project, anchorPid, reason, ...serializeError(err),
        });
      }
    }
  };

  childlike.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
    reapAnchor('exit');
    logEvent('cli.exit', {
      spawnId, project, command, code, signal,
      durationMs: Date.now() - startedAt,
    });
  });
  childlike.on('error', (err: Error) => {
    reapAnchor('error');
    logEvent('cli.spawnError', {
      spawnId, project, command,
      durationMs: Date.now() - startedAt,
      ...serializeError(err),
    });
  });

  /* NsdChildProcess is a structural subset of ChildProcess covering the
   * fields callers actually consume (pid, stdio, kill, exit/error events).
   * Cast through unknown — IPC-only fields (channel/send/disconnect) are
   * incompatible with namespaced spawns. */
  return childlike as unknown as ChildProcess;
}

/**
 * Spawn a command in the project's namespace with quiescence lock.
 *
 * Acquires the per-project lock before spawning, releases on process exit.
 * This prevents deferred shared mounts from injecting into a running process.
 * All namespace command execution should go through this function.
 */
export async function spawnInNamespaceLocked(
  project: string | null | undefined,
  command: string,
  args: string[],
  options: NamespaceSpawnOptions = {},
): Promise<ChildProcess> {
  if (!project) return spawnInNamespace(project, command, args, options);

  const release = await acquireProjectLock(project);
  const proc = spawnInNamespace(project, command, args, options);

  // Release lock when process exits (quiescence restored)
  const onDone = () => release();
  proc.on('close', onDone);
  proc.on('error', onDone);

  return proc;
}
