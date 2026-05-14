// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { describe, expect, it } from "vitest";
import {
  buildExecEnv,
  isValidIssuanceToken,
} from "../domain/exec-plan";

describe("buildExecEnv", () => {
  it("sets CLAUDE_CODE_OAUTH_TOKEN to the freshly-redeemed OAT", () => {
    const env = buildExecEnv({}, "sk-ant-oat01-X");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-X");
  });

  it("drops the issuance token from inherited env", () => {
    const env = buildExecEnv(
      { CLAUDE_OAT_ISSUANCE_TOKEN: "issuance-abc" },
      "sk-ant-oat01-X",
    );
    expect(env.CLAUDE_OAT_ISSUANCE_TOKEN).toBeUndefined();
  });

  it("strips any stale CLAUDE_CODE_OAUTH_TOKEN", () => {
    const env = buildExecEnv(
      { CLAUDE_CODE_OAUTH_TOKEN: "stale-token" },
      "sk-ant-oat01-FRESH",
    );
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-FRESH");
  });

  it("strips ANTHROPIC_API_KEY (defense — don't let stale BYOK override OAT)", () => {
    const env = buildExecEnv(
      { ANTHROPIC_API_KEY: "leftover" },
      "sk-ant-oat01-X",
    );
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("preserves arbitrary unrelated env vars", () => {
    const env = buildExecEnv(
      { PATH: "/usr/bin", HOME: "/home/dev", LANG: "en_US.UTF-8" },
      "sk-ant-oat01-X",
    );
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/dev");
    expect(env.LANG).toBe("en_US.UTF-8");
  });
});

describe("isValidIssuanceToken", () => {
  it("accepts 32 hex chars", () => {
    expect(isValidIssuanceToken("0123456789abcdef0123456789abcdef")).toBe(true);
  });
  it("rejects wrong length", () => {
    expect(isValidIssuanceToken("0123")).toBe(false);
  });
  it("rejects non-hex", () => {
    expect(isValidIssuanceToken("0123456789abcdef0123456789abcdeg")).toBe(false);
  });
  it("rejects undefined", () => {
    expect(isValidIssuanceToken(undefined)).toBe(false);
  });
});
