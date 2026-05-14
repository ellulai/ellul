// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { resolveCdnUrl } from "../src/request";

describe("resolveCdnUrl", () => {
  const ENV_KEYS = [
    "TRANSLATIONS_CDN_URL",
    "WEB_TRANSLATIONS_CDN_URL",
    "CONSOLE_TRANSLATIONS_CDN_URL",
    "VPS_UI_TRANSLATIONS_CDN_URL",
    "DOCS_TRANSLATIONS_CDN_URL",
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("returns undefined when no env is set", () => {
    expect(resolveCdnUrl("web")).toBeUndefined();
  });

  it("returns global TRANSLATIONS_CDN_URL when only that is set", () => {
    process.env.TRANSLATIONS_CDN_URL = "https://cdn.example/locales";
    expect(resolveCdnUrl("web")).toBe("https://cdn.example/locales");
    expect(resolveCdnUrl("console")).toBe("https://cdn.example/locales");
  });

  it("per-surface env overrides the global one", () => {
    process.env.TRANSLATIONS_CDN_URL = "https://global.example";
    process.env.WEB_TRANSLATIONS_CDN_URL = "https://web.example";
    expect(resolveCdnUrl("web")).toBe("https://web.example");
    expect(resolveCdnUrl("console")).toBe("https://global.example");
  });

  it("normalizes surface names with non-alphanumeric chars (vps-ui → VPS_UI)", () => {
    process.env.VPS_UI_TRANSLATIONS_CDN_URL = "https://vpsui.example";
    expect(resolveCdnUrl("vps-ui")).toBe("https://vpsui.example");
  });

  it("only the per-surface env, no global, returns the surface value", () => {
    process.env.CONSOLE_TRANSLATIONS_CDN_URL = "https://console.example";
    expect(resolveCdnUrl("console")).toBe("https://console.example");
    expect(resolveCdnUrl("web")).toBeUndefined();
  });
});
