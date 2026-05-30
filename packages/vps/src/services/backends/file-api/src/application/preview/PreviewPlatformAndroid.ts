// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Android/PRoot preview platform — direct child_process spawn, no systemd.

import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import * as os from 'os';
import { engineSpawn, type EngineChild } from '../engine-spawn';
import { getAppPath, HOME } from '../../config';
import { readSpec } from '@vps/shared/preview-spec';
import type { PreviewPlatform, UnitStatus, UnitResult, FailedUnit, FrameworkDropinOpts } from './PreviewPlatform';

const PORT_REGISTRY_FILE = `${HOME}/.ellul/preview-ports.json`;

// ── Logging ──────────────────────────────────────────────────────────

function log(level: string, msg: string, ctx?: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, svc: 'preview', msg, ...ctx }));
}

// ── Process tracking ─────────────────────────────────────────────────

interface TrackedProcess {
  child: EngineChild;
  port: number;
  logRing: string[];
  startedAt: number;
}

const MAX_LOG_LINES = 200;
const processes = new Map<string, TrackedProcess>();
const adoptedPorts = new Map<string, number>();

// ── Crash tracking (circuit breaker) ─────────────────────────────────

interface CrashRecord {
  times: number[];
  backoffUntil: number;
}

const CRASH_WINDOW_MS = 60_000;
const CRASH_BACKOFF_SCHEDULE = [5_000, 15_000, 60_000];
const crashHistory = new Map<string, CrashRecord>();

// Runtime-OOM-loop breaker. On a memory-constrained device the dev server can
// start fine then get SIGKILL'd by the lowmemorykiller ~30s later; the exit is
// code=null signal=SIGKILL, which recordCrash's `code!==null` guard skips — so
// the reconciler restarts it forever, thrashing memory every ~30s and starving
// everything else (agent turns, the WebView). After OOM_LOOP_LIMIT SIGKILLs in
// OOM_LOOP_WINDOW_MS, back off hard so memory stabilizes.
const OOM_LOOP_WINDOW_MS = 5 * 60_000;
const OOM_LOOP_LIMIT = 4;
const OOM_LOOP_BACKOFF_MS = 10 * 60_000;
const oomKills = new Map<string, number[]>();

function recordCrash(appDir: string, code: number | null, signal: string | null): void {
  const now = Date.now();
  const record = crashHistory.get(appDir) || { times: [], backoffUntil: 0 };
  record.times = record.times.filter(t => now - t < CRASH_WINDOW_MS);
  record.times.push(now);

  const idx = Math.min(record.times.length - 1, CRASH_BACKOFF_SCHEDULE.length - 1);
  record.backoffUntil = now + CRASH_BACKOFF_SCHEDULE[idx]!;
  crashHistory.set(appDir, record);

  log('warn', 'android: dev server crashed', {
    appDirectory: appDir,
    exitCode: code,
    signal,
    crashesInWindow: record.times.length,
    backoffMs: CRASH_BACKOFF_SCHEDULE[idx],
  });
}

function isInBackoff(appDir: string): boolean {
  const record = crashHistory.get(appDir);
  if (!record) return false;
  return Date.now() < record.backoffUntil;
}

function clearCrashHistory(appDir: string): void {
  crashHistory.delete(appDir);
}

// ── Port probing (native TCP connect, no subprocess) ────────────────

function isPortListening(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const sock = new net.Socket();
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => { sock.destroy(); resolve(false); });
    sock.setTimeout(800, () => { sock.destroy(); resolve(false); });
    sock.connect(port, '127.0.0.1');
  });
}

// ── Port registry reader (same file Preview.ts writes) ─────────────

function readPortFromRegistry(appDir: string): number | null {
  try {
    const reg = JSON.parse(fs.readFileSync(PORT_REGISTRY_FILE, 'utf8'));
    const port = reg[appDir];
    return typeof port === 'number' && port > 0 ? port : null;
  } catch { return null; }
}

// ── Synchronous port check via /proc/net/tcp ────────────────────────

function isPortListeningSync(port: number): boolean {
  try {
    const hex = port.toString(16).toUpperCase().padStart(4, '0');
    const data = fs.readFileSync('/proc/net/tcp', 'utf8');
    for (const line of data.split('\n')) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4) continue;
      const [, localAddr, , state] = cols;
      if (state !== '0A') continue; // 0A = LISTEN
      const addrPort = localAddr!.split(':')[1];
      if (addrPort === hex) return true;
    }
  } catch {}
  return false;
}

// ── Network interfaces shim (Vite crashes without it in proot) ───────

const NET_SHIM_PATH = '/tmp/.ellul-net-shim.js';
const NET_SHIM_CONTENT = 'const os=require("os");const _ni=os.networkInterfaces;os.networkInterfaces=function(){try{return _ni.call(os)}catch{return{lo:[{address:"127.0.0.1",netmask:"255.0.0.0",family:"IPv4",mac:"00:00:00:00:00:00",internal:true,cidr:"127.0.0.1/8"}]}}};';

function ensureNetShim(): void {
  if (!fs.existsSync(NET_SHIM_PATH)) {
    fs.writeFileSync(NET_SHIM_PATH, NET_SHIM_CONTENT);
  }
}

// ── process.cwd() (no OS chdir in proot) ─────────────────────────────
// The engine spawns from its own cwd (/home/dev) — it cannot chdir() into the
// project dir (chdir/fork are ENOSYS under proot). The project dir is injected at
// the Node layer by the engine's #!node launcher (NODE_LAUNCH): when ELLUL_FAKE_CWD
// is set it patches process.cwd() to return that dir AFTER node bootstrap, so next/
// vite see the project as cwd. No --require preload is used here — that would call
// uv_cwd in loadPreloadModules before the launcher runs and crash (ENOSYS). The
// net-shim is instead loaded via _ELLUL_LAUNCH_REQUIRE (cwd-safe, post-patch).

// ── Dev-command resolution (avoid `sh -c` shebang exec) ──────────────
// The dev binary (next/vite/etc) is a `#!/usr/bin/env node` shebang script in
// node_modules/.bin. Running it via `sh -c "next dev …"` makes sh exec the
// shebang, which under proot tries to exec `/usr/bin/env` — unavailable — so the
// spawn fails as "spawn ENOSYS" (git works only because `git` is a real ELF
// binary sh execs directly). Instead, resolve the binary to its real path and
// hand it to the engine as the spawn `cmd`: the engine's adapter.spawn already
// shebang-resolves `#!node` scripts to `node + the cwd launcher`, bypassing
// `/usr/bin/env` AND `sh` entirely — the exact path cursor/grok/claude take.
// Returns null for anything with shell syntax we can't safely tokenize (the
// caller then falls back to `sh -c`).
function resolveDevCommand(
  startCmd: string,
  appPath: string,
): { cmd: string; args: string[] } | null {
  // Bail on shell metacharacters — those genuinely need a shell.
  if (/[|&;<>(){}$`*?\[\]\\'"]/.test(startCmd)) return null;
  const tokens = startCmd.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const [bin, ...rest] = tokens;
  // Resolve the binary against the app's node_modules/.bin (where PATH points),
  // then PATH. Only rewrite when we find a real shebang script — otherwise the
  // engine's own shebang sniff on a bare name would not find the file.
  const candidates = [
    path.join(appPath, 'node_modules', '.bin', bin!),
    ...(process.env.PATH || '').split(':').filter(Boolean).map(d => path.join(d, bin!)),
  ];
  for (const c of candidates) {
    try {
      if (!fs.existsSync(c)) continue;
      const fd = fs.openSync(c, 'r');
      const hb = Buffer.alloc(64);
      const n = fs.readSync(fd, hb, 0, 64, 0);
      fs.closeSync(fd);
      const head = hb.subarray(0, n).toString('utf8');
      if (head.startsWith('#!')) {
        // A real shebang script the engine can resolve to its interpreter.
        return { cmd: c, args: rest };
      }
      // A real binary — engine execs it directly, also fine.
      return { cmd: c, args: rest };
    } catch { /* try next candidate */ }
  }
  return null;
}

// ── Dynamic memory budget ────────────────────────────────────────────

export function computeAndroidBudget(): {
  physicalMB: number;
  reservedMB: number;
  previewBudgetMB: number;
  perPreviewCapMB: number;
  perPreviewHighMB: number;
  maxConcurrent: number;
  slicePercent: number;
} {
  const physicalMB = Math.round(os.totalmem() / (1024 * 1024));
  if (physicalMB < 3072) {
    return { physicalMB, reservedMB: 256, previewBudgetMB: 512, perPreviewCapMB: 512, perPreviewHighMB: 400, maxConcurrent: 1, slicePercent: 50 };
  }
  if (physicalMB < 6144) {
    return { physicalMB, reservedMB: 512, previewBudgetMB: 1536, perPreviewCapMB: 1536, perPreviewHighMB: 1200, maxConcurrent: 1, slicePercent: 70 };
  }
  const perPreviewCapMB = Math.round((physicalMB * 0.6) / 2);
  return { physicalMB, reservedMB: 512, previewBudgetMB: physicalMB - 512, perPreviewCapMB, perPreviewHighMB: Math.round(perPreviewCapMB * 0.85), maxConcurrent: 2, slicePercent: 70 };
}

// ── Implementation ───────────────────────────────────────────────────

export class AndroidPreviewPlatform implements PreviewPlatform {
  readonly hasCgroups = false;
  readonly hasConnectionCounting = false;
  readonly hasPortScanning = false;

  private readonly adoptionReady: Promise<void>;

  constructor() {
    this.adoptionReady = this.adoptSurvivors();
  }

  private async adoptSurvivors(): Promise<void> {
    try {
      const reg = JSON.parse(fs.readFileSync(PORT_REGISTRY_FILE, 'utf8')) as Record<string, number>;
      for (const [dir, port] of Object.entries(reg)) {
        if (typeof port !== 'number' || port <= 0) continue;
        if (await isPortListening(port)) {
          adoptedPorts.set(dir, port);
          log('info', 'android: adopted surviving process', { appDirectory: dir, port });
        }
      }
    } catch {}
  }

  escapeInstance(appDir: string): string {
    return appDir;
  }

  async startUnit(appDir: string): Promise<UnitResult> {
    if (isInBackoff(appDir)) {
      const record = crashHistory.get(appDir)!;
      const waitMs = record.backoffUntil - Date.now();
      return { ok: false, error: `Crash backoff: ${record.times.length} crashes in 60s, retry in ${Math.ceil(waitMs / 1000)}s` };
    }

    const old = processes.get(appDir);
    if (old && !old.child.killed && old.child.exitCode === null) {
      // Engine owns the process; closing the proxy socket via kill() reaps it.
      // No process.kill(-pid) group-kill (the child isn't ours to signal).
      try { old.child.kill('SIGTERM'); } catch {}
      processes.delete(appDir);
    }

    const appPath = getAppPath(appDir);
    if (!fs.existsSync(appPath)) {
      return { ok: false, error: `App path not found: ${appPath}` };
    }

    let port = 4000;
    try {
      const reg = JSON.parse(fs.readFileSync(PORT_REGISTRY_FILE, 'utf8'));
      if (reg[appDir]) port = reg[appDir];
    } catch {}

    const spec = readSpec(appPath);
    if (!spec?.start) {
      return { ok: false, error: 'No preview spec found' };
    }

    const startCmd = spec.start
      .replace(/\$PORT\b/g, String(port))
      .replace(/\$HOST\b/g, '0.0.0.0');

    ensureNetShim();

    // Resolve the dev binary to a real path so the engine spawns it directly
    // (its adapter.spawn shebang-resolves #!node → node + cwd launcher). Falls
    // back to `sh -c` for shell-syntax commands. `sh -c "next dev"` is what hit
    // "spawn ENOSYS": sh exec'd the #!/usr/bin/env node shebang and proot has no
    // /usr/bin/env. See resolveDevCommand().
    const resolved = resolveDevCommand(startCmd, appPath);
    const spawnCmd = resolved ? resolved.cmd : 'sh';
    const spawnArgs = resolved ? resolved.args : ['-c', startCmd];

    log('info', 'android: spawning dev server', {
      appDirectory: appDir, startCmd, port, spawnCmd, resolved: !!resolved,
    });

    // Spawn is delegated to the in-proot engine (file-api can't fork() inside
    // the Android zygote sandbox — see engine-spawn.ts). The returned EngineChild
    // is backed by the engine's per-spawn proxy socket; the engine owns the OS
    // process, so there is no detached process group to manage here.
    //
    // NO cwd is passed: a foreign cwd forces the engine's chdir/fork path, which
    // is ENOSYS under proot. The project dir is injected without an OS chdir via
    // ELLUL_FAKE_CWD, consumed by the engine's #!node launcher (NODE_LAUNCH) which
    // patches process.cwd to the project dir AFTER node bootstrap.
    //
    // We do NOT use NODE_OPTIONS=--require: node resolves --require paths via
    // process.cwd() inside loadPreloadModules, BEFORE any user code runs — and
    // uv_cwd is ENOSYS in this proot/seccomp context, so the preload itself
    // crashes ("ENOSYS: uv_cwd" at loadPreloadModules) before the launcher can
    // patch cwd. Instead the net-shim is loaded via _ELLUL_LAUNCH_REQUIRE, which
    // the launcher require()s AFTER patching process.cwd (cwd-safe).
    //
    // The cwd-shim is no longer injected here — the launcher patches cwd directly.
    //
    // NOTE: _ELLUL_LAUNCH_REQUIRE / ELLUL_FAKE_CWD are only consumed when the dev
    // command resolved to a #!node script (resolveDevCommand → the engine's #!node
    // branch builds the launcher). When resolveDevCommand returns null (shell-syntax
    // `sh -c` fallback) there is no launcher, so neither var is honored and Vite's
    // os.networkInterfaces shim is absent — an acceptable degraded path. next/vite
    // and the common dev binaries all resolve, so the typical case is covered.
    const child = await engineSpawn(spawnCmd, spawnArgs, {
      env: {
        ...(process.env as Record<string, string>),
        PORT: String(port),
        HOST: '0.0.0.0',
        NODE_ENV: 'development',
        HOME: process.env.HOME || '/home/dev',
        ELLUL_FAKE_CWD: appPath,
        _ELLUL_LAUNCH_REQUIRE: NET_SHIM_PATH,
        PATH: `${appPath}/node_modules/.bin:${process.env.PATH}`,
        ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}),
      },
    });

    const tracked: TrackedProcess = { child, port, logRing: [], startedAt: Date.now() };
    processes.set(appDir, tracked);

    const appendLog = (d: Buffer) => {
      const lines = d.toString().trimEnd().split('\n');
      for (const line of lines) {
        tracked.logRing.push(line);
        if (tracked.logRing.length > MAX_LOG_LINES) tracked.logRing.shift();
      }
      log('debug', `[dev:${appDir}] ${d.toString().trimEnd()}`);
    };
    child.stdout?.on('data', appendLog);
    child.stderr?.on('data', appendLog);

    child.on('exit', (code, signal) => {
      log('info', 'android: dev server exited', { appDirectory: appDir, code, signal });
      const uptime = Date.now() - tracked.startedAt;
      if (signal === 'SIGKILL') {
        // OOM-kill (lowmemorykiller). Track the loop; trip a hard backoff once
        // it's clearly unviable so the reconciler stops restarting it.
        const now = Date.now();
        const kills = (oomKills.get(appDir) ?? []).filter(t => now - t < OOM_LOOP_WINDOW_MS);
        kills.push(now);
        oomKills.set(appDir, kills);
        if (kills.length >= OOM_LOOP_LIMIT) {
          const rec = crashHistory.get(appDir) ?? { times: [], backoffUntil: 0 };
          rec.backoffUntil = now + OOM_LOOP_BACKOFF_MS;
          crashHistory.set(appDir, rec);
          log('warn', 'android: dev server OOM-loop — pausing auto-restart', {
            appDirectory: appDir,
            oomKillsInWindow: kills.length,
            backoffMs: OOM_LOOP_BACKOFF_MS,
          });
        }
      } else if (code !== 0 && code !== null && uptime < CRASH_WINDOW_MS) {
        recordCrash(appDir, code, signal);
      } else if (code === 0) {
        clearCrashHistory(appDir);
        oomKills.delete(appDir);
      }
    });

    clearCrashHistory(appDir);
    return { ok: true };
  }

  async stopUnit(appDir: string, opts: { mode?: 'graceful' | 'immediate' } = {}): Promise<UnitResult> {
    const tracked = processes.get(appDir);
    if (!tracked) {
      const adopted = adoptedPorts.get(appDir);
      if (adopted) adoptedPorts.delete(appDir);
      return { ok: true };
    }
    const sig = opts.mode === 'immediate' ? 'SIGKILL' : 'SIGTERM';
    // Engine owns the process; kill() closes the proxy socket and the engine
    // reaps the child. No process.kill(-pid) group-kill is possible here.
    try { tracked.child.kill(sig); } catch {}
    processes.delete(appDir);
    clearCrashHistory(appDir);
    return { ok: true };
  }

  async restartUnit(appDir: string): Promise<UnitResult> {
    await this.stopUnit(appDir);
    await new Promise<void>(r => setTimeout(r, 500));
    return this.startUnit(appDir);
  }

  async resetFailed(appDir: string): Promise<void> {
    clearCrashHistory(appDir);
  }

  adoptProcess(appDir: string, port: number): void {
    adoptedPorts.set(appDir, port);
  }

  async isActive(appDir: string): Promise<boolean> {
    await this.adoptionReady;
    const tracked = processes.get(appDir);
    if (tracked) return !tracked.child.killed && tracked.child.exitCode === null;
    const adopted = adoptedPorts.get(appDir);
    if (adopted) return isPortListening(adopted);
    const registryPort = readPortFromRegistry(appDir);
    if (registryPort && await isPortListening(registryPort)) {
      adoptedPorts.set(appDir, registryPort);
      return true;
    }
    return false;
  }

  async unitStatus(appDir: string): Promise<UnitStatus> {
    await this.adoptionReady;
    const tracked = processes.get(appDir);
    if (tracked) {
      const alive = !tracked.child.killed && tracked.child.exitCode === null;
      if (alive) {
        const portBound = await isPortListening(tracked.port);
        return {
          ActiveState: portBound ? 'active' : 'activating',
          SubState: portBound ? 'running' : 'start',
          Result: 'success',
          ExecMainStatus: '0',
          ActiveEnterTimestampMonotonic: 0,
        };
      }
      const code = tracked.child.exitCode;
      if (code !== null && code !== 0) {
        return { ActiveState: 'failed', SubState: 'failed', Result: 'exit-code', ExecMainStatus: String(code), ActiveEnterTimestampMonotonic: 0 };
      }
    }

    const adopted = adoptedPorts.get(appDir);
    if (adopted && await isPortListening(adopted)) {
      return { ActiveState: 'active', SubState: 'running', Result: 'success', ExecMainStatus: '0', ActiveEnterTimestampMonotonic: 0 };
    }
    if (adopted) adoptedPorts.delete(appDir);

    const registryPort = readPortFromRegistry(appDir);
    if (registryPort && await isPortListening(registryPort)) {
      adoptedPorts.set(appDir, registryPort);
      log('info', 'android: late-adopted process via port probe', { appDirectory: appDir, port: registryPort });
      return { ActiveState: 'active', SubState: 'running', Result: 'success', ExecMainStatus: '0', ActiveEnterTimestampMonotonic: 0 };
    }

    return { ActiveState: 'inactive', SubState: 'dead', Result: 'success', ExecMainStatus: '0', ActiveEnterTimestampMonotonic: 0 };
  }

  async listActive(): Promise<string[]> {
    await this.adoptionReady;
    const active = new Set<string>();
    for (const [d, t] of processes) {
      if (!t.child.killed && t.child.exitCode === null) active.add(d);
    }
    for (const [d, port] of adoptedPorts) {
      if (await isPortListening(port)) active.add(d);
      else adoptedPorts.delete(d);
    }
    try {
      const reg = JSON.parse(fs.readFileSync(PORT_REGISTRY_FILE, 'utf8')) as Record<string, number>;
      for (const [dir, port] of Object.entries(reg)) {
        if (active.has(dir) || typeof port !== 'number' || port <= 0) continue;
        if (await isPortListening(port)) {
          adoptedPorts.set(dir, port);
          active.add(dir);
        }
      }
    } catch {}
    return [...active];
  }

  async writeFrameworkDropin(_appDir: string, _opts: FrameworkDropinOpts): Promise<UnitResult> {
    return { ok: true };
  }

  async clearFrameworkDropin(_appDir: string): Promise<UnitResult> {
    return { ok: true };
  }

  getPidOnPort(port: number): number | null {
    for (const [, tracked] of processes) {
      if (tracked.port === port && !tracked.child.killed && tracked.child.exitCode === null) {
        return tracked.child.pid ?? -1;
      }
    }
    for (const [, adoptedPort] of adoptedPorts) {
      if (adoptedPort === port) return -1;
    }
    return isPortListeningSync(port) ? -1 : null;
  }

  countEstablishedConnections(_port: number): number {
    return 0;
  }

  detectMismatchedPort(_appDirectory: string, _expectedPort: number): number | null {
    return null;
  }

  async readJournalTail(appDirectory: string, lines = 40): Promise<string> {
    const tracked = processes.get(appDirectory);
    if (!tracked) return '';
    return tracked.logRing.slice(-lines).join('\n');
  }

  listFailedUnits(): FailedUnit[] {
    const failed: FailedUnit[] = [];
    for (const [dir, tracked] of processes) {
      if (tracked.child.exitCode !== null && tracked.child.exitCode !== 0) {
        failed.push({ instance: dir, result: 'exit-code' });
      }
    }
    return failed;
  }
}
