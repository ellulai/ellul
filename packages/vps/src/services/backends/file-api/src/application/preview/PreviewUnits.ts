// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Per-preview systemd unit control.

import { execFile as execFileCb, execFileSync } from 'child_process';
import { promisify } from 'util';

const execFile = promisify(execFileCb);

const CTL_BIN = '/usr/local/bin/ellul-preview-ctl';

// Escape an app directory into a systemd unit instance name.
export function escapeInstance(appDir: string): string {
  try {
    const out = execFileSync('/usr/bin/systemd-escape', ['--', appDir], {
      encoding: 'utf8',
      timeout: 5000,
    });
    return out.trim();
  } catch (e) {
    // On systems without systemd-escape (shouldn't happen on prod Ubuntu,
    const hex = (b: number) => b.toString(16).padStart(2, '0');
    const buf = Buffer.from(appDir, 'utf8');
    let out = '';
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i]!;
      const ch = String.fromCharCode(b);
      if (ch === '/') {
        out += '-';
        continue;
      }
      if (/[A-Za-z0-9:_.]/.test(ch)) {
        out += ch;
        continue;
      }
      out += `\\x${hex(b)}`;
    }
    if (out.startsWith('.')) out = `\\x2e${out.slice(1)}`;
    // Silence the unused-var lint — `e` is captured only so we can keep
    void e;
    return out;
  }
}

async function runCtl(
  action: string,
  appDir: string,
  extraArgs: string[] = [],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const inst = escapeInstance(appDir);
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

// Write a framework-aware systemd drop-in at
export async function writeFrameworkDropin(
  appDir: string,
  opts: {
    memoryHighMB: number | null;
    memoryMaxMB: number | null;
    tasksMax: number | null;
    cpuQuotaPercent: number | null;
  },
): Promise<{ ok: boolean; error?: string }> {
  const fmt = (n: number | null): string =>
    n === null || n === undefined ? '' : String(Math.max(0, Math.floor(n)));
  const args = [
    fmt(opts.memoryHighMB),
    fmt(opts.memoryMaxMB),
    fmt(opts.tasksMax),
    fmt(opts.cpuQuotaPercent),
  ];
  const r = await runCtl('dropin', appDir, args);
  return r.code === 0 ? { ok: true } : { ok: false, error: (r.stderr || r.stdout).trim() };
}

export async function clearFrameworkDropin(appDir: string): Promise<{ ok: boolean; error?: string }> {
  const r = await runCtl('clear-dropin', appDir);
  return r.code === 0 ? { ok: true } : { ok: false, error: (r.stderr || r.stdout).trim() };
}

export async function startUnit(appDir: string): Promise<{ ok: boolean; error?: string }> {
  const r = await runCtl('start', appDir);
  return r.code === 0 ? { ok: true } : { ok: false, error: (r.stderr || r.stdout).trim() };
}

// mode: 'graceful'  → systemctl stop — SIGTERM, wait `TimeoutStopSec`,
// memory pressure: waiting out a graceful close
export async function stopUnit(
  appDir: string,
  opts: { mode?: 'graceful' | 'immediate' } = {},
): Promise<{ ok: boolean; error?: string }> {
  const action = opts.mode === 'immediate' ? 'kill' : 'stop';
  const r = await runCtl(action, appDir);
  return r.code === 0 ? { ok: true } : { ok: false, error: (r.stderr || r.stdout).trim() };
}

// Shorthand for `stopUnit(appDir, { mode: 'immediate' })`. Kept as a
export async function killUnit(appDir: string): Promise<{ ok: boolean; error?: string }> {
  return stopUnit(appDir, { mode: 'immediate' });
}

export async function restartUnit(appDir: string): Promise<{ ok: boolean; error?: string }> {
  // Reset any prior failed state so StartLimitBurst doesn't keep a crashed
  await runCtl('reset-failed', appDir);
  const r = await runCtl('restart', appDir);
  return r.code === 0 ? { ok: true } : { ok: false, error: (r.stderr || r.stdout).trim() };
}

export async function resetFailed(appDir: string): Promise<void> {
  await runCtl('reset-failed', appDir);
}

export async function isActive(appDir: string): Promise<boolean> {
  const r = await runCtl('is-active', appDir);
  return r.code === 0;
}

// Low-level systemd state — used by the health endpoint to surface
export async function unitStatus(
  appDir: string,
): Promise<{
  ActiveState: string;
  SubState: string;
  Result: string;
  ExecMainStatus: string;
  // 0 if the unit has never been active (or systemd hasn't reported it yet).
  ActiveEnterTimestampMonotonic: number;
}> {
  const inst = escapeInstance(appDir);
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
    return {
      ActiveState: 'unknown',
      SubState: 'unknown',
      Result: 'unknown',
      ExecMainStatus: '0',
      ActiveEnterTimestampMonotonic: 0,
    };
  }
}

// Enumerate every active preview unit → the unescaped app directory list.
export async function listActive(): Promise<string[]> {
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
  } catch {
    return [];
  }
}

// Reverse of escapeInstance — decodes a systemd-escaped instance name
function unescapeInstance(inst: string): string {
  try {
    const out = execFileSync('/usr/bin/systemd-escape', ['--unescape', '--', inst], {
      encoding: 'utf8',
      timeout: 5000,
    });
    return out.trim();
  } catch {
    return inst.replace(/\\x([0-9a-fA-F]{2})/g, (_, hh) => String.fromCharCode(parseInt(hh, 16))).replace(/-/g, '/');
  }
}

// /etc/systemd/system/ellul-preview@<instance>.service.d/ — never from the
