// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeAll } from "vitest";
import { getSpawnScopeScript, getSpawnScopeSudoers } from "./spawn-scope";

// These tests run the wrapper script's argument validation in a controlled
// environment. They DO NOT invoke systemd-run (we stub it). The point is to
// verify validation logic that gates the privileged exec.

let scriptPath: string;
let stubBin: string;

beforeAll(() => {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "spawn-scope-test-"));
  scriptPath = join(dir, "ellul-spawn-scope");
  // Substitute /bin/systemd-run with a stub that just echoes its argv
  // so we can assert what was about to be exec'd without root.
  stubBin = join(dir, "systemd-run-stub");
  writeFileSync(stubBin, `#!/bin/bash\nfor a in "$@"; do echo "ARG:$a"; done\n`, { mode: 0o755 });
  chmodSync(stubBin, 0o755);
  // Patch the script to use the stub
  const body = getSpawnScopeScript().replace("/bin/systemd-run", stubBin);
  writeFileSync(scriptPath, body, { mode: 0o755 });
  chmodSync(scriptPath, 0o755);
});

function runScope(args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("bash", [scriptPath, ...args], { encoding: "utf8" });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

describe("ellul-spawn-scope (wrapper script)", () => {
  it("accepts valid sandbox slice + pool unit + memory props", () => {
    if (process.platform !== "linux" && process.platform !== "darwin") return;
    const r = runScope([
      "ellul-user-workload-sbx-abc1234.slice",
      "ellul-pool-sbx-abc1234-opencode-scope1",
      "MemoryHigh=1536M,MemorySwapMax=0,TasksMax=512",
      "--",
      "/bin/echo", "hello",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ARG:--scope");
    expect(r.stdout).toContain("ARG:--slice=ellul-user-workload-sbx-abc1234.slice");
    expect(r.stdout).toContain("ARG:--unit=ellul-pool-sbx-abc1234-opencode-scope1");
    expect(r.stdout).toContain("ARG:--property=MemoryHigh=1536M");
    expect(r.stdout).toContain("ARG:--property=MemorySwapMax=0");
    expect(r.stdout).toContain("ARG:--property=TasksMax=512");
    expect(r.stdout).toContain("ARG:/bin/echo");
    expect(r.stdout).toContain("ARG:hello");
  });

  it("accepts ellul-user-workload.slice + Pro Claude slot unit", () => {
    if (process.platform !== "linux" && process.platform !== "darwin") return;
    const r = runScope([
      "ellul-user-workload.slice",
      "ellul-pro-claude-slot1",
      "MemoryHigh=320M,TasksMax=256",
      "--",
      "/bin/echo", "pro",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ARG:--unit=ellul-pro-claude-slot1");
  });

  it("accepts ellul-user-workload.slice + probe unit for every adapter", () => {
    if (process.platform !== "linux" && process.platform !== "darwin") return;
    for (const adapter of ["claude", "opencode", "cursor", "codex"]) {
      const r = runScope([
        "ellul-user-workload.slice",
        `ellul-probe-${adapter}-p1`,
        "MemoryHigh=768M,MemorySwapMax=0,TasksMax=512",
        "--",
        "/bin/echo", adapter,
      ]);
      expect(r.code, `adapter=${adapter}`).toBe(0);
      expect(r.stdout).toContain(`ARG:--unit=ellul-probe-${adapter}-p1`);
    }
  });

  it("rejects unknown adapter in probe unit name", () => {
    if (process.platform !== "linux" && process.platform !== "darwin") return;
    const r = runScope([
      "ellul-user-workload.slice",
      "ellul-probe-evil-p1",
      "MemoryHigh=768M",
      "--",
      "/bin/echo",
    ]);
    expect(r.code).toBe(65);
    expect(r.stderr).toContain("invalid unit");
  });

  it("rejects probe unit with disallowed scope-id chars", () => {
    if (process.platform !== "linux" && process.platform !== "darwin") return;
    const r = runScope([
      "ellul-user-workload.slice",
      "ellul-probe-opencode-../etc",
      "MemoryHigh=768M",
      "--",
      "/bin/echo",
    ]);
    expect(r.code).toBe(65);
    expect(r.stderr).toContain("invalid unit");
  });

  it("rejects probe unit with empty scope-id", () => {
    if (process.platform !== "linux" && process.platform !== "darwin") return;
    const r = runScope([
      "ellul-user-workload.slice",
      "ellul-probe-opencode-",
      "MemoryHigh=768M",
      "--",
      "/bin/echo",
    ]);
    expect(r.code).toBe(65);
    expect(r.stderr).toContain("invalid unit");
  });

  it("rejects unknown slice", () => {
    if (process.platform !== "linux" && process.platform !== "darwin") return;
    const r = runScope([
      "evil-slice.slice",
      "ellul-pool-sbx-abc1234-opencode-scope1",
      "MemoryHigh=1G",
      "--",
      "/bin/echo",
    ]);
    expect(r.code).toBe(65);
    expect(r.stderr).toContain("invalid slice");
  });

  it("rejects unknown adapter in unit name", () => {
    if (process.platform !== "linux" && process.platform !== "darwin") return;
    const r = runScope([
      "ellul-user-workload-sbx-abc1234.slice",
      "ellul-pool-sbx-abc1234-evil-scope1",
      "MemoryHigh=1G",
      "--",
      "/bin/echo",
    ]);
    expect(r.code).toBe(65);
    expect(r.stderr).toContain("invalid unit");
  });

  it("rejects malformed sandbox id (wrong length)", () => {
    if (process.platform !== "linux" && process.platform !== "darwin") return;
    const r = runScope([
      "ellul-user-workload-sbx-abc.slice",
      "ellul-pool-sbx-abc1234-opencode-s1",
      "MemoryHigh=1G",
      "--",
      "/bin/echo",
    ]);
    expect(r.code).toBe(65);
    expect(r.stderr).toContain("invalid slice");
  });

  it("rejects unknown property name", () => {
    if (process.platform !== "linux" && process.platform !== "darwin") return;
    const r = runScope([
      "ellul-user-workload-sbx-abc1234.slice",
      "ellul-pool-sbx-abc1234-opencode-s1",
      "LimitCORE=unlimited",
      "--",
      "/bin/echo",
    ]);
    expect(r.code).toBe(65);
    expect(r.stderr).toContain("invalid property");
  });

  it("rejects 'unlimited' value (only numeric values allowed)", () => {
    if (process.platform !== "linux" && process.platform !== "darwin") return;
    const r = runScope([
      "ellul-user-workload-sbx-abc1234.slice",
      "ellul-pool-sbx-abc1234-opencode-s1",
      "MemoryMax=unlimited",
      "--",
      "/bin/echo",
    ]);
    expect(r.code).toBe(65);
    expect(r.stderr).toContain("invalid property");
  });

  it("rejects missing -- separator", () => {
    if (process.platform !== "linux" && process.platform !== "darwin") return;
    // Pass 5 args where the 4th (where -- should be) is not the literal --.
    const r = runScope([
      "ellul-user-workload-sbx-abc1234.slice",
      "ellul-pool-sbx-abc1234-opencode-s1",
      "MemoryHigh=1G",
      "/bin/echo", // wrong: this is supposed to be '--'
      "hi",
    ]);
    expect(r.code).toBe(64);
    expect(r.stderr).toContain("expected '--'");
  });

  it("accepts ellul-user-workload.slice + install unit", () => {
    if (process.platform !== "linux" && process.platform !== "darwin") return;
    const r = runScope([
      "ellul-user-workload.slice",
      "ellul-install-my_app-project",
      "MemoryMax=2048M,MemorySwapMax=0",
      "--",
      "/bin/echo", "installing",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ARG:--slice=ellul-user-workload.slice");
    expect(r.stdout).toContain("ARG:--unit=ellul-install-my_app-project");
    expect(r.stdout).toContain("ARG:--property=MemoryMax=2048M");
    expect(r.stdout).toContain("ARG:--property=MemorySwapMax=0");
  });

  it("accepts empty properties string (no caps)", () => {
    if (process.platform !== "linux" && process.platform !== "darwin") return;
    const r = runScope([
      "ellul-user-workload-sbx-abc1234.slice",
      "ellul-pool-sbx-abc1234-opencode-s1",
      "",
      "--",
      "/bin/echo", "noprops",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ARG:--scope");
    expect(r.stdout).not.toContain("ARG:--property=");
  });

  it("rejects path-escape attempt in slice name", () => {
    if (process.platform !== "linux" && process.platform !== "darwin") return;
    const r = runScope([
      "ellul-user-workload-sbx-../etc.slice",
      "ellul-pool-sbx-abc1234-opencode-s1",
      "MemoryHigh=1G",
      "--",
      "/bin/echo",
    ]);
    expect(r.code).toBe(65);
  });
});

describe("ellul-spawn-scope sudoers entry", () => {
  it("contains exactly the wrapper path with NOPASSWD", () => {
    const s = getSpawnScopeSudoers("dev");
    expect(s).toContain("dev ALL=(root) NOPASSWD: /usr/local/bin/ellul-spawn-scope");
  });
  it("does not contain any arg-matching wildcards (validation is in-script)", () => {
    const s = getSpawnScopeSudoers("dev");
    expect(s).not.toMatch(/NOPASSWD: \/usr\/local\/bin\/ellul-spawn-scope\s+\*/);
  });
  it("supports svcUser=coder", () => {
    const s = getSpawnScopeSudoers("coder");
    expect(s).toContain("coder ALL=(root) NOPASSWD: /usr/local/bin/ellul-spawn-scope");
  });
});
