// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// `bash -n` parse check on every shipped namespace artifact, plus a
// regex scanner for unescaped contractions inside `bash -c '...'` blocks.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getAgentNamespaceScript, getNsShellScript } from "./index";
import { getClaudeNsScript, getCodexNsScript } from "../namespace-wrappers";

function bashParseCheck(name: string, body: string): { ok: boolean; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "ellul-ns-bash-syntax-"));
  const out = join(dir, name);
  writeFileSync(out, body);
  const r = spawnSync("bash", ["-n", out], { encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  return { ok: r.status === 0, stderr: r.stderr || "" };
}

describe("namespace shell artifacts: bash -n parse invariant", () => {
  it("agent-namespace.sh", () => {
    const body = getAgentNamespaceScript();
    expect(body).toContain("#!/bin/bash");
    const { ok, stderr } = bashParseCheck("agent-namespace.sh", body);
    expect(ok, stderr).toBe(true);
  });

  it("claude-ns.sh", () => {
    const { ok, stderr } = bashParseCheck("claude-ns.sh", getClaudeNsScript());
    expect(ok, stderr).toBe(true);
  });

  it("codex-ns.sh", () => {
    const { ok, stderr } = bashParseCheck("codex-ns.sh", getCodexNsScript());
    expect(ok, stderr).toBe(true);
  });

  it("ns-shell.sh", () => {
    const { ok, stderr } = bashParseCheck("ns-shell.sh", getNsShellScript());
    expect(ok, stderr).toBe(true);
  });
});

describe("spawn.sh inner bash -c '...' wrapper: apostrophe trap regression", () => {
  it("inner bash block contains no unescaped contractions", () => {
    const body = getAgentNamespaceScript();
    const lines = body.split("\n");
    let blockStart = -1;
    const offenders: Array<{ line: number; content: string }> = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (blockStart === -1 && /bash -c '\s*$/.test(line)) {
        blockStart = i + 1;
        continue;
      }
      if (blockStart !== -1 && /^\s*'(\s*--.*)?$/.test(line)) {
        blockStart = -1;
        continue;
      }
      if (blockStart !== -1) {
        const stripped = line.replace(/'"'"'/g, "");
        if (/[A-Za-z]'[A-Za-z]/.test(stripped)) {
          offenders.push({ line: i + 1, content: line });
        }
      }
    }
    expect(
      offenders,
      `Unescaped contractions in inner bash -c '...' block:\n` +
        offenders.map((o) => `  line ${o.line}: ${o.content.trim()}`).join("\n"),
    ).toEqual([]);
  });
});
