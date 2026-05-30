// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Android engine-delegated spawn helper for file-api.
//
// file-api runs inside proot on Android and cannot fork()/exec() (the zygote
// app-uid seccomp filter turns every clone/execve into "spawn ENOSYS"). All
// process spawning is delegated to the in-proot engine (PID 1's direct child,
// which CAN spawn) via a JSON-RPC call on 127.0.0.1:7710. The engine spawns the
// binary and opens a per-spawn TCP proxy port whose socket IS the child's stdio.
//
// This is the plain-async mirror of agent-bridge's android-engine-spawner
// (Effect-based, module-private, imports agent-bridge's logEvent). It is
// intentionally NOT imported from there to avoid cross-package coupling.
//
// glibc/proot tools only — file-api spawns `sh`/`git`/grep, all glibc, so we use
// the in-proot engine (7710) unconditionally. The static-musl Host (7720) routing
// in the agent-bridge spawner is not needed here.

import * as fs from 'node:fs';
import * as net from 'node:net';
import { EventEmitter } from 'node:events';

const ENGINE_SECRET_PATH = '/tmp/ellul-engine-secret';
const IN_PROOT_RPC_PORT = 7710;

function readSecret(): string {
  return fs.readFileSync(ENGINE_SECRET_PATH, 'utf8').trim();
}

interface SpawnResult {
  pid: number;
  proxyPort: number;
}

// The engine's own cwd. NEVER pass a different one: a foreign cwd forces the
// engine's spawn down the chdir/fork path, and BOTH chdir() and fork() are
// ENOSYS under this proot — the engine throws "spawn ENOSYS". The working dir
// must be supplied without an OS chdir (e.g. `git -C <dir>` for git, or a
// process.cwd() preload shim for node dev servers).
const ENGINE_CWD = '/home/dev';

// One RPC round-trip: ask the engine to spawn cmd, get back { pid, proxyPort }.
function rpcSpawn(
  cmd: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve, reject) => {
    let secret: string;
    try {
      secret = readSecret();
    } catch (e) {
      reject(e as Error);
      return;
    }
    if (!secret) {
      reject(new Error('engine spawn: no RPC secret'));
      return;
    }
    const conn = net.connect(IN_PROOT_RPC_PORT, '127.0.0.1');
    const timer = setTimeout(() => {
      try { conn.destroy(); } catch { /* noop */ }
      fail(new Error('engine spawn: RPC timeout'));
    }, 15_000);
    let buf = '';
    let settled = false;
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { conn.destroy(); } catch { /* noop */ }
      reject(e);
    };
    conn.on('connect', () => {
      conn.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          auth: secret,
          method: 'adapter.spawn',
          params: { cmd, args, env, cwd },
        }) + '\n',
      );
    });
    conn.on('data', (chunk: Buffer) => {
      if (settled) return;
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      try {
        const msg = JSON.parse(line);
        if (msg.error) {
          fail(new Error(msg.error?.message || String(msg.error)));
        } else if (msg.result && typeof msg.result.proxyPort === 'number') {
          settled = true;
          clearTimeout(timer);
          conn.end();
          resolve(msg.result as SpawnResult);
        } else {
          fail(new Error('engine spawn: malformed result'));
        }
      } catch (e) {
        fail(e as Error);
      }
    });
    conn.on('error', (e: Error) => fail(e));
  });
}

// Minimal ChildProcess-like surface used by PreviewPlatformAndroid:
//   pid, stdout.on('data'), stderr.on('data'), on('exit', (code, signal)),
//   kill(sig?), killed, exitCode. Backed by the engine proxy socket (the engine
//   merges the child's stdout + stderr into the single proxy stream).
export interface EngineChildStream {
  on(event: 'data', listener: (chunk: Buffer) => void): void;
}

export interface EngineChild {
  readonly pid: number;
  readonly stdout: EngineChildStream;
  readonly stderr: EngineChildStream;
  killed: boolean;
  exitCode: number | null;
  kill(signal?: NodeJS.Signals | number): void;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

class EngineChildImpl extends EventEmitter implements EngineChild {
  readonly pid: number;
  readonly stdout: EventEmitter;
  readonly stderr: EventEmitter;
  killed = false;
  exitCode: number | null = null;
  private readonly socket: net.Socket;
  private exited = false;

  constructor(pid: number, socket: net.Socket) {
    super();
    this.pid = pid;
    this.socket = socket;
    this.stdout = new EventEmitter();
    // Engine merges stderr into the single proxy stream; stderr stays present but
    // quiet so callers that wire `child.stderr?.on('data', ...)` keep working.
    this.stderr = new EventEmitter();

    socket.on('data', (chunk: Buffer) => {
      this.stdout.emit('data', chunk);
    });
    socket.on('error', (err: Error) => {
      this.emit('error', err);
      this.finish(1, null);
    });
    socket.on('close', (hadError: boolean) => {
      this.finish(hadError ? 1 : 0, this.killed ? 'SIGTERM' : null);
    });
  }

  private finish(code: number, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    this.emit('exit', code, signal);
  }

  // The engine owns the process; we can only close our stdio socket, which the
  // engine observes as EOF and uses to reap the child. No process.kill(-pid)
  // process-group kill is possible from here.
  kill(_signal?: NodeJS.Signals | number): void {
    this.killed = true;
    try { this.socket.destroy(); } catch { /* noop */ }
  }
}

export async function engineSpawn(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<EngineChild> {
  const env = opts.env ?? ({} as Record<string, string>);
  // opts.cwd is accepted for API compatibility but intentionally NOT forwarded:
  // the engine must always spawn from its own cwd to avoid chdir/fork ENOSYS.
  // Callers supply the working dir via tool flags (git -C) or a cwd preload shim.
  void opts.cwd;
  const { pid, proxyPort } = await rpcSpawn(cmd, args, env, ENGINE_CWD);
  const sock = net.connect({ port: proxyPort, host: '127.0.0.1', allowHalfOpen: true });
  await new Promise<void>((resolve, reject) => {
    sock.once('connect', () => resolve());
    sock.once('error', (e: Error) => reject(e));
  });
  return new EngineChildImpl(pid, sock);
}

// One-shot: spawn, collect all stdout (+ merged stderr) to a string, resolve on
// socket close. Used for read-only git (status/log/diff/rev-parse/branch).
export async function engineRun(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{ stdout: string; code: number }> {
  const env = opts.env ?? ({} as Record<string, string>);
  // opts.cwd is accepted for API compatibility but intentionally NOT forwarded
  // (see engineSpawn / ENGINE_CWD). Read-only git callers use `git -C <dir>`.
  void opts.cwd;
  const { proxyPort } = await rpcSpawn(cmd, args, env, ENGINE_CWD);
  return await new Promise<{ stdout: string; code: number }>((resolve, reject) => {
    const sock = net.connect({ port: proxyPort, host: '127.0.0.1', allowHalfOpen: true });
    const chunks: Buffer[] = [];
    let settled = false;
    sock.on('data', (c: Buffer) => chunks.push(c));
    sock.on('error', (e: Error) => {
      if (settled) return;
      settled = true;
      reject(e);
    });
    sock.on('close', (hadError: boolean) => {
      if (settled) return;
      settled = true;
      resolve({ stdout: Buffer.concat(chunks).toString('utf8'), code: hadError ? 1 : 0 });
    });
  });
}
