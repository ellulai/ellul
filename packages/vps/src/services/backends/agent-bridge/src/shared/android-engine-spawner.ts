// SPDX-License-Identifier: BUSL-1.1
// Android engine-delegated ChildProcessSpawner — replaces the namespace
// spawner on Android proot where the bridge (grandchild) can't fork/exec.
//
// Spawns are delegated to the engine (PID 1's direct child) via a JSON-RPC
// call on port 7710. The engine spawns the binary and opens a per-spawn TCP
// proxy port. The bridge connects to that port and gets transparent access
// to the child's stdin/stdout — as if it spawned the binary locally.

import { Effect, Layer, Stream, Sink, Scope, Deferred, Queue, Chunk, Option, Cause } from "effect";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as NodeStream from "@effect/platform-node/NodeStream";
import * as NodeSink from "@effect/platform-node/NodeSink";
import * as net from "node:net";
import * as fs from "node:fs";

import { logEvent } from "./event-log";

// Two spawn backends, SAME JSON-RPC adapter.spawn + per-spawn stdio-proxy
// contract — selected per-binary by routeForCommand():
//
// 7720 = Native Adapter Runtime Host (Kotlin, app-hosted, OUTSIDE proot). Runs
//   the binary natively as the app uid. Avoids proot's getcwd ENOSYS + io_uring
//   limits, with rootfs-backed env + DNS egress proxy + path translation. BUT
//   the Android app-uid seccomp filter SIGSYS-kills any glibc/Bun binary (and
//   the ld-linux loader), so this backend is ONLY safe for STATIC-MUSL binaries
//   (codex). Verified: node/bash/git via 7720 all die exit 159 (128+SIGSYS).
//
// 7710 = in-proot engine (PID 1's direct child, INSIDE proot). proot's ptrace
//   syscall emulation intercepts syscalls before the kernel seccomp filter, so
//   glibc/Bun/node run fine here (this is how the engine runs `opencode serve`).
//   Verified: `node --version` via 7710 → v22.x exit 0. Used for everything that
//   is NOT a static-musl binary: cursor (node), grok (Bun), claude (Bun), and
//   any glibc tool (git, dev servers).
const HOST_RPC_PORT = 7720; // native, musl-only
const PROOT_RPC_PORT = 7710; // in-proot, glibc/Bun-capable
const ENGINE_SECRET_PATH = "/tmp/ellul-engine-secret";

// DIAG (codex hang): event-log file writes silently fail on Android, so route
// byte-flow diagnostics straight to stderr → proot-stdout.log (reliably read).
const _dbgDec = new TextDecoder();
// Verbose per-spawn byte-flow trace. OFF by default; set ELLUL_SPAWN_DEBUG=1 to
// enable (writes to stderr → proot-stderr.log). Kept because structured event-log
// file writes silently fail on Android, so stderr is the only reliable spawn log.
const SPAWN_DEBUG = process.env.ELLUL_SPAWN_DEBUG === "1";
const dbg = (...a: unknown[]) => {
  if (!SPAWN_DEBUG) return;
  try { process.stderr.write("[cx-spawn " + (Date.now() % 1000000) + "] " + a.map(String).join(" ") + "\n"); } catch {}
};
const head = (c: Uint8Array): string => {
  try { return JSON.stringify(_dbgDec.decode(c.subarray(0, 300))); } catch { return "?"; }
};

function getSecret(): string {
  try { return fs.readFileSync(ENGINE_SECRET_PATH, "utf8").trim(); } catch { return ""; }
}

// Decide which spawn backend a command must use. Static-musl binaries can run on
// the native Host (7720); glibc/Bun/scripts MUST go in-proot (7710) or they get
// SIGSYS-killed. We sniff the binary: an ELF whose program headers reference an
// interpreter (`/lib/ld-...`) is dynamically linked (glibc) → in-proot; an ELF
// with NO interpreter string is static (musl) → Host; a `#!` script → in-proot
// (it needs bash/node, both glibc). Anything we can't read defaults to in-proot,
// the strictly more capable backend (proot can run musl too), so a sniff failure
// degrades safely rather than SIGSYS-killing the adapter.
function routeRpcPort(cmd: string): number {
  try {
    const fd = fs.openSync(cmd, "r");
    try {
      const buf = Buffer.alloc(4096);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const head = buf.subarray(0, n);
      if (head.length >= 4 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) {
        // ELF: dynamically-linked binaries embed the loader path as an ASCII
        // string (PT_INTERP). Static-musl binaries (codex) do not. Cheap, robust
        // proxy for "has a PT_INTERP" without parsing program headers.
        const asAscii = head.toString("latin1");
        const dynamic = asAscii.includes("/ld-linux") || asAscii.includes("ld-linux-aarch64") || asAscii.includes("/lib/ld-");
        return dynamic ? PROOT_RPC_PORT : HOST_RPC_PORT;
      }
      // Shebang script (#!) or anything non-ELF → in-proot.
      return PROOT_RPC_PORT;
    } finally { fs.closeSync(fd); }
  } catch {
    // Can't read the binary (e.g. a broken symlink, or a bare name on PATH):
    // default to in-proot, which runs both musl and glibc.
    return PROOT_RPC_PORT;
  }
}

function rpcCall(port: number, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const secret = getSecret();
    if (!secret) return reject(new Error("No engine RPC secret"));
    const sock = net.connect(port, "127.0.0.1");
    const timeout = setTimeout(() => { sock.destroy(); reject(new Error("RPC timeout")); }, 15_000);
    sock.on("connect", () => {
      sock.write(JSON.stringify({ jsonrpc: "2.0", id: 1, auth: secret, method, params }) + "\n");
    });
    let buf = "";
    sock.on("data", (d: Buffer) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      clearTimeout(timeout);
      sock.destroy();
      try {
        const res = JSON.parse(buf.slice(0, nl));
        if (res.error) reject(new Error(res.error.message));
        else resolve(res.result ?? {});
      } catch (e) { reject(e); }
    });
    sock.on("error", (e: Error) => { clearTimeout(timeout); reject(e); });
  });
}

function firstStandardCommand(command: ChildProcess.Command): ChildProcess.StandardCommand {
  let c: ChildProcess.Command = command;
  while (c._tag === "PipedCommand") c = c.left;
  return c as ChildProcess.StandardCommand;
}

const spawnViaEngine: ChildProcessSpawner.ChildProcessSpawner["Service"]["spawn"] = (
  command: ChildProcess.Command,
): Effect.Effect<ChildProcessSpawner.ChildProcessHandle, PlatformError.PlatformError, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const leftmost = firstStandardCommand(command);
    const cmd = leftmost.command;
    const args = [...leftmost.args];
    const env: Record<string, string> = {};
    if (leftmost.options.env) {
      for (const [k, v] of Object.entries(leftmost.options.env)) {
        if (typeof v === "string") env[k] = v;
      }
    }
    const cwd = leftmost.options.cwd;

    // Route by binary type: static-musl → native Host (7720), else → in-proot
    // engine (7710). See routeRpcPort(). Both speak the same adapter.spawn RPC.
    const rpcPort = routeRpcPort(cmd);
    logEvent("android-engine-spawner.spawn", { cmd, args: args.slice(0, 4), cwd, rpcPort });
    dbg("ROUTE", "cmd", cmd, "->", rpcPort === HOST_RPC_PORT ? "host(7720,musl)" : "proot(7710,glibc/bun)");

    // Call engine RPC to spawn + get proxy port
    const result = yield* Effect.tryPromise({
      try: () => rpcCall(rpcPort, "adapter.spawn", { cmd, args, env, cwd }),
      catch: (e) => new PlatformError.SystemError({
        reason: "Unknown",
        module: "AndroidEngineSpawner",
        method: "spawn",
        message: `Engine RPC failed: ${e instanceof Error ? e.message : String(e)}`,
      }),
    });

    const pid = result.pid as number;
    const proxyPort = result.proxyPort as number;
    if (!pid || !proxyPort) {
      return yield* Effect.fail(new PlatformError.SystemError({
        reason: "Unknown",
        module: "AndroidEngineSpawner",
        method: "spawn",
        message: `Engine returned invalid result: pid=${pid} proxyPort=${proxyPort}`,
      }));
    }

    logEvent("android-engine-spawner.connected", { pid, proxyPort });

    // Connect TCP to the proxy port — this gives us the child's stdin/stdout
    const socket = yield* Effect.tryPromise({
      try: () => new Promise<net.Socket>((resolve, reject) => {
        // allowHalfOpen: keep the readable (codex stdout) open after the
        // writable (codex stdin) finishes. The codex app-server protocol ends
        // its outgoing queue once requests are answered, finishing the stdin
        // sink; with allowHalfOpen:false Node tears down the WHOLE duplex when
        // the writable finishes, killing codex's reply stream mid-turn.
        const s = net.connect({ port: proxyPort, host: "127.0.0.1", allowHalfOpen: true });
        // CRITICAL: clear the connect-timeout once connected. Leaving it armed
        // destroyed the live session socket 5 s after connect (killing codex
        // mid-turn, before its reply) — the timer's s.destroy() fired even
        // though the Promise had already resolved.
        const timer = setTimeout(() => { s.destroy(); reject(new Error("Proxy connect timeout")); }, 5_000);
        s.on("connect", () => { clearTimeout(timer); resolve(s); });
        s.on("error", (e) => { clearTimeout(timer); reject(e); });
      }),
      catch: (e) => new PlatformError.SystemError({
        reason: "Unknown",
        module: "AndroidEngineSpawner",
        method: "spawn",
        message: `Proxy connect failed: ${e instanceof Error ? e.message : String(e)}`,
      }),
    });

    // stdout: read the TCP socket as an async-iterable. A net.Socket yields
    // Buffer chunks via Symbol.asyncIterator, so Stream.fromAsyncIterable
    // delivers them AS THEY ARRIVE — which the codex/cursor JSON-RPC clients
    // require (they read responses while keeping the connection open). The
    // prior Readable.toWeb and Queue chains didn't deliver incrementally, so
    // codex never saw its responses, its probe scope tore down, and the engine
    // killed it ("Codex App Server process exited"). The socket ending (FIN /
    // codex exit) ends the iterable, which ends the stream.
    dbg("HANDLE", "pid", pid, "proxy", proxyPort, "cmd", cmd, args.slice(0, 2).join(","));
    const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>();
    let exited = false;
    const settleExit = (code: number) => {
      if (!exited) {
        exited = true;
        dbg("EXIT", "pid", pid, "code", code);
        Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(code)).pipe(Effect.runSync);
      }
    };
    // Resolve exit on full socket 'close' (process gone), NOT 'end' (FIN /
    // half-close): a persistent stdio server keeps running after its peer
    // half-closes, and resolving exitCode on 'end' made the codex client think
    // the process exited mid-probe. 'close' fires after 'end' for one-shots
    // (allowHalfOpen defaults false), so spawnAndCollect still completes.
    socket.on("end", () => dbg("SOCK-END(readable FIN)", "pid", pid));
    socket.on("finish", () => dbg("SOCK-FINISH(writable done)", "pid", pid));
    socket.on("close", (hadErr?: boolean) => { dbg("SOCK-CLOSE", "pid", pid, "hadErr", String(hadErr)); settleExit(0); });
    socket.on("error", (e: Error) => { dbg("SOCK-ERROR", "pid", pid, e?.message ?? ""); settleExit(1); });

    // Cleanup on scope close
    yield* Scope.addFinalizer(scope, Effect.sync(() => {
      dbg("FINALIZER", "pid", pid, "— bridge scope closing -> destroy socket");
      try { socket.destroy(); } catch {}
    }));

    // Read the socket via NodeStream.fromReadable — the same Node↔Effect
    // adapter the reference @effect/platform-node spawner uses for a child's
    // stdout. It delivers incrementally and handles the Readable lifecycle
    // (pause/resume/end/destroy) correctly, so it neither buffers (codex saw no
    // responses) nor spuriously errors on teardown ("input stream failed") —
    // the two failure modes the hand-rolled readers hit. closeOnDone:false:
    // the scope finalizer owns socket teardown (the socket is also our stdin).
    const stdoutStreamRaw: Stream.Stream<Uint8Array, PlatformError.PlatformError> =
      NodeStream.fromReadable<Uint8Array, PlatformError.PlatformError>({
        evaluate: () => socket,
        onError: (e) => new PlatformError.SystemError({
          reason: "Unknown",
          module: "AndroidEngineSpawner",
          method: "stdout",
          message: e instanceof Error ? e.message : String(e),
        }),
        closeOnDone: false,
      });
    // DIAG: tap reads (codex's responses) before the client consumes them.
    // Non-invasive — taps the Effect stream, not the socket (a socket 'data'
    // listener would flip flowing mode and steal bytes from NodeStream).
    // ensuring/tapError log the stream lifecycle — to tell "codex stopped
    // sending (stream end)" apart from "bridge tore down (finalizer first)".
    const stdoutStream = stdoutStreamRaw.pipe(
      Stream.tap((chunk) => Effect.sync(() => dbg("READ", "pid", pid, "n", chunk.length, head(chunk)))),
      Stream.tapError((e) => Effect.sync(() => dbg("STDOUT-ERR", "pid", pid, String(e)))),
      Stream.ensuring(Effect.sync(() => dbg("STDOUT-DONE", "pid", pid))),
    );

    // stdin sink — direct socket.write (exactly what the working raw-socket
    // test does). NodeSink.fromWritable + NodeStream.fromReadable BOTH managing
    // the SAME Duplex socket contended (the reference uses two separate pipes:
    // real stdout Readable + stdin Writable), causing the JSON-RPC round-trips
    // to hang. A thin Sink.forEach write avoids that dual-stream management.
    const stdinSink: Sink.Sink<void, Uint8Array, never, PlatformError.PlatformError> =
      Sink.forEach((chunk: Uint8Array) => Effect.sync(() => {
        dbg("WRITE", "pid", pid, "n", chunk.length, head(chunk));
        socket.write(chunk);
      }));

    // Empty stderr stream (merged into stdout by the engine proxy)
    const emptyStream: Stream.Stream<Uint8Array, PlatformError.PlatformError> = Stream.empty;

    const handle = ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(pid),
      exitCode: Deferred.await(exitDeferred),
      isRunning: Effect.sync(() => !exited),
      kill: () => Effect.sync(() => { dbg("KILL", "pid", pid, "— handle.kill() called by client"); try { socket.destroy(); } catch {} }),
      stdin: stdinSink,
      stdout: stdoutStream,
      stderr: emptyStream,
      all: stdoutStream,
      getInputFd: () => stdinSink,
      getOutputFd: () => emptyStream,
      unref: Effect.succeed(Effect.void),
    });

    return handle;
  });

export const AndroidEngineChildProcessSpawnerLive = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make(spawnViaEngine),
);
