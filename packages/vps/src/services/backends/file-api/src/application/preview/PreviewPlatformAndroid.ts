// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Android/PRoot preview platform — direct child_process spawn, no systemd.

import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import * as os from 'os';
import { spawn as cpSpawn, type ChildProcess } from 'child_process';
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
  child: ChildProcess;
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
      const pid = old.child.pid;
      if (pid) { try { process.kill(-pid, 'SIGTERM'); } catch {} }
      else { try { old.child.kill('SIGTERM'); } catch {} }
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

    log('info', 'android: spawning dev server', { appDirectory: appDir, startCmd, port });

    const child = cpSpawn('sh', ['-c', startCmd], {
      cwd: appPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '0.0.0.0',
        NODE_ENV: 'development',
        HOME: process.env.HOME || '/home/dev',
        PATH: `${appPath}/node_modules/.bin:${process.env.PATH}`,
        NODE_OPTIONS: `--require ${NET_SHIM_PATH}${process.env.NODE_OPTIONS ? ' ' + process.env.NODE_OPTIONS : ''}`,
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
      if (code !== 0 && code !== null && uptime < CRASH_WINDOW_MS) {
        recordCrash(appDir, code, signal);
      } else if (code === 0) {
        clearCrashHistory(appDir);
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
    const pid = tracked.child.pid;
    if (pid) {
      try { process.kill(-pid, sig); } catch {}
    } else {
      try { tracked.child.kill(sig); } catch {}
    }
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
