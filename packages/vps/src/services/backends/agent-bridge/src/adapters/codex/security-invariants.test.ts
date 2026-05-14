// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// Static security audit for the Codex adapter. Mirrors
// opencode/security-invariants.test.ts and cursor/security-invariants.test.ts.
// Greps the codex adapter source for the resource-v2 spawn-routing
// invariants:
//
//   1. The provider probe runs codex `app-server` (a long-lived JSON-RPC
//      daemon). It MUST carry the host sentinel (probe needs host network
//      to reach upstream provider endpoints) AND the routing trio
//      (ELLUL_NS_ADAPTER + ELLUL_NS_SCOPE_ID + ELLUL_NS_SOFT_HINT_MB) so
//      the namespace spawner wraps the spawn in ellul-spawn-scope under
//      ellul-user-workload.slice — never the bridge's own cgroup.
//   2. The namespace spawner refuses host-bypass for argv tokens
//      'serve' / 'acp' / 'app-server' without the routing trio
//      (hasLongLivedArgvMarker), so a regression would fail at runtime.
//      Failing at compile-grep is friendlier — that's what this test is.
//
// If the codex adapter regresses, the test fails LOUDLY.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const ADAPTER_DIR = path.resolve(__dirname);

const readSource = (file: string): string =>
  fs.readFileSync(path.join(ADAPTER_DIR, file), "utf8");

describe("Codex adapter security invariants", () => {
  it("provider probe uses host sentinel for codex app-server", () => {
    const source = readSource("provider.ts");
    // The probe runs `codex app-server` outside any per-project namespace
    // — provider RPCs need the host network. The host sentinel is the
    // explicit opt-in.
    expect(source).toMatch(/\[NAMESPACE_PROJECT_ENV\]:\s*NAMESPACE_HOST_SENTINEL/);
  });

  it("provider probe carries the routing trio so it lands outside the bridge cgroup", () => {
    // resource-v2 lockdown: codex app-server is long-lived; without the
    // routing trio it would land in the bridge's cgroup and pin
    // MemoryHigh (the failure mode that made first-message turns time
    // out). The namespace spawner enforces this at runtime — but
    // failing at compile-grep is friendlier and points the reviewer
    // straight at the regression.
    const source = readSource("provider.ts");
    expect(source).toMatch(
      /\[NAMESPACE_PROJECT_ENV\]:\s*NAMESPACE_HOST_SENTINEL,\s*\[NAMESPACE_ADAPTER_ENV\]:\s*PROVIDER,\s*\[NAMESPACE_SCOPE_ID_ENV\][\s\S]*?\[NAMESPACE_SOFT_HINT_MB_ENV\]/,
    );
  });

  it("provider probe is the only host-sentinel spawn site (single source of truth)", () => {
    const source = readSource("provider.ts");
    // If a regression adds a second host-bypass spawn that doesn't
    // satisfy the routing-trio assertion above, this count drift fires.
    const sentinelMatches =
      source.match(/\[NAMESPACE_PROJECT_ENV\]:\s*NAMESPACE_HOST_SENTINEL/g) ?? [];
    expect(sentinelMatches.length).toBe(1);
  });
});
