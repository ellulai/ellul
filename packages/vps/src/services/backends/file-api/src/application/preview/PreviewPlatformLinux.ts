// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Linux/VPS preview platform — systemd units, ss socket inspection, cgroup monitoring.

import { execFile as execFileCb, execFileSync, execSync } from 'child_process';
import * as fs from 'fs';
import { promisify } from 'util';
import type { PreviewPlatform, UnitStatus, UnitResult, FailedUnit, FrameworkDropinOpts } from './PreviewPlatform';

const execFile = promisify(execFileCb);
const CTL_BIN = '/usr/local/bin/ellul-preview-ctl';

// ── Instance escaping ────────────────────────────────────────────────

function escapeInstanceImpl(appDir: string): string {
  try {
    return execFileSync('/usr/bin/systemd-escape', ['--', appDir], {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
  } catch {
    const hex = (b: number) => b.toString(16).padStart(2, '0');
    const buf = Buffer.from(appDir, 'utf8');
    let out = '';
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i]!;
      const ch = String.fromCharCode(b);
      if (ch === '/') { out += '-'; continue; }
      if (/[A-Za-z0-9:_.]/.test(ch)) { out += ch; continue; }
      out += `\\x${hex(b)}`;
    }
    if (out.startsWith('.')) out = `\\x2e${out.slice(1)}`;
    return out;
  }
}

function unescapeInstance(inst: string): string {
  try {
    return execFileSync('/usr/bin/systemd-escape', ['--unescape', '--', inst], {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
  } catch {
    return inst
      .replace(/\\x([0-9a-fA-F]{2})/g, (_, hh) => String.fromCharCode(parseInt(hh, 16)))
      .replace(/-/g, '/');
  }
}

// ── preview-ctl helper ───────────────────────────────────────────────

async function runCtl(
  action: string,
  appDir: string,
  extraArgs: string[] = [],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const inst = escapeInstanceImpl(appDir);
  try {
    const { stdout, stderr } = await execFile(
      'sudo',
      ['-n', CTL_BIN, action, inst, ...extraArgs],
      { timeout: 20_000, maxBuffer: 1024 * 256 },
    );
    return { stdout, stderr, code: 0 };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    const code = typeof err.code === 'number' ? err.code : 1;
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? err.message ?? '',
      code,
    };
  }
}

function readPidOnPortViaSs(port: number): number | null {
  try {
    const out = execSync(`ss -tlnp 'sport = :${port}'`, { encoding: 'utf8', timeout: 2000 });
    const m = out.match(/pid=(\d+)/);
    return m?.[1] ? parseInt(m[1], 10) : null;
  } catch { return null; }
}

// ── Implementation ───────────────────────────────────────────────────

export class LinuxPreviewPlatform implements PreviewPlatform {
  readonly hasCgroups = true;
  readonly hasConnectionCounting = true;
  readonly hasPortScanning = true;

  adoptProcess(_appDir: string, _port: number): void {}

  escapeInstance(appDir: string): string {
    return escapeInstanceImpl(appDir);
  }

  async startUnit(appDir: string): Promise<UnitResult> {
    const r = await runCtl('start', appDir);
    return r.code === 0 ? { ok: true } : { ok: false, error: (r.stderr || r.stdout).trim() };
  }

  async stopUnit(appDir: string, opts: { mode?: 'graceful' | 'immediate' } = {}): Promise<UnitResult> {
    const action = opts.mode === 'immediate' ? 'kill' : 'stop';
    const r = await runCtl(action, appDir);
    return r.code === 0 ? { ok: true } : { ok: false, error: (r.stderr || r.stdout).trim() };
  }

  async restartUnit(appDir: string): Promise<UnitResult> {
    await runCtl('reset-failed', appDir);
    const r = await runCtl('restart', appDir);
    return r.code === 0 ? { ok: true } : { ok: false, error: (r.stderr || r.stdout).trim() };
  }

  async resetFailed(appDir: string): Promise<void> {
    await runCtl('reset-failed', appDir);
  }

  async isActive(appDir: string): Promise<boolean> {
    const r = await runCtl('is-active', appDir);
    return r.code === 0;
  }

  async unitStatus(appDir: string): Promise<UnitStatus> {
    const inst = escapeInstanceImpl(appDir);
    const unit = `ellul-preview@${inst}.service`;
    try {
      const { stdout } = await execFile(
        '/bin/systemctl',
        ['show', '-p', 'ActiveState,SubState,Result,ExecMainStatus,ActiveEnterTimestampMonotonic', '--no-pager', unit],
        { timeout: 5_000, maxBuffer: 1024 * 64 },
      );
      const out: Record<string, string> = {};
      for (const line of stdout.split('\n')) {
        const idx = line.indexOf('=');
        if (idx < 0) continue;
        out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
      return {
        ActiveState: out.ActiveState || 'unknown',
        SubState: out.SubState || 'unknown',
        Result: out.Result || 'success',
        ExecMainStatus: out.ExecMainStatus || '0',
        ActiveEnterTimestampMonotonic: parseInt(out.ActiveEnterTimestampMonotonic || '0', 10) || 0,
      };
    } catch {
      return { ActiveState: 'unknown', SubState: 'unknown', Result: 'unknown', ExecMainStatus: '0', ActiveEnterTimestampMonotonic: 0 };
    }
  }

  async listActive(): Promise<string[]> {
    try {
      const { stdout } = await execFile(
        '/bin/systemctl',
        ['list-units', '--type=service', '--state=active', '--no-legend', '--no-pager', 'ellul-preview@*.service'],
        { timeout: 10_000, maxBuffer: 1024 * 256 },
      );
      const apps: string[] = [];
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const match = trimmed.match(/^ellul-preview@(.+)\.service(?:\s|$)/);
        if (!match) continue;
        apps.push(unescapeInstance(match[1]!));
      }
      return apps;
    } catch { return []; }
  }

  async writeFrameworkDropin(appDir: string, opts: FrameworkDropinOpts): Promise<UnitResult> {
    const fmt = (n: number | null): string =>
      n === null || n === undefined ? '' : String(Math.max(0, Math.floor(n)));
    const args = [fmt(opts.memoryHighMB), fmt(opts.memoryMaxMB), fmt(opts.tasksMax), fmt(opts.cpuQuotaPercent)];
    const r = await runCtl('dropin', appDir, args);
    return r.code === 0 ? { ok: true } : { ok: false, error: (r.stderr || r.stdout).trim() };
  }

  async clearFrameworkDropin(appDir: string): Promise<UnitResult> {
    const r = await runCtl('clear-dropin', appDir);
    return r.code === 0 ? { ok: true } : { ok: false, error: (r.stderr || r.stdout).trim() };
  }

  getPidOnPort(port: number): number | null {
    return readPidOnPortViaSs(port);
  }

  countEstablishedConnections(port: number): number {
    try {
      const out = execSync(`ss -tnH state established sport = :${port}`, { encoding: 'utf8', timeout: 1000 });
      if (!out) return 0;
      return out.split('\n').filter(l => l.trim().length > 0).length;
    } catch { return 0; }
  }

  detectMismatchedPort(appDirectory: string, expectedPort: number): number | null {
    try {
      const inst = escapeInstanceImpl(appDirectory);
      const unit = `ellul-preview@${inst}.service`;
      const mainPidStr = execFileSync(
        'systemctl', ['show', unit, '--property=MainPID', '--value'],
        { encoding: 'utf8', timeout: 3000 },
      ).trim();
      const mainPid = parseInt(mainPidStr, 10);
      if (!mainPid || mainPid <= 1) return null;

      let unitPids = new Set<number>([mainPid]);
      try {
        const cgroupLine = fs.readFileSync(`/proc/${mainPid}/cgroup`, 'utf8');
        const m = cgroupLine.match(/0::(.+)/);
        if (m?.[1]) {
          const procsPath = `/sys/fs/cgroup${m[1].trim()}/cgroup.procs`;
          const procs = fs.readFileSync(procsPath, 'utf8').trim().split('\n');
          unitPids = new Set(procs.map(Number).filter(Boolean));
        }
      } catch {}

      const ssOut = execSync('ss -tlnp', { encoding: 'utf8', timeout: 3000 });
      for (const line of ssOut.split('\n')) {
        const portMatch = line.match(/:(\d+)\s/);
        const pidMatch = line.match(/pid=(\d+)/);
        if (!portMatch || !pidMatch) continue;
        const listenPort = parseInt(portMatch[1]!, 10);
        const listenPid = parseInt(pidMatch[1]!, 10);
        if (listenPort === expectedPort) continue;
        if (listenPort < 1024) continue;
        if (unitPids.has(listenPid)) return listenPort;
      }
      return null;
    } catch { return null; }
  }

  async readJournalTail(appDirectory: string, lines = 40): Promise<string> {
    try {
      const inst = escapeInstanceImpl(appDirectory);
      const unit = `ellul-preview@${inst}.service`;
      const { stdout } = await execFile(
        '/bin/journalctl',
        ['-u', unit, '-n', String(lines), '--no-pager', '-o', 'cat'],
        { timeout: 5_000, maxBuffer: 1024 * 128 },
      );
      const trimmed = stdout.length > 4096 ? stdout.slice(-4096) : stdout;
      return trimmed.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    } catch { return ''; }
  }

  listFailedUnits(): FailedUnit[] {
    let out: string;
    try {
      out = execSync(
        'systemctl list-units --all --plain --no-legend --state=failed --type=service "ellul-preview@*"',
        { encoding: 'utf8', timeout: 3000 },
      );
    } catch { return []; }
    const units: FailedUnit[] = [];
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      const unit = parts[0];
      if (!unit || !unit.startsWith('ellul-preview@')) continue;
      const m = unit.match(/^ellul-preview@(.+?)\.service$/);
      if (!m) continue;
      units.push({ instance: unescapeInstance(m[1]!), result: parts[3] ?? 'failed' });
    }
    return units;
  }
}
