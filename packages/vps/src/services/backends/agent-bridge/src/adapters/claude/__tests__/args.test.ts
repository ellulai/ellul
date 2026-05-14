// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// Coverage for the CLI args builder used by the Lite adapter.
//
// The builder is pure: deterministic mapping from { sessionId, cwd,
// modelSelection, primer, continueFlag, settings } to argv. These tests
// pin the contract so future settings additions don't accidentally
// change the spawn shape.

import { describe, expect, it } from "vitest";
import { applyEffortPrefix, buildClaudeArgs, formatStreamJsonUserMessage } from "../shared/args";
import type { ClaudeAgentSettings } from "../../../shared/serverSettings";

const baseSettings: ClaudeAgentSettings = {
  enabled: true,
  launcherPath: "/usr/local/bin/ellul-claude-ns",
  claudePath: "/home/dev/.node/bin/claude",
  customModels: [],
  launchArgs: "",
  runtimeMode: "lite",
  lite: { hotWindowMs: 30_000 },
};

describe("buildClaudeArgs — required flags", () => {
  it("includes -p, --verbose, --output-format stream-json, --input-format stream-json", () => {
    const { argv } = buildClaudeArgs({
      sessionId: "sess-1",
      cwd: "/projects/sbx-aaaaaaa",
      continueFlag: false,
      settings: baseSettings,
    });
    expect(argv).toContain("-p");
    expect(argv).toContain("--verbose");
    const outIdx = argv.indexOf("--output-format");
    expect(argv[outIdx + 1]).toBe("stream-json");
    const inIdx = argv.indexOf("--input-format");
    expect(argv[inIdx + 1]).toBe("stream-json");
  });

  it("always passes --dangerously-skip-permissions on Lite tier", () => {
    const { argv } = buildClaudeArgs({
      sessionId: "sess-1",
      cwd: "/projects/sbx-aaaaaaa",
      continueFlag: false,
      settings: baseSettings,
    });
    expect(argv).toContain("--dangerously-skip-permissions");
  });

  it("always passes --include-partial-messages so streaming text deltas arrive", () => {
    const { argv } = buildClaudeArgs({
      sessionId: "sess-1",
      cwd: "/projects/sbx-aaaaaaa",
      continueFlag: false,
      settings: baseSettings,
    });
    expect(argv).toContain("--include-partial-messages");
  });

  it("passes --session-id and --add-dir with the supplied values", () => {
    const { argv } = buildClaudeArgs({
      sessionId: "sess-deadbeef",
      cwd: "/projects/sbx-aaaaaaa/my-app",
      continueFlag: false,
      settings: baseSettings,
    });
    const sidIdx = argv.indexOf("--session-id");
    expect(argv[sidIdx + 1]).toBe("sess-deadbeef");
    const addDirIdx = argv.indexOf("--add-dir");
    expect(argv[addDirIdx + 1]).toBe("/projects/sbx-aaaaaaa/my-app");
  });
});

describe("buildClaudeArgs — continue + resume", () => {
  it("does NOT include --continue when continueFlag is false", () => {
    const { argv } = buildClaudeArgs({
      sessionId: "sess-1",
      cwd: "/projects/sbx-aaaaaaa",
      continueFlag: false,
      settings: baseSettings,
    });
    expect(argv).not.toContain("--continue");
  });

  it("includes --continue when continueFlag is true (resume from disk)", () => {
    const { argv } = buildClaudeArgs({
      sessionId: "sess-1",
      cwd: "/projects/sbx-aaaaaaa",
      continueFlag: true,
      settings: baseSettings,
    });
    expect(argv).toContain("--continue");
  });
});

describe("buildClaudeArgs — model selection", () => {
  it("emits --model with the resolved API id when provided", () => {
    const { argv, apiModelId } = buildClaudeArgs({
      sessionId: "sess-1",
      cwd: "/projects/sbx-aaaaaaa",
      continueFlag: false,
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-7",
        options: { contextWindow: "1m" },
      },
      settings: baseSettings,
    });
    expect(apiModelId).toBe("claude-opus-4-7[1m]");
    const modelIdx = argv.indexOf("--model");
    expect(argv[modelIdx + 1]).toBe("claude-opus-4-7[1m]");
  });

  it("omits --model when no selection provided", () => {
    const { argv, apiModelId } = buildClaudeArgs({
      sessionId: "sess-1",
      cwd: "/projects/sbx-aaaaaaa",
      continueFlag: false,
      settings: baseSettings,
    });
    expect(apiModelId).toBeUndefined();
    expect(argv).not.toContain("--model");
  });
});

describe("buildClaudeArgs — appendSystemPrompt", () => {
  it("emits --append-system-prompt only when injectedPrimer is non-empty", () => {
    const withPrimer = buildClaudeArgs({
      sessionId: "sess-1",
      cwd: "/projects/sbx-aaaaaaa",
      continueFlag: false,
      injectedPrimer: "Project context: my-app\nGoals: ship",
      settings: baseSettings,
    });
    const idx = withPrimer.argv.indexOf("--append-system-prompt");
    expect(idx).toBeGreaterThan(-1);
    expect(withPrimer.argv[idx + 1]).toBe("Project context: my-app\nGoals: ship");

    const withoutPrimer = buildClaudeArgs({
      sessionId: "sess-1",
      cwd: "/projects/sbx-aaaaaaa",
      continueFlag: false,
      injectedPrimer: null,
      settings: baseSettings,
    });
    expect(withoutPrimer.argv).not.toContain("--append-system-prompt");
  });

  it("treats whitespace-only injected primers as absent", () => {
    const { argv } = buildClaudeArgs({
      sessionId: "sess-1",
      cwd: "/projects/sbx-aaaaaaa",
      continueFlag: false,
      injectedPrimer: "   \n  \n",
      settings: baseSettings,
    });
    expect(argv).not.toContain("--append-system-prompt");
  });
});

describe("buildClaudeArgs — extra launch args", () => {
  it("appends launchArgs flags from settings, normalising to --flag form", () => {
    const { argv } = buildClaudeArgs({
      sessionId: "sess-1",
      cwd: "/projects/sbx-aaaaaaa",
      continueFlag: false,
      settings: { ...baseSettings, launchArgs: "--debug --max-tokens 4096" },
    });
    expect(argv).toContain("--debug");
    const idx = argv.indexOf("--max-tokens");
    expect(argv[idx + 1]).toBe("4096");
  });

  it("does not break when launchArgs is empty string", () => {
    const { argv } = buildClaudeArgs({
      sessionId: "sess-1",
      cwd: "/projects/sbx-aaaaaaa",
      continueFlag: false,
      settings: baseSettings,
    });
    // Required flags still present; no spurious empty entries.
    expect(argv).toContain("--session-id");
    expect(argv.every((a) => a.length > 0)).toBe(true);
  });
});

describe("applyEffortPrefix — prompt-injected effort", () => {
  it("prepends 'Ultrathink:\\n' when ultrathink effort is selected for Opus 4.7", () => {
    const result = applyEffortPrefix("write a function", {
      provider: "claudeAgent",
      model: "claude-opus-4-7",
      options: { effort: "ultrathink" },
    });
    expect(result).toBe("Ultrathink:\nwrite a function");
  });

  it("returns text unchanged when no model selection is provided", () => {
    expect(applyEffortPrefix("hello", undefined)).toBe("hello");
  });

  it("returns text unchanged when effort is not in the prompt-injected list", () => {
    const result = applyEffortPrefix("hello", {
      provider: "claudeAgent",
      model: "claude-opus-4-7",
      options: { effort: "high" },
    });
    expect(result).toBe("hello");
  });

  it("returns empty string for empty input even with ultrathink", () => {
    const result = applyEffortPrefix("", {
      provider: "claudeAgent",
      model: "claude-opus-4-7",
      options: { effort: "ultrathink" },
    });
    expect(result).toBe("");
  });
});

describe("formatStreamJsonUserMessage", () => {
  it("formats a user text message as a JSON line the CLI accepts", () => {
    const line = formatStreamJsonUserMessage({ text: "hello world" });
    const parsed = JSON.parse(line);
    expect(parsed).toMatchObject({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "hello world" }],
      },
    });
  });

  it("escapes newlines and quotes correctly via JSON.stringify", () => {
    const line = formatStreamJsonUserMessage({ text: 'multi\nline "quoted"' });
    expect(line).not.toContain("\n");
    const parsed = JSON.parse(line);
    expect(parsed.message.content[0].text).toBe('multi\nline "quoted"');
  });
});
