// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// Static security audit for the OpenCode adapter. These tests don't run
// the binary — they grep the adapter source for violations of the
// security invariants documented in the per-project server pool design:
//
//   1. Every opencode-spawning code path must declare ELLUL_NS_PROJECT
//      in its additionalEnv. The namespace spawner fails closed if the
//      env is missing, but the test guards against a regression where
//      a future caller forgets the env entirely or hard-codes a
//      different sandbox id.
//   2. The pool's startOpenCodeServerProcess call must always pass the
//      ELLUL_NS_PROJECT for the project being acquired (never the host
//      sentinel).
//   3. The adapter must NEVER call openCodeRuntime.connectToOpenCodeServer
//      directly anymore — the pool owns the spawn path. The provider
//      probe is the only legitimate caller (host-bypass mode), and it
//      explicitly opts in via NAMESPACE_HOST_SENTINEL.
//
// If any of these regress, the test fails LOUDLY with a pointer to the
// invariant that broke.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const ADAPTER_DIR = path.resolve(__dirname);

const readSource = (file: string): string =>
  fs.readFileSync(path.join(ADAPTER_DIR, file), "utf8");

describe("OpenCode adapter security invariants", () => {
  it("server-pool always sets ELLUL_NS_PROJECT on the spawned server", () => {
    const source = readSource("server-pool.ts");
    // The single spawn site lives inside spawnEntry. Match the call
    // shape and confirm ELLUL_NS_PROJECT is bound to input.project.
    const spawnRe = /startOpenCodeServerProcess\(\{[\s\S]*?additionalEnv:\s*\{[\s\S]*?\[NAMESPACE_PROJECT_ENV\]:\s*input\.project[\s\S]*?\}/;
    expect(source).toMatch(spawnRe);
    // Defense-in-depth: exactly one CALL site for the spawn API. The
    // pattern `.startOpenCodeServerProcess(` excludes comments and type
    // annotations (which use `startOpenCodeServerProcess:` or appear
    // inside backticks). If a future patch adds a second spawn path
    // that bypasses spawnEntry's ELLUL_NS_PROJECT plumbing, this fails
    // and points the reviewer at the regression.
    const calls = source.match(/\.startOpenCodeServerProcess\s*\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it("adapter no longer calls connectToOpenCodeServer directly", () => {
    const source = readSource("adapter.ts");
    // Pool owns the spawn now. The adapter's only path that reached
    // out to runtime.connectToOpenCodeServer was deleted; verify it's
    // gone so a future patch can't reintroduce a parallel spawn path.
    expect(source).not.toMatch(/openCodeRuntime\.connectToOpenCodeServer/);
    expect(source).not.toMatch(/connectToOpenCodeServer\s*\(/);
  });

  it("provider probe uses host sentinel (NEVER a real sandbox id) for inventory", () => {
    const source = readSource("provider.ts");
    // Both --version and the host-bypass serve must declare
    // NAMESPACE_HOST_SENTINEL — they MUST NOT enter a real project's
    // namespace, and they MUST NOT omit the env (the spawner rejects
    // empty values fail-closed).
    const hostBypassMarkers =
      source.match(/\[NAMESPACE_PROJECT_ENV\]:\s*NAMESPACE_HOST_SENTINEL/g) ?? [];
    // One for --version, one for connectToOpenCodeServer.
    expect(hostBypassMarkers.length).toBeGreaterThanOrEqual(2);
  });

  it("inventory probe ('serve') carries the routing trio so it lands outside the bridge cgroup", () => {
    // resource-v2 lockdown: the long-lived `opencode serve` probe MUST
    // carry ELLUL_NS_ADAPTER + ELLUL_NS_SCOPE_ID + ELLUL_NS_SOFT_HINT_MB
    // alongside the host sentinel. Without these the spawn lands in the
    // bridge cgroup (the failure mode that pinned MemoryHigh and made
    // first-message turns time out). The namespace spawner refuses
    // long-lived host-bypass spawns without routing — see
    // namespace-spawner.ts hasLongLivedArgvMarker.
    const source = readSource("provider.ts");
    expect(source).toMatch(
      /connectToOpenCodeServer\(\{[\s\S]*?additionalEnv:\s*\{[\s\S]*?\[NAMESPACE_PROJECT_ENV\]:\s*NAMESPACE_HOST_SENTINEL[\s\S]*?\[NAMESPACE_ADAPTER_ENV\]:\s*PROVIDER[\s\S]*?\[NAMESPACE_SCOPE_ID_ENV\][\s\S]*?\[NAMESPACE_SOFT_HINT_MB_ENV\]/,
    );
  });

  it("pool acquire asserts cwd matches the project (defense in depth)", () => {
    const source = readSource("server-pool.ts");
    expect(source).toMatch(/sandboxIdFromCwd\(input\.cwd\)/);
    // The mismatch path must fail with a clear error rather than
    // silently spawn against a wrong project.
    expect(source).toMatch(/cwdProject !== input\.project/);
  });

  it("pool URL rewrite goes through getNsVethIp (no hardcoded loopback)", () => {
    const source = readSource("server-pool.ts");
    // Caller-side URL rewrite must use the namespace's veth IP. Hardcoding
    // 127.0.0.1 here would route the bridge into the host loopback rather
    // than the namespace's veth pair, which is how isolation breaks.
    expect(source).toMatch(/getNsVethIp\(input\.project\)/);
    // Whitelist: 127.0.0.1 may appear only as a comment / log marker.
    // The actual URL substitution must be `nsIp` driven.
    const literalLoopbackBindings = source.match(
      /baseUrl\s*=\s*[`"']http:\/\/127\.0\.0\.1/g,
    );
    expect(literalLoopbackBindings).toBeNull();
  });

  it("idle reaper hooks into the lifecycle reconciler", () => {
    const reconcilerPath = path.resolve(
      __dirname,
      "../../application/namespace/NamespaceLifecycle.ts",
    );
    const reconcilerSource = fs.readFileSync(reconcilerPath, "utf8");
    expect(reconcilerSource).toMatch(/sweepOpenCodeIdleServers/);
    expect(reconcilerSource).toMatch(/OPENCODE_IDLE_TTL_MS/);
  });

  it("orphan sweep recognizes opencode serve daemons", () => {
    const sweeperPath = path.resolve(
      __dirname,
      "../../application/namespace/OrphanSweeper.ts",
    );
    const sweeperSource = fs.readFileSync(sweeperPath, "utf8");
    expect(sweeperSource).toMatch(/OPENCODE_SERVE_REGEX/);
    // Match the literal regex source `\bopencode\s+serve\b` as it appears
    // in the file. `\\s` in this pattern matches a literal backslash-s.
    expect(sweeperSource).toMatch(/opencode\\s\+serve/);
  });

  it("orphan sweep refuses to reap opencode serve without SVC_USER constraint", () => {
    const sweeperPath = path.resolve(
      __dirname,
      "../../application/namespace/OrphanSweeper.ts",
    );
    const sweeperSource = fs.readFileSync(sweeperPath, "utf8");
    // The branch must hard-skip (not just log) when SVC_USER is unset,
    // and the user check must be `proc.user !== svcUser` (strict equality)
    // — NOT `svcUser && proc.user !== svcUser` (the previous form, which
    // would silently sweep ANY user's process when svcUser was unset).
    expect(sweeperSource).toMatch(/opencodeSweepSafe/);
    expect(sweeperSource).toMatch(/orphan\.sweep\.opencode\.skipped/);
    expect(sweeperSource).not.toMatch(/svcUser\s*&&\s*proc\.user\s*!==/);
  });
});
