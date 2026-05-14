// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// End-to-end coverage of the Lite-tier adapter with a stubbed spawn.
//
// The real `node:child_process.spawn` is replaced via the adapter's
// `spawnOverride` test seam with an EventEmitter-backed fake that:
//   - Captures every byte written to stdin (so we can assert the CLI's
//     stream-json input shape).
//   - Lets each test push stdout chunks and trigger exit events on its
//     own schedule (so we can drive the state machine deterministically).
//   - Exposes pid/killed/exitCode like the real ChildProcess.
//
// The OAT credential subsystem is replaced via the documented test
// seam (__setClaudeOatBridgeModuleForTests). This avoids touching
// sovereign-shield and keeps these tests offline-safe.

import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import type { ChildProcess as NodeChildProcess } from "node:child_process";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  Effect,
  Layer,
  ManagedRuntime,
  Stream,
} from "effect";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";

import { ClaudeAdapter, type ClaudeAdapterShape } from "../adapter.sdk";
import { makeClaudeLiteAdapterLive } from "../adapter.lite";
import {
  defaultServerSettings,
  makeStaticServerSettings,
  ServerSettingsService,
} from "../../../shared/serverSettings";
import { defaultServerConfig, ServerConfig } from "../../../shared/config";
import {
  __setClaudeOatBridgeModuleForTests,
  type ClaudeOatBridgeModule,
} from "../../../credentials/claude-oat/public";
import {
  ThreadId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
} from "@ellul.ai/types";

// ── Stub child-process plumbing ──────────────────────────────────────

interface FakeChildProcess extends NodeChildProcess {
  readonly stdinBuffer: Array<string>;
  pushStdout(line: string): void;
  fireExit(code: number | null, signal: NodeJS.Signals | null): void;
}

function makeFakeProcess(pid = 12345): FakeChildProcess {
  const ee = new EventEmitter() as unknown as FakeChildProcess;
  const stdinBuffer: Array<string> = [];
  // Writable stdin
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      stdinBuffer.push(chunk.toString("utf8"));
      cb();
    },
  });
  // Readable stdout / stderr — paused, manual push
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  Object.assign(ee, {
    pid,
    killed: false,
    exitCode: null,
    signalCode: null,
    stdin,
    stdout,
    stderr,
    stdinBuffer,
    pushStdout(line: string) {
      stdout.push(line);
    },
    fireExit(code: number | null, signal: NodeJS.Signals | null) {
      ee.exitCode = code;
      ee.signalCode = signal;
      ee.killed = signal !== null;
      stdout.push(null);
      stderr.push(null);
      ee.emit("exit", code, signal);
    },
  });
  return ee;
}

// ── OAT credential stub ──────────────────────────────────────────────

function installFakeOatModule(): { issuanceCount: () => number; clear: () => void } {
  let count = 0;
  const fake: Partial<ClaudeOatBridgeModule> = {
    issueToken: async () => {
      count += 1;
      return {
        issuanceToken: `fake-issuance-${count}`,
        state: "active",
      } as Awaited<ReturnType<ClaudeOatBridgeModule["issueToken"]>>;
    },
    redeemToken: async (issuanceToken: string) => `fake-oat-for-${issuanceToken}`,
  };
  __setClaudeOatBridgeModuleForTests(fake as ClaudeOatBridgeModule);
  return {
    issuanceCount: () => count,
    clear: () => {
      __setClaudeOatBridgeModuleForTests(null);
    },
  };
}

// ── Test runtime helpers ─────────────────────────────────────────────

interface SpawnRecord {
  readonly binary: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly proc: FakeChildProcess;
}

interface TestRig {
  readonly adapter: ClaudeAdapterShape;
  readonly events: ReadonlyArray<ProviderRuntimeEvent>;
  readonly spawns: ReadonlyArray<SpawnRecord>;
  collectEvents(predicate: (e: ProviderRuntimeEvent) => boolean): Promise<ProviderRuntimeEvent[]>;
  cleanup(): Promise<void>;
}

interface RigOptions {
  readonly hotWindowMs?: number;
  /** Override the launcherPath returned by settings. */
  readonly binaryPath?: string;
}

async function makeRig(options: RigOptions = {}): Promise<TestRig> {
  const spawns: SpawnRecord[] = [];
  const events: ProviderRuntimeEvent[] = [];

  const settings = makeStaticServerSettings({
    claudeAgent: {
      ...defaultServerSettings.providers.claudeAgent,
      launcherPath: options.binaryPath ?? "/usr/local/bin/ellul-claude-ns",
    },
  });

  const Live = makeClaudeLiteAdapterLive({
    hotWindowMs: options.hotWindowMs,
    spawnOverride: (input) => {
      const proc = makeFakeProcess(20000 + spawns.length);
      spawns.push({
        binary: input.binary,
        args: input.args,
        env: input.env,
        cwd: input.cwd,
        proc,
      });
      return proc;
    },
  }).pipe(
    Layer.provide(NodeFileSystem.layer),
    Layer.provide(Layer.succeed(ServerSettingsService, settings)),
    Layer.provide(Layer.succeed(ServerConfig, defaultServerConfig)),
  );

  const runtime = ManagedRuntime.make(Live);
  const adapter = await runtime.runPromise(Effect.service(ClaudeAdapter));

  // Subscribe to the event stream and accumulate.
  const subFiber = runtime.runFork(
    Stream.runForEach(adapter.streamEvents, (e) =>
      Effect.sync(() => {
        events.push(e);
      }),
    ),
  );
  // Give the subscription a tick to attach.
  await new Promise((res) => setImmediate(res));

  return {
    adapter,
    events,
    spawns,
    collectEvents(predicate) {
      return new Promise((resolve) => {
        const check = () => {
          const matched = events.filter(predicate);
          if (matched.length > 0) return resolve(matched);
          setImmediate(check);
        };
        check();
      });
    },
    async cleanup() {
      subFiber.interruptUnsafe();
      await runtime.dispose();
    },
  };
}

// Helpers to feed stream-json lines through the fake stdout.
const ASSISTANT = (text: string, messageId = "msg-1") =>
  JSON.stringify({
    type: "assistant",
    message: { id: messageId, content: [{ type: "text", text }] },
  }) + "\n";

const RESULT = () =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 100,
    num_turns: 1,
    result: "Done.",
    session_id: "session-fake",
    total_cost_usd: 0,
  }) + "\n";

// ── Tests ────────────────────────────────────────────────────────────

const CWD = "/home/dev/projects/sbx-abc1234/app";
const THREAD = ThreadId.make("thread-test-1");

const baseSendTurn = (overrides: Partial<ProviderSendTurnInput> = {}): ProviderSendTurnInput => ({
  threadId: THREAD,
  input: "say hi",
  ...overrides,
});

let oat: ReturnType<typeof installFakeOatModule>;

beforeEach(() => {
  oat = installFakeOatModule();
});

afterEach(() => {
  oat.clear();
});

describe("ClaudeLiteAdapter — startSession", () => {
  it("validates that cwd is a sandbox-scoped path", async () => {
    const rig = await makeRig();
    try {
      const exit = await Effect.runPromiseExit(
        rig.adapter.startSession({ threadId: THREAD, runtimeMode: "auto-accept-edits" }),
      );
      expect(exit._tag).toBe("Failure");
    } finally {
      await rig.cleanup();
    }
  });

  it("returns a ProviderSession with status 'ready' and emits session.started", async () => {
    const rig = await makeRig();
    try {
      const session = await Effect.runPromise(
        rig.adapter.startSession({
          threadId: THREAD,
          cwd: CWD,
          runtimeMode: "auto-accept-edits",
        }),
      );
      expect(session.status).toBe("ready");
      expect(session.threadId).toBe(THREAD);
      expect(session.cwd).toBe(CWD);
      const started = await rig.collectEvents((e) => e.type === "session.started");
      expect(started.length).toBe(1);
    } finally {
      await rig.cleanup();
    }
  });

  it("does NOT spawn a process on startSession (cold spawn deferred to first sendTurn)", async () => {
    const rig = await makeRig();
    try {
      await Effect.runPromise(
        rig.adapter.startSession({
          threadId: THREAD,
          cwd: CWD,
          runtimeMode: "auto-accept-edits",
        }),
      );
      expect(rig.spawns.length).toBe(0);
    } finally {
      await rig.cleanup();
    }
  });
});

describe("ClaudeLiteAdapter — sendTurn cold path", () => {
  it("spawns one process with the configured launcherPath and required argv flags", async () => {
    const rig = await makeRig({ binaryPath: "/opt/launcher" });
    try {
      await Effect.runPromise(
        rig.adapter.startSession({
          threadId: THREAD,
          cwd: CWD,
          runtimeMode: "auto-accept-edits",
        }),
      );
      await Effect.runPromise(rig.adapter.sendTurn(baseSendTurn()));

      expect(rig.spawns.length).toBe(1);
      const spawn = rig.spawns[0]!;
      expect(spawn.binary).toBe("/opt/launcher");
      expect(spawn.cwd).toBe(CWD);
      expect(spawn.args).toContain("-p");
      expect(spawn.args).toContain("--dangerously-skip-permissions");
      expect(spawn.args).toContain("--include-partial-messages");
      expect(spawn.args.indexOf("--session-id")).toBeGreaterThan(-1);
    } finally {
      await rig.cleanup();
    }
  });

  it("sets ELLUL_NS_PROJECT and CLAUDE_CODE_OAUTH_TOKEN env on every spawn", async () => {
    const rig = await makeRig();
    try {
      await Effect.runPromise(
        rig.adapter.startSession({
          threadId: THREAD,
          cwd: CWD,
          runtimeMode: "auto-accept-edits",
        }),
      );
      await Effect.runPromise(rig.adapter.sendTurn(baseSendTurn()));

      const env = rig.spawns[0]!.env;
      expect(env.ELLUL_NS_PROJECT).toBe("sbx-abc1234");
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("fake-oat-for-fake-issuance-1");
    } finally {
      await rig.cleanup();
    }
  });

  it("writes a stream-json user message to stdin (one line, terminated by newline)", async () => {
    const rig = await makeRig();
    try {
      await Effect.runPromise(
        rig.adapter.startSession({
          threadId: THREAD,
          cwd: CWD,
          runtimeMode: "auto-accept-edits",
        }),
      );
      await Effect.runPromise(rig.adapter.sendTurn(baseSendTurn({ input: "hello world" })));

      const written = rig.spawns[0]!.proc.stdinBuffer.join("");
      expect(written.endsWith("\n")).toBe(true);
      const parsed = JSON.parse(written.trim());
      expect(parsed).toMatchObject({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "hello world" }],
        },
      });
    } finally {
      await rig.cleanup();
    }
  });

  it("emits turn.started with the resolved API model id", async () => {
    const rig = await makeRig();
    try {
      await Effect.runPromise(
        rig.adapter.startSession({
          threadId: THREAD,
          cwd: CWD,
          runtimeMode: "auto-accept-edits",
        }),
      );
      await Effect.runPromise(
        rig.adapter.sendTurn(
          baseSendTurn({
            modelSelection: {
              provider: "claudeAgent",
              model: "claude-opus-4-7",
              options: { contextWindow: "1m" },
            },
          }),
        ),
      );
      const turnStarted = await rig.collectEvents((e) => e.type === "turn.started");
      expect(turnStarted.length).toBe(1);
      expect((turnStarted[0]!.payload as { model?: string }).model).toBe("claude-opus-4-7[1m]");
    } finally {
      await rig.cleanup();
    }
  });

  it("parses assistant text → emits content.delta", async () => {
    const rig = await makeRig();
    try {
      await Effect.runPromise(
        rig.adapter.startSession({
          threadId: THREAD,
          cwd: CWD,
          runtimeMode: "auto-accept-edits",
        }),
      );
      await Effect.runPromise(rig.adapter.sendTurn(baseSendTurn()));

      rig.spawns[0]!.proc.pushStdout(ASSISTANT("Hello, world."));
      const deltas = await rig.collectEvents((e) => e.type === "content.delta");
      expect(deltas.length).toBe(1);
      expect((deltas[0]!.payload as { delta: string }).delta).toBe("Hello, world.");
    } finally {
      await rig.cleanup();
    }
  });

  it("emits turn.completed when the result block arrives", async () => {
    const rig = await makeRig({ hotWindowMs: 0 });
    try {
      await Effect.runPromise(
        rig.adapter.startSession({
          threadId: THREAD,
          cwd: CWD,
          runtimeMode: "auto-accept-edits",
        }),
      );
      await Effect.runPromise(rig.adapter.sendTurn(baseSendTurn()));

      rig.spawns[0]!.proc.pushStdout(ASSISTANT("Done."));
      rig.spawns[0]!.proc.pushStdout(RESULT());
      const completed = await rig.collectEvents((e) => e.type === "turn.completed");
      expect(completed.length).toBe(1);
      expect((completed[0]!.payload as { state: string }).state).toBe("completed");
    } finally {
      await rig.cleanup();
    }
  });
});

describe("ClaudeLiteAdapter — sendTurn hot reuse", () => {
  it("a second sendTurn within the hot window does NOT spawn a new process", async () => {
    const rig = await makeRig({ hotWindowMs: 30_000 });
    try {
      await Effect.runPromise(
        rig.adapter.startSession({
          threadId: THREAD,
          cwd: CWD,
          runtimeMode: "auto-accept-edits",
        }),
      );

      // First turn
      await Effect.runPromise(rig.adapter.sendTurn(baseSendTurn({ input: "first" })));
      const proc = rig.spawns[0]!.proc;
      proc.pushStdout(ASSISTANT("ok 1"));
      proc.pushStdout(RESULT());
      await rig.collectEvents((e) => e.type === "turn.completed");

      // Second turn — should reuse the same process.
      await Effect.runPromise(rig.adapter.sendTurn(baseSendTurn({ input: "second" })));
      expect(rig.spawns.length).toBe(1);

      // Both stream-json messages should have been written to the same stdin.
      const lines = rig.spawns[0]!.proc.stdinBuffer.join("").trim().split("\n");
      expect(lines.length).toBe(2);
      expect(JSON.parse(lines[0]!).message.content[0].text).toBe("first");
      expect(JSON.parse(lines[1]!).message.content[0].text).toBe("second");
    } finally {
      await rig.cleanup();
    }
  });

  it("hotWindowMs=0 disables hot reuse — second sendTurn spawns again", async () => {
    const rig = await makeRig({ hotWindowMs: 0 });
    try {
      await Effect.runPromise(
        rig.adapter.startSession({
          threadId: THREAD,
          cwd: CWD,
          runtimeMode: "auto-accept-edits",
        }),
      );
      await Effect.runPromise(rig.adapter.sendTurn(baseSendTurn({ input: "first" })));
      rig.spawns[0]!.proc.pushStdout(RESULT());
      await rig.collectEvents((e) => e.type === "turn.completed");
      // After result, the kill timer is NOT armed (hotWindowMs=0); but the
      // process is still alive in this fake. We simulate it dying so the
      // next sendTurn cold-spawns.
      rig.spawns[0]!.proc.fireExit(0, null);
      await new Promise((res) => setImmediate(res));

      await Effect.runPromise(rig.adapter.sendTurn(baseSendTurn({ input: "second" })));
      expect(rig.spawns.length).toBe(2);
    } finally {
      await rig.cleanup();
    }
  });
});

describe("ClaudeLiteAdapter — concurrent turns", () => {
  it("rejects a second sendTurn while one is still in-flight", async () => {
    const rig = await makeRig({ hotWindowMs: 30_000 });
    try {
      await Effect.runPromise(
        rig.adapter.startSession({
          threadId: THREAD,
          cwd: CWD,
          runtimeMode: "auto-accept-edits",
        }),
      );
      await Effect.runPromise(rig.adapter.sendTurn(baseSendTurn({ input: "first" })));
      // No result fired yet — the turn is still in flight.
      const exit = await Effect.runPromiseExit(
        rig.adapter.sendTurn(baseSendTurn({ input: "second" })),
      );
      expect(exit._tag).toBe("Failure");
    } finally {
      await rig.cleanup();
    }
  });
});

describe("ClaudeLiteAdapter — interruptTurn", () => {
  it("SIGTERMs the in-flight process", async () => {
    const rig = await makeRig();
    try {
      await Effect.runPromise(
        rig.adapter.startSession({
          threadId: THREAD,
          cwd: CWD,
          runtimeMode: "auto-accept-edits",
        }),
      );
      await Effect.runPromise(rig.adapter.sendTurn(baseSendTurn()));

      const proc = rig.spawns[0]!.proc;
      let killSignal: NodeJS.Signals | null = null;
      const realKill = process.kill;
      const kill = ((pid: number, signal: NodeJS.Signals | number) => {
        if (Math.abs(pid) === proc.pid) killSignal = signal as NodeJS.Signals;
        return true;
      }) as typeof process.kill;
      Object.assign(process, { kill });
      try {
        await Effect.runPromise(rig.adapter.interruptTurn(THREAD));
      } finally {
        Object.assign(process, { kill: realKill });
      }
      expect(killSignal).toBe("SIGTERM");
    } finally {
      await rig.cleanup();
    }
  });

  it("on process exit after interrupt, emits turn.completed with state='interrupted'", async () => {
    const rig = await makeRig();
    try {
      await Effect.runPromise(
        rig.adapter.startSession({
          threadId: THREAD,
          cwd: CWD,
          runtimeMode: "auto-accept-edits",
        }),
      );
      await Effect.runPromise(rig.adapter.sendTurn(baseSendTurn()));
      // Mark interrupted, then fire the exit.
      const realKill = process.kill;
      Object.assign(process, { kill: () => true });
      try {
        await Effect.runPromise(rig.adapter.interruptTurn(THREAD));
      } finally {
        Object.assign(process, { kill: realKill });
      }
      rig.spawns[0]!.proc.fireExit(null, "SIGTERM");

      const completed = await rig.collectEvents((e) => e.type === "turn.completed");
      expect((completed[0]!.payload as { state: string }).state).toBe("interrupted");
    } finally {
      await rig.cleanup();
    }
  });
});

describe("ClaudeLiteAdapter — stopSession", () => {
  it("emits session.exited", async () => {
    const rig = await makeRig({ hotWindowMs: 0 });
    try {
      await Effect.runPromise(
        rig.adapter.startSession({
          threadId: THREAD,
          cwd: CWD,
          runtimeMode: "auto-accept-edits",
        }),
      );
      await Effect.runPromise(rig.adapter.stopSession(THREAD));
      const exited = await rig.collectEvents((e) => e.type === "session.exited");
      expect(exited.length).toBe(1);
    } finally {
      await rig.cleanup();
    }
  });
});

describe("ClaudeLiteAdapter — exit before result", () => {
  it("synthesises a turn.completed in the failed state", async () => {
    const rig = await makeRig();
    try {
      await Effect.runPromise(
        rig.adapter.startSession({
          threadId: THREAD,
          cwd: CWD,
          runtimeMode: "auto-accept-edits",
        }),
      );
      await Effect.runPromise(rig.adapter.sendTurn(baseSendTurn()));
      // Process dies non-zero before result arrives.
      rig.spawns[0]!.proc.fireExit(2, null);

      const completed = await rig.collectEvents((e) => e.type === "turn.completed");
      const payload = completed[0]!.payload as { state: string; errorMessage?: string };
      expect(payload.state).toBe("failed");
      expect(payload.errorMessage).toBeDefined();
    } finally {
      await rig.cleanup();
    }
  });
});

describe("ClaudeLiteAdapter — OAT issuance failure", () => {
  it("surfaces ProviderAdapterProcessError when issueToken returns null", async () => {
    const rig = await makeRig();
    try {
      // Override the OAT module to return null.
      __setClaudeOatBridgeModuleForTests({
        issueToken: async () => null,
      } as unknown as ClaudeOatBridgeModule);
      await Effect.runPromise(
        rig.adapter.startSession({
          threadId: THREAD,
          cwd: CWD,
          runtimeMode: "auto-accept-edits",
        }),
      );
      const exit = await Effect.runPromiseExit(rig.adapter.sendTurn(baseSendTurn()));
      expect(exit._tag).toBe("Failure");
      expect(rig.spawns.length).toBe(0);
    } finally {
      await rig.cleanup();
    }
  });
});
