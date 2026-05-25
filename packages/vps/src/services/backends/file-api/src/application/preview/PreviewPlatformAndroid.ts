// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Android/PRoot preview platform — direct child_process spawn, no systemd.

import * as fs from 'fs';
import * as path from 'path';
import { execSync, spawn as cpSpawn, type ChildProcess } from 'child_process';
import { getAppPath } from '../../config';
import { resolvePortBindTimeoutMs } from '@vps/shared/constants';
import { readSpec } from '@vps/shared/preview-spec';
import type { PreviewPlatform, UnitStatus, UnitResult, FailedUnit, FrameworkDropinOpts } from './PreviewPlatform';

// ── Logging ──────────────────────────────────────────────────────────

function log(level: string, msg: string, ctx?: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, svc: 'preview', msg, ...ctx }));
}

// ── Process tracking ─────────────────────────────────────────────────

interface TrackedProcess {
  child: ChildProcess;
  port: number;
  logRing: string[];
}

const MAX_LOG_LINES = 200;
const processes = new Map<string, TrackedProcess>();
const adoptedPorts = new Map<string, number>();

// ── Port probing (cross-platform, no ss) ─────────────────────────────

function isPortListening(port: number): boolean {
  try {
    execSync(
      `node -e "const s=require('net').createConnection(${port},'127.0.0.1');s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1));s.setTimeout(1000,()=>process.exit(1))"`,
      { timeout: 3000, stdio: 'ignore' },
    );
    return true;
  } catch { return false; }
}

// ── Network interfaces shim (Vite crashes without it in proot) ───────

const NET_SHIM_PATH = '/tmp/.ellul-net-shim.js';
const NET_SHIM_CONTENT = 'const os=require("os");const _ni=os.networkInterfaces;os.networkInterfaces=function(){try{return _ni.call(os)}catch{return{lo:[{address:"127.0.0.1",netmask:"255.0.0.0",family:"IPv4",mac:"00:00:00:00:00:00",internal:true,cidr:"127.0.0.1/8"}]}}};';

function ensureNetShim(): void {
  if (!fs.existsSync(NET_SHIM_PATH)) {
    fs.writeFileSync(NET_SHIM_PATH, NET_SHIM_CONTENT);
  }
}

// ── Implementation ───────────────────────────────────────────────────

export class AndroidPreviewPlatform implements PreviewPlatform {
  readonly hasCgroups = false;
  readonly hasConnectionCounting = false;
  readonly hasPortScanning = false;

  escapeInstance(appDir: string): string {
    return appDir;
  }

  async startUnit(appDir: string): Promise<UnitResult> {
    const old = processes.get(appDir);
    if (old && !old.child.killed && old.child.exitCode === null) {
      try { old.child.kill('SIGTERM'); } catch {}
      processes.delete(appDir);
    }

    const appPath = getAppPath(appDir);
    if (!fs.existsSync(appPath)) {
      return { ok: false, error: `App path not found: ${appPath}` };
    }

    const portRegistryPath = path.join(process.env.HOME || '/home/dev', '.ellul', 'port-registry.json');
    let port = 4000;
    try {
      const reg = JSON.parse(fs.readFileSync(portRegistryPath, 'utf8'));
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

    const tracked: TrackedProcess = { child, port, logRing: [] };
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
    });

    return { ok: true };
  }

  async stopUnit(appDir: string, opts: { mode?: 'graceful' | 'immediate' } = {}): Promise<UnitResult> {
    const tracked = processes.get(appDir);
    if (!tracked) return { ok: true };
    const sig = opts.mode === 'immediate' ? 'SIGKILL' : 'SIGTERM';
    try { tracked.child.kill(sig); } catch {}
    processes.delete(appDir);
    return { ok: true };
  }

  async restartUnit(appDir: string): Promise<UnitResult> {
    await this.stopUnit(appDir);
    await new Promise<void>(r => setTimeout(r, 500));
    return this.startUnit(appDir);
  }

  async resetFailed(_appDir: string): Promise<void> {}

  adoptProcess(appDir: string, port: number): void {
    adoptedPorts.set(appDir, port);
  }

  async isActive(appDir: string): Promise<boolean> {
    const tracked = processes.get(appDir);
    if (tracked) return !tracked.child.killed && tracked.child.exitCode === null;
    const adopted = adoptedPorts.get(appDir);
    if (adopted) return isPortListening(adopted);
    return false;
  }

  async unitStatus(appDir: string): Promise<UnitStatus> {
    const tracked = processes.get(appDir);
    if (!tracked) {
      const adopted = adoptedPorts.get(appDir);
      if (adopted && isPortListening(adopted)) {
        return { ActiveState: 'active', SubState: 'running', Result: 'success', ExecMainStatus: '0', ActiveEnterTimestampMonotonic: 0 };
      }
      if (adopted) adoptedPorts.delete(appDir);
      return { ActiveState: 'inactive', SubState: 'dead', Result: 'success', ExecMainStatus: '0', ActiveEnterTimestampMonotonic: 0 };
    }
    const alive = !tracked.child.killed && tracked.child.exitCode === null;
    if (alive) {
      const portBound = isPortListening(tracked.port);
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
    return { ActiveState: 'inactive', SubState: 'dead', Result: 'success', ExecMainStatus: '0', ActiveEnterTimestampMonotonic: 0 };
  }

  async listActive(): Promise<string[]> {
    return [...processes.entries()]
      .filter(([, t]) => !t.child.killed && t.child.exitCode === null)
      .map(([d]) => d);
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
    return isPortListening(port) ? -1 : null;
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
