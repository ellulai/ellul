// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// Unit-tests the pure wrapper-argv builder and the env-validator. The full
// integration through Effect's ChildProcessSpawner runs in
// packages/vps/test/integration/cgroup-placement.test.ts (Linux + cgroup-v2
// only) and in the chaos suite — see docs/v2/architecture/resource-v2/15-chaos-suite.md.

import { describe, expect, it } from "vitest";
import {
  NAMESPACE_ADAPTER_ENV,
  NAMESPACE_FORWARD_ENV,
  NAMESPACE_PROJECT_ENV,
  NAMESPACE_SCOPE_ID_ENV,
  NAMESPACE_SOFT_HINT_MB_ENV,
  buildHostScopeWrappedArgs,
  buildScopeWrappedArgs,
  extractForwardEnv,
  readScopeRoutingFromEnv,
} from "./namespace-spawner";

describe("buildScopeWrappedArgs", () => {
  it("composes the full sudo + spawn-scope + namespace + inner argv", () => {
    const args = buildScopeWrappedArgs("sbx-abc1234", {
      adapter: "opencode",
      scopeId: "pool1",
      softHintMB: 1536,
    });
    expect(args).toEqual([
      "-n",
      "/usr/local/bin/ellul-spawn-scope",
      "ellul-user-workload-sbx-abc1234.slice",
      "ellul-pool-sbx-abc1234-opencode-pool1",
      "MemoryHigh=1536M,MemorySwapMax=0,TasksMax=512",
      "--",
      "/usr/local/bin/ellul-agent-namespace",
      "enter",
      "sbx-abc1234",
      "--",
    ]);
  });

  it("varies adapter and scope id correctly", () => {
    const args = buildScopeWrappedArgs("sbx-def5678", {
      adapter: "cursor",
      scopeId: "thr-9",
      softHintMB: 2048,
    });
    // Positional layout: [-n, spawn-scope-bin, slice, unit, props, --, ns-bin, enter, project, --]
    expect(args[2]).toBe("ellul-user-workload-sbx-def5678.slice");
    expect(args[3]).toBe("ellul-pool-sbx-def5678-cursor-thr-9");
    expect(args[4]).toBe("MemoryHigh=2048M,MemorySwapMax=0,TasksMax=512");
  });
});

describe("buildHostScopeWrappedArgs", () => {
  it("composes the host-mode wrapper without a namespace nest", () => {
    const args = buildHostScopeWrappedArgs({
      adapter: "opencode",
      scopeId: "p1",
      softHintMB: 768,
    });
    // Positional layout: [-n, spawn-scope-bin, slice, unit, props, --]
    // No `ellul-agent-namespace enter <project>` — probes need host
    // network and must NOT enter a project namespace.
    expect(args).toEqual([
      "-n",
      "/usr/local/bin/ellul-spawn-scope",
      "ellul-user-workload.slice",
      "ellul-probe-opencode-p1",
      "MemoryHigh=768M,MemorySwapMax=0,TasksMax=512",
      "--",
    ]);
  });

  it("uses the shared host slice for every adapter (no per-sandbox)", () => {
    for (const adapter of ["claude", "opencode", "cursor", "codex"]) {
      const args = buildHostScopeWrappedArgs({
        adapter,
        scopeId: "p1",
        softHintMB: 512,
      });
      expect(args[2]).toBe("ellul-user-workload.slice");
      expect(args[3]).toBe(`ellul-probe-${adapter}-p1`);
    }
  });

  it("never includes an ellul-agent-namespace step", () => {
    const args = buildHostScopeWrappedArgs({
      adapter: "cursor",
      scopeId: "p99",
      softHintMB: 1024,
    });
    // Defense-in-depth: the host-mode probe must not nest namespace
    // entry. If a future patch confuses the host-mode wrapper with the
    // per-sandbox pool wrapper this fails loud.
    expect(args).not.toContain("/usr/local/bin/ellul-agent-namespace");
    expect(args).not.toContain("enter");
  });
});

describe("readScopeRoutingFromEnv", () => {
  it("returns null when no scope env vars set", () => {
    expect(readScopeRoutingFromEnv({ [NAMESPACE_PROJECT_ENV]: "sbx-abc1234" })).toBeNull();
  });

  it("returns ScopeRouting when all three set and valid", () => {
    const r = readScopeRoutingFromEnv({
      [NAMESPACE_PROJECT_ENV]: "sbx-abc1234",
      [NAMESPACE_ADAPTER_ENV]: "opencode",
      [NAMESPACE_SCOPE_ID_ENV]: "pool1",
      [NAMESPACE_SOFT_HINT_MB_ENV]: "1536",
    });
    expect(r).toEqual({ adapter: "opencode", scopeId: "pool1", softHintMB: 1536 });
  });

  it("returns 'malformed' when adapter missing but scope set", () => {
    expect(
      readScopeRoutingFromEnv({
        [NAMESPACE_SCOPE_ID_ENV]: "pool1",
        [NAMESPACE_SOFT_HINT_MB_ENV]: "1536",
      }),
    ).toBe("malformed");
  });

  it("returns 'malformed' on unknown adapter", () => {
    expect(
      readScopeRoutingFromEnv({
        [NAMESPACE_ADAPTER_ENV]: "evil",
        [NAMESPACE_SCOPE_ID_ENV]: "pool1",
        [NAMESPACE_SOFT_HINT_MB_ENV]: "1536",
      }),
    ).toBe("malformed");
  });

  it("returns 'malformed' on too-large soft hint", () => {
    expect(
      readScopeRoutingFromEnv({
        [NAMESPACE_ADAPTER_ENV]: "opencode",
        [NAMESPACE_SCOPE_ID_ENV]: "pool1",
        [NAMESPACE_SOFT_HINT_MB_ENV]: "999999",
      }),
    ).toBe("malformed");
  });

  it("returns 'malformed' on zero or negative soft hint", () => {
    for (const bad of ["0", "-1", "abc"]) {
      expect(
        readScopeRoutingFromEnv({
          [NAMESPACE_ADAPTER_ENV]: "opencode",
          [NAMESPACE_SCOPE_ID_ENV]: "pool1",
          [NAMESPACE_SOFT_HINT_MB_ENV]: bad,
        }),
      ).toBe("malformed");
    }
  });

  it("returns 'malformed' on scope id with disallowed characters", () => {
    expect(
      readScopeRoutingFromEnv({
        [NAMESPACE_ADAPTER_ENV]: "opencode",
        [NAMESPACE_SCOPE_ID_ENV]: "pool/1",
        [NAMESPACE_SOFT_HINT_MB_ENV]: "1536",
      }),
    ).toBe("malformed");
  });

  it("returns 'malformed' on scope id over 32 chars", () => {
    expect(
      readScopeRoutingFromEnv({
        [NAMESPACE_ADAPTER_ENV]: "opencode",
        [NAMESPACE_SCOPE_ID_ENV]: "p".repeat(33),
        [NAMESPACE_SOFT_HINT_MB_ENV]: "1536",
      }),
    ).toBe("malformed");
  });

  it("accepts every supported adapter", () => {
    for (const adapter of ["claude", "opencode", "cursor", "codex"]) {
      expect(
        readScopeRoutingFromEnv({
          [NAMESPACE_ADAPTER_ENV]: adapter,
          [NAMESPACE_SCOPE_ID_ENV]: "p1",
          [NAMESPACE_SOFT_HINT_MB_ENV]: "1024",
        }),
      ).toEqual({ adapter, scopeId: "p1", softHintMB: 1024 });
    }
  });
});

describe("extractForwardEnv", () => {
  it("returns null when ELLUL_NS_FWD is not set", () => {
    expect(extractForwardEnv({ FOO: "bar" })).toBeNull();
  });

  it("returns null when ELLUL_NS_FWD is empty", () => {
    expect(extractForwardEnv({ [NAMESPACE_FORWARD_ENV]: "" })).toBeNull();
  });

  it("extracts requested keys", () => {
    const result = extractForwardEnv({
      [NAMESPACE_FORWARD_ENV]: "FOO,BAR",
      FOO: "hello",
      BAR: "world",
    });
    expect(result).not.toBeNull();
    expect(result!.get("FOO")).toBe("hello");
    expect(result!.get("BAR")).toBe("world");
    expect(result!.size).toBe(2);
  });

  it("skips keys that are not present in env", () => {
    const result = extractForwardEnv({
      [NAMESPACE_FORWARD_ENV]: "FOO,MISSING",
      FOO: "hello",
    });
    expect(result!.size).toBe(1);
    expect(result!.get("FOO")).toBe("hello");
  });

  it("rejects internal namespace keys (prevents routing var override)", () => {
    for (const forbidden of [
      NAMESPACE_PROJECT_ENV,
      NAMESPACE_ADAPTER_ENV,
      NAMESPACE_SCOPE_ID_ENV,
      NAMESPACE_SOFT_HINT_MB_ENV,
      NAMESPACE_FORWARD_ENV,
    ]) {
      const result = extractForwardEnv({
        [NAMESPACE_FORWARD_ENV]: forbidden,
        [forbidden]: "injected-value",
      });
      expect(result).toBeNull();
    }
  });

  it("rejects key names that could enable shell injection", () => {
    for (const bad of [
      "FOO BAR",
      "FOO;rm -rf /",
      "FOO'BAR",
      "123ABC",
      "FOO=BAR",
      "",
      "FOO\nBAR",
    ]) {
      const result = extractForwardEnv({
        [NAMESPACE_FORWARD_ENV]: bad,
        [bad]: "value",
      });
      expect(result).toBeNull();
    }
  });

  it("accepts POSIX-valid env var names", () => {
    const result = extractForwardEnv({
      [NAMESPACE_FORWARD_ENV]: "OPENCODE_CONFIG_CONTENT,_PRIVATE,A",
      OPENCODE_CONFIG_CONTENT: '{"mcp":{}}',
      _PRIVATE: "ok",
      A: "single",
    });
    expect(result!.size).toBe(3);
  });

  it("handles whitespace in the key list", () => {
    const result = extractForwardEnv({
      [NAMESPACE_FORWARD_ENV]: " FOO , BAR ",
      FOO: "a",
      BAR: "b",
    });
    expect(result!.size).toBe(2);
  });
});
