// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// Static security audit for the Claude adapters. Greps the source for
// patterns that, if present in the wrong file, would silently break the
// security envelope (OAT subsystem, namespace boundary, danger flag).

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");

const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("Claude adapter security invariants", () => {
  describe("--dangerously-skip-permissions flag", () => {
    it("appears in the Lite tier's args builder", () => {
      const liteArgs = read("shared/args.ts");
      expect(liteArgs).toContain("--dangerously-skip-permissions");
    });

    it("appears in the Pro (SDK) adapter via extraArgs", () => {
      // claude-code's SDK `sandbox: { enabled: false }` option does not
      // reliably disable bwrap — the binary ignores the --settings JSON
      // path. The only first-class flag that prevents bwrap (and the
      // resulting exit-133 SIGTRAP from our seccomp filter) is
      // --dangerously-skip-permissions. Same rationale as codex's
      // `sandbox: "danger-full-access"` — our outer namespace IS the
      // security boundary.
      const sdk = read("adapter.sdk.ts");
      expect(sdk).toMatch(/["']dangerously-skip-permissions["']/);
    });

    it("does NOT appear in the Lite adapter source (it lives in argv via args.ts)", () => {
      const lite = read("adapter.lite.ts");
      expect(lite).not.toMatch(/--dangerously-skip-permissions/);
    });

    it("appears in the thread-title generation argv", () => {
      const titleGen = fs.readFileSync(
        path.join(ROOT, "..", "..", "text-generation", "claude.ts"),
        "utf8",
      );
      expect(titleGen).toContain("--dangerously-skip-permissions");
    });
  });

  describe("OAT credential isolation", () => {
    it("Lite adapter does not read CLAUDE_CODE_OAUTH_TOKEN from process.env", () => {
      // The OAT only ever lives in the spawned process's env via the
      // launcher. Bridge reading it directly would defeat the credential
      // subsystem.
      const lite = read("adapter.lite.ts");
      expect(lite).not.toMatch(/process\.env\.CLAUDE_CODE_OAUTH_TOKEN/);
      expect(lite).not.toMatch(/process\.env\[['"]CLAUDE_CODE_OAUTH_TOKEN/);
    });

    it("Lite adapter does not read ~/.claude.json or .claude.json directly", () => {
      const lite = read("adapter.lite.ts");
      expect(lite).not.toMatch(/\.claude\.json/);
    });

    it("Lite adapter routes spawn env through the shared mintLaunchEnv helper", () => {
      // `mintLaunchEnv` is the single chokepoint that pairs the ns wrapper
      // path with the OAT env. Asserting Lite reaches it (instead of
      // calling getClaudeOatBridgeModule() directly) keeps the contract on
      // a function signature instead of an honour system.
      const lite = read("adapter.lite.ts");
      expect(lite).toContain("mintLaunchEnv");
      expect(lite).not.toMatch(/getClaudeOatBridgeModule\(\)\.issueToken/);
    });

    it("mintLaunchEnv issues and redeems OAT via the bridge module", () => {
      const helper = read("launch-env.ts");
      expect(helper).toContain("getClaudeOatBridgeModule");
      expect(helper).toContain("issueToken");
      expect(helper).toContain("redeemToken");
      expect(helper).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    });
  });

  describe("namespace boundary", () => {
    it("mintLaunchEnv always sets ELLUL_NS_PROJECT on the produced env", () => {
      // ellul-claude-ns reads ELLUL_NS_PROJECT to decide which project
      // namespace to enter. Missing it triggers fail-closed (exit 64).
      const helper = read("launch-env.ts");
      expect(helper).toContain("ELLUL_NS_PROJECT: input.projectId");
    });

    it("Lite adapter spawn target comes from launchEnv.launcherPath, never a literal 'claude'", () => {
      const lite = read("adapter.lite.ts");
      // Hand-off from the helper into spawnClaudeProcess uses
      // `binaryPath: launchEnv.launcherPath` — the helper enforces the
      // pairing with the issuance-token env.
      expect(lite).toMatch(/binaryPath:\s*launchEnv\.launcherPath/);
      // No literal "claude" string used as a binary path.
      expect(lite).not.toMatch(/binary:\s*['"]claude['"]/);
      expect(lite).not.toMatch(/nodeSpawn\(['"]claude['"]/);
      // No path that reaches for the probe-only claudePath.
      expect(lite).not.toMatch(/\.claudePath/);
    });

    it("Lite adapter spawns via Node child_process directly (launcher does NS entry)", () => {
      // Routing through NamespaceChildProcessSpawner would double-wrap the
      // launcher with `sudo ellul-agent-namespace enter` and trip the
      // outer seccomp filter on the second unshare(2).
      const lite = read("adapter.lite.ts");
      expect(lite).toContain('from "node:child_process"');
      expect(lite).not.toMatch(/NamespaceChildProcessSpawner/);
    });
  });

  describe("session binding", () => {
    it("--session-id is baked into argv at the args builder", () => {
      const args = read("shared/args.ts");
      expect(args).toContain('"--session-id"');
      expect(args).toContain("input.sessionId");
    });

    it("Lite adapter passes the same sessionId for every turn within a session", () => {
      // sessionId is set on context creation and only mutated when a new
      // session.id event arrives from the parser. sendTurn reads it from
      // context, never from the input.
      const lite = read("adapter.lite.ts");
      expect(lite).toMatch(/sessionId:\s*context\.sessionId/);
    });
  });
});
