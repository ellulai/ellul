// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// Static security audit for the Cursor adapter pool. Mirrors
// opencode/security-invariants.test.ts: greps the cursor adapter +
// pool source for the invariants documented in the per-project pool
// design.
//
//   1. Every cursor-agent-spawning code path declares ELLUL_NS_PROJECT.
//      The factory's spawn site MUST set the env to the project being
//      acquired (never the host sentinel, never empty).
//   2. The adapter MUST NEVER spawn cursor-agent directly anymore — the
//      pool owns the spawn path. The provider probe uses
//      AcpSessionRuntime under the host bypass sentinel, which is fine.
//   3. Pool acquire asserts cwd's sandbox id matches the requested
//      project; mismatch must fail with a clear error.
//   4. Idle reaper is hooked into the lifecycle reconciler.
//   5. Orphan sweeper recognizes namespace-spawned cursor-agent.
//   6. Orphan sweeper refuses to reap cursor-agent without SVC_USER
//      constraint.
//
// If any of these regress, the test fails LOUDLY.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const ADAPTER_DIR = path.resolve(__dirname);

const readSource = (file: string): string =>
  fs.readFileSync(path.join(ADAPTER_DIR, file), "utf8");

describe("Cursor adapter security invariants", () => {
  it("server-pool factory always wires ELLUL_NS_PROJECT to the project being spawned", () => {
    const source = readSource("server-pool.ts");
    // The live factory's single spawn site builds the spawn input via
    // buildCursorAcpSpawnInput with `additionalEnv` carrying
    // ELLUL_NS_PROJECT bound to input.project.
    const spawnRe = /buildCursorAcpSpawnInput\([\s\S]*?\{\s*\[NAMESPACE_PROJECT_ENV\]:\s*input\.project[\s\S]*?\}/;
    expect(source).toMatch(spawnRe);
    // Defense-in-depth: exactly one spawn input builder call. If a
    // future patch adds a second spawn path that bypasses the env
    // plumbing, this fails and points the reviewer at the regression.
    const calls = source.match(/buildCursorAcpSpawnInput\s*\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it("adapter no longer constructs an AcpSessionRuntime per-thread", () => {
    const source = readSource("adapter.ts");
    // The pool now owns the cursor-agent spawn. The adapter's per-
    // thread `makeCursorAcpRuntime` import was removed; verify it's
    // gone so a future patch can't reintroduce a parallel spawn path.
    expect(source).not.toMatch(/makeCursorAcpRuntime/);
    expect(source).not.toMatch(/AcpSessionRuntime\.layer\b/);
  });

  it("adapter goes through CursorAcpServerPool.acquire on every startSession", () => {
    const source = readSource("adapter.ts");
    // Match `serverPool.acquire(...)` with arbitrary whitespace
    // (including newlines) between identifier and method call —
    // matches both same-line and the chained-pipe formatting.
    expect(source).toMatch(/serverPool[\s\S]*?\.acquire\s*\(/);
    // The adapter MUST set sessionId on acquire (so the pool can fire
    // the per-session crash callback and route release).
    expect(source).toMatch(/sessionId:\s*poolSessionId/);
    // And MUST set onCrash to a callback chain that recovers the
    // session.
    expect(source).toMatch(/onCrash/);
  });

  it("pool acquire asserts cwd matches the project (defense in depth)", () => {
    const source = readSource("server-pool.ts");
    expect(source).toMatch(/sandboxIdFromCwd\(input\.cwd\)/);
    expect(source).toMatch(/cwdProject !== input\.project/);
  });

  it("pool keeps cursor-agent on stdio (NEVER swaps to TCP)", () => {
    // The AcpProjectRuntime spawn flows through layerChildProcess —
    // stdio is the only transport. If a future patch tried to introduce
    // TCP for any reason this regression test would fire.
    const projectRuntimeSource = readSource("acp/AcpProjectRuntime.ts");
    expect(projectRuntimeSource).toMatch(/EffectAcpClient\.layerChildProcess\b/);
    expect(projectRuntimeSource).not.toMatch(/layerWebSocket|layerTcp|layerHttp/);
  });

  it("session/request_permission dispatch keys on params.sessionId", () => {
    // No cross-session bleed: an inbound request_permission for session
    // X must invoke session X's handler, not session Y's.
    const source = readSource("acp/AcpMultiSessionDispatch.ts");
    expect(source).toMatch(/sessions\.get\(input\.params\.sessionId\)/);
    // And the lookup must reject when the session doesn't exist.
    expect(source).toMatch(/Unknown session for request_permission/);
  });

  it("cursor extension methods route by toolCallId → sessionId", () => {
    // cursor/ask_question, cursor/create_plan, cursor/update_todos
    // carry toolCallId but NOT sessionId. The runtime must maintain a
    // toolCallId → sessionId map populated from tool_call session
    // updates and dispatch ext methods through it.
    const dispatchSource = readSource("acp/AcpMultiSessionDispatch.ts");
    expect(dispatchSource).toMatch(/toolCallIdToSession/);
    expect(dispatchSource).toMatch(/dispatchUnknownExtRequest/);
    expect(dispatchSource).toMatch(/dispatchUnknownExtNotification/);
    // The runtime wires the dispatch fns into AcpClient handlers.
    const runtimeSource = readSource("acp/AcpProjectRuntime.ts");
    expect(runtimeSource).toMatch(/handleUnknownExtRequest/);
    expect(runtimeSource).toMatch(/handleUnknownExtNotification/);
  });

  it("session handle close cleans up toolCallIdToSession entries", () => {
    // When a session closes we must drop its toolCallId → sessionId
    // entries so a stale toolCallId can't route a future ext request
    // to a closed session.
    const source = readSource("acp/AcpMultiSessionDispatch.ts");
    expect(source).toMatch(/for \(const \[tcId, sId\] of input\.toolCallIdToSession\)/);
  });

  it("idle reaper hooks into the lifecycle reconciler", () => {
    const reconcilerPath = path.resolve(
      __dirname,
      "../../application/namespace/NamespaceLifecycle.ts",
    );
    const reconcilerSource = fs.readFileSync(reconcilerPath, "utf8");
    expect(reconcilerSource).toMatch(/sweepCursorIdleAgents/);
    expect(reconcilerSource).toMatch(/CURSOR_IDLE_TTL_MS/);
  });

  it("orphan sweep recognizes namespace-spawned cursor-agent acp", () => {
    const sweeperPath = path.resolve(
      __dirname,
      "../../application/namespace/OrphanSweeper.ts",
    );
    const sweeperSource = fs.readFileSync(sweeperPath, "utf8");
    expect(sweeperSource).toMatch(/CURSOR_AGENT_ACP_REGEX/);
    expect(sweeperSource).toMatch(/cursor-agent\\b/);
  });

  it("orphan sweep refuses to reap cursor-agent without SVC_USER constraint", () => {
    const sweeperPath = path.resolve(
      __dirname,
      "../../application/namespace/OrphanSweeper.ts",
    );
    const sweeperSource = fs.readFileSync(sweeperPath, "utf8");
    expect(sweeperSource).toMatch(/orphan\.sweep\.cursor\.skipped/);
    // Same hard skip + strict-equality user check as the opencode
    // branch — no `svcUser && proc.user !==` form which would silently
    // sweep any user's cursor-agent when svcUser is unset.
    expect(sweeperSource).not.toMatch(/svcUser\s*&&\s*proc\.user\s*!==/);
  });

  it("provider probe stays on AcpSessionRuntime + host sentinel (host bypass)", () => {
    // The inventory probe spawns a one-shot AcpSessionRuntime under
    // NAMESPACE_HOST_SENTINEL so it never enters a real project's
    // namespace. The per-project pool MUST NOT accidentally take over
    // this path — verify the inventory probe still uses
    // AcpSessionRuntime.layer with the host sentinel.
    const source = readSource("provider.ts");
    expect(source).toMatch(/AcpSessionRuntime\.layer\b/);
    expect(source).toMatch(/NAMESPACE_HOST_SENTINEL/);
  });

  it("multi-session capability probe also pins to host sentinel", () => {
    // Capability discovery uses AcpProjectRuntime as the multi-session
    // ACP layer (one cursor-agent process serving N model probes via
    // session/new) — same primitive the per-project pool uses. The pool
    // is keyed by project; the capability probe MUST NOT be pooled
    // under any project — it pays an explicit host sentinel spawn so
    // cursor-agent runs on the host with no project-scope mounts. If a
    // future patch drops the sentinel here, this test catches it.
    const source = readSource("provider.ts");
    expect(source).toMatch(/AcpProjectRuntime\.layer/);
    // Belt and suspenders: every cursor-agent spawn site in provider.ts
    // must carry the host sentinel. Three legitimate sites today:
    //   1. inventory probe (AcpSessionRuntime, single-session)
    //   2. capability probe (AcpProjectRuntime, multi-session)
    //   3. plain `cursor-agent <command>` for `agent about` etc.
    // If a regression adds a fourth site without sentinel, this test
    // fails and the reviewer must explain why. If the count drops, one
    // of the existing spawns lost the sentinel — also a regression.
    const sentinelMatches =
      source.match(/\[NAMESPACE_PROJECT_ENV\]:\s*NAMESPACE_HOST_SENTINEL/g) ?? [];
    expect(sentinelMatches.length).toBe(3);
  });

  it("acp probes carry the routing trio so they land outside the bridge cgroup", () => {
    // resource-v2 lockdown: long-lived `cursor-agent acp` probes MUST
    // carry the routing trio alongside the host sentinel. The
    // namespace-spawner refuses host-bypass for argv that contains
    // 'acp' without these vars (hasLongLivedArgvMarker), so a regression
    // would fail at runtime — but failing at compile-grep is friendlier.
    //
    // Two of the three sentinel sites are long-lived ACP probes and must
    // satisfy this. The third (`runCursorCommand`) runs short host
    // queries like `agent about` and is exempt.
    const source = readSource("provider.ts");
    const probeRoutingMatches = source.match(
      /\[NAMESPACE_PROJECT_ENV\]:\s*NAMESPACE_HOST_SENTINEL,\s*\[NAMESPACE_ADAPTER_ENV\]:\s*PROVIDER,\s*\[NAMESPACE_SCOPE_ID_ENV\][\s\S]*?\[NAMESPACE_SOFT_HINT_MB_ENV\]/g,
    ) ?? [];
    expect(probeRoutingMatches.length).toBe(2);
  });

  it("capability probe never imports CursorAcpServerPool (no pool reuse)", () => {
    // The pool's runtime is keyed by project sandboxId. A regression
    // that wires the capability probe through the pool would either
    // attach the probe to an unrelated project (cross-tenant data
    // leak) or fail-closed on the cwd assertion. Either way the probe
    // path stays out of the pool by construction — it imports the bare
    // AcpProjectRuntime LAYER, not the pool's instance.
    const source = readSource("provider.ts");
    expect(source).not.toMatch(/CursorAcpServerPool/);
    expect(source).not.toMatch(/serverPool\.acquire\b/);
  });

  it("inventory cache stores enriched models so capability probe doesn't re-run on every refresh", () => {
    // After enrichSnapshot completes the discovered models, the cache
    // entry is updated in-place so the next checkProvider hits the
    // cache with caps already populated and the
    // `snapshot.models.some(!hasCaps)` guard short-circuits enrichment
    // for the rest of the TTL window. Removing this write would
    // resurrect the per-refresh probe storm.
    const source = readSource("provider.ts");
    expect(source).toMatch(/cursor\.providerProbe\.capabilitiesCacheStore/);
    // The cache update must preserve the existing fetchedAt so TTL
    // isn't reset on every enrichment cycle (we'd otherwise pin the
    // entry forever and miss real version bumps).
    expect(source).toMatch(/fetchedAt: cache\.fetchedAt/);
  });

  it("inventory probe is cached (matches opencode pattern)", () => {
    const source = readSource("provider.ts");
    // Cache key: cursor-agent --version + binaryPath + apiEndpoint, with
    // a 30 min TTL safety net. Guards against the regression where a
    // future patch removes the cache and brings back the per-tick
    // spawn pattern.
    expect(source).toMatch(/INVENTORY_CACHE_TTL_MS/);
    expect(source).toMatch(/readCachedCursorInventory/);
    expect(source).toMatch(/storeCursorInventoryInCache/);
    expect(source).toMatch(/cursor\.providerProbe\.inventoryCacheHit/);
    expect(source).toMatch(/cursor\.providerProbe\.inventoryCacheStore/);
  });
});
