// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// Static security audit for the ZeroClaw adapter. Mirrors the
// opencode/cursor security-invariants suite — these tests don't run
// the binary, they grep the adapter source for violations of the
// invariants documented in the per-project pool design.
//
//   1. Every zeroclaw-spawning code path must declare ELLUL_NS_PROJECT
//      in its env. The namespace spawner fails closed if the env is
//      missing, but the test guards against a regression where a
//      future caller forgets the env entirely or hard-codes a
//      different sandbox id.
//   2. The pool's startDaemon call must always pass the project for
//      the entry being acquired (never the host sentinel).
//   3. The orphan sweeper must recognize `zeroclaw daemon` AND must
//      hard-skip without the SVC_USER constraint.
//   4. The lifecycle reconciler must call sweepZeroClawIdleDaemons
//      every tick — without that, idle daemons leak.
//   5. The legacy daemon.ts module must NOT exist — its presence
//      would mean the module-level state regression is back.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const ADAPTER_DIR = path.resolve(__dirname);

const readSource = (file: string): string =>
  fs.readFileSync(path.join(ADAPTER_DIR, file), "utf8");

describe("ZeroClaw adapter security invariants", () => {
  it("server-pool always spawns inside the requested project's namespace", () => {
    const source = readSource("server-pool.ts");
    // The pool builds a startDaemon input with `project: input.project`
    // — a regression that hard-coded a constant project, or omitted
    // the field, would fail this match.
    expect(source).toMatch(/runtime\s*\n?\s*\.startDaemon\(\{[\s\S]*?project:\s*input\.project/);
    // Exactly one spawn site: spawnEntry. If a future patch adds a
    // second spawn path that bypasses the project mutex / scope
    // ownership, this fails and points the reviewer at the regression.
    const calls = source.match(/\.startDaemon\s*\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it("runtime.startDaemon sets ELLUL_NS_PROJECT for the namespace spawner", () => {
    const source = readSource("runtime.ts");
    // buildDaemonEnv must bind ELLUL_NS_PROJECT to input.project.
    // Without it the NamespaceChildProcessSpawner fail-closes — but
    // the test guards against accidental removal that would break
    // every spawn at runtime instead of compile-time.
    expect(source).toMatch(/NAMESPACE_PROJECT_ENV\]\s*=\s*input\.project/);
  });

  it("legacy daemon.ts module is gone (was the orphan-leak regression source)", () => {
    const legacyPath = path.join(ADAPTER_DIR, "daemon.ts");
    expect(fs.existsSync(legacyPath)).toBe(false);
  });

  it("adapter no longer holds module-level daemon state", () => {
    const source = readSource("adapter.ts");
    // The legacy adapter held `gatewayPool`, `threadProjectMap`, etc.
    // at module scope. After the pool migration these must live ONLY
    // inside the ZeroClawDaemonPool's closed-over state.
    expect(source).not.toMatch(/^\s*const\s+gatewayPool\s*=/m);
    expect(source).not.toMatch(/^\s*const\s+threadProjectMap\s*=/m);
    expect(source).not.toMatch(/^\s*const\s+usedPorts\s*=/m);
    // The adapter must use pool.acquire / pool.release — no direct
    // process management. Allow whitespace between `pool` and `.acquire`
    // because the formatter sometimes wraps the chain.
    expect(source).toMatch(/pool\b[\s\S]{0,40}?\.acquire\(/);
    expect(source).toMatch(/releasePoolEntry|pool\b[\s\S]{0,40}?\.release\(/);
    expect(source).not.toMatch(/process\.kill/);
  });

  it("pool acquire asserts cwd matches the project (defense in depth)", () => {
    const source = readSource("server-pool.ts");
    expect(source).toMatch(/sandboxIdFromCwd\(input\.cwd\)/);
    expect(source).toMatch(/cwdProject !== input\.project/);
  });

  it("idle reaper hooks into the lifecycle reconciler", () => {
    const reconcilerPath = path.resolve(
      __dirname,
      "../../application/namespace/NamespaceLifecycle.ts",
    );
    const reconcilerSource = fs.readFileSync(reconcilerPath, "utf8");
    expect(reconcilerSource).toMatch(/sweepZeroClawIdleDaemons/);
    expect(reconcilerSource).toMatch(/ZEROCLAW_IDLE_TTL_MS/);
    // Reconcile event payload must include zeroclaw fields so dashboards
    // can chart eviction rate alongside opencode/cursor.
    expect(reconcilerSource).toMatch(/zeroclawEvicted/);
    expect(reconcilerSource).toMatch(/zeroclawRetained/);
  });

  it("orphan sweep recognizes zeroclaw daemon processes", () => {
    const sweeperPath = path.resolve(
      __dirname,
      "../../application/namespace/OrphanSweeper.ts",
    );
    const sweeperSource = fs.readFileSync(sweeperPath, "utf8");
    expect(sweeperSource).toMatch(/ZEROCLAW_DAEMON_REGEX/);
    // Regex literal as written in source: `\bzeroclaw\b\s+daemon\b`.
    // The `\\b`/`\\s` patterns match a literal backslash-b / -s as
    // they appear in the file.
    expect(sweeperSource).toMatch(/zeroclaw\\b\\s\+daemon/);
    expect(sweeperSource).toMatch(/sweptZeroClawDaemon/);
  });

  it("orphan sweep refuses to reap zeroclaw daemon without SVC_USER constraint", () => {
    const sweeperPath = path.resolve(
      __dirname,
      "../../application/namespace/OrphanSweeper.ts",
    );
    const sweeperSource = fs.readFileSync(sweeperPath, "utf8");
    // The branch must hard-skip (not just log) when SVC_USER is unset.
    // Re-uses `opencodeSweepSafe` flag so all three sweep branches
    // share one guard. Test asserts the check is present AND there's
    // no `svcUser && proc.user !==` form (which would sweep any user
    // when svcUser is unset).
    expect(sweeperSource).toMatch(/orphan\.sweep\.zeroclaw\.skipped/);
    expect(sweeperSource).not.toMatch(/svcUser\s*&&\s*proc\.user\s*!==/);
  });

  it("daemon log path is canonical (file-api WhatsApp QR tail must keep working)", () => {
    const source = readSource("runtime.ts");
    // The pre-pool legacy code wrote to /var/log/ellul/zeroclaw-{project}.log
    // and file-api's WhatsApp QR path tails that exact filename. The
    // refactor must preserve it — per-generation suffixed paths would
    // silently break QR streaming.
    expect(source).toMatch(/zeroclaw-\$\{[^}]*project[^}]*\}\.log/);
    // Append-only: the legacy bug was `writeFileSync(file, "")` which
    // truncated history on every spawn. The fix is appendFileSync ONLY.
    expect(source).not.toMatch(/writeFileSync\([^,]*logFile/);
    expect(source).toMatch(/appendFileSync/);
  });

  it("WS dialog routes daemon errors via onChunk (NOT promise rejection)", () => {
    const source = readSource("runtime.ts");
    // Legacy bug: case "error" did `reject(new Error(msg.message))`
    // which collapsed every upstream LLM 500 into a generic "Something
    // went wrong" string by the time the bridge returned to the user.
    // Fix: route through `onChunk({type:"error"})` so the adapter's
    // chunk handler emits a structured runtime.error event.
    expect(source).toMatch(/case "error":[\s\S]*?onChunk\(\{\s*type:\s*"error"/);
    // No reject() inside the case "error" block.
    const errorBlock = source.match(/case "error":[\s\S]*?(?=case |^\s*\}\s*\}\s*\)\;)/m);
    expect(errorBlock).toBeTruthy();
    expect(errorBlock?.[0]).not.toMatch(/reject\(\s*new Error/);
  });
});
