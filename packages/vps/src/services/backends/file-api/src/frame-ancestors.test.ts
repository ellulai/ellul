// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { frameAncestorOrigins, frameAncestorsValue } from "./frame-ancestors";

function tmp(content: string): string {
  const p = path.join(os.tmpdir(), `fa-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(p, content);
  return p;
}
const missing = () => path.join(os.tmpdir(), `fa-missing-${Math.random().toString(36).slice(2)}`);

afterEach(() => {
  delete process.env.CONSOLE_ORIGINS_PATH;
  delete process.env.CONSOLE_ORIGIN_PATH;
});

describe("frameAncestorOrigins", () => {
  it("prefers the plural console-origins file, split on whitespace/newlines", () => {
    process.env.CONSOLE_ORIGINS_PATH = tmp("https://console.acme.gg https://acme.gg\nhttps://b.gg");
    process.env.CONSOLE_ORIGIN_PATH = tmp("https://console.ellul.ai");
    expect(frameAncestorOrigins()).toEqual(["https://console.acme.gg", "https://acme.gg", "https://b.gg"]);
  });
  it("falls back to the singular console-origin when the plural file is absent", () => {
    process.env.CONSOLE_ORIGINS_PATH = missing();
    process.env.CONSOLE_ORIGIN_PATH = tmp("https://console.ellul.ai");
    expect(frameAncestorOrigins()).toEqual(["https://console.ellul.ai"]);
  });
  it("falls back when the plural file is present but empty", () => {
    process.env.CONSOLE_ORIGINS_PATH = tmp("   \n  ");
    process.env.CONSOLE_ORIGIN_PATH = tmp("https://console.ellul.ai");
    expect(frameAncestorOrigins()).toEqual(["https://console.ellul.ai"]);
  });
  it("returns [] when neither file exists", () => {
    process.env.CONSOLE_ORIGINS_PATH = missing();
    process.env.CONSOLE_ORIGIN_PATH = missing();
    expect(frameAncestorOrigins()).toEqual([]);
  });
});

describe("frameAncestorsValue", () => {
  it("prefixes 'self'", () => {
    process.env.CONSOLE_ORIGINS_PATH = tmp("https://console.acme.gg");
    expect(frameAncestorsValue()).toBe("'self' https://console.acme.gg");
  });
  it("is just 'self' when no origins are configured", () => {
    process.env.CONSOLE_ORIGINS_PATH = missing();
    process.env.CONSOLE_ORIGIN_PATH = missing();
    expect(frameAncestorsValue()).toBe("'self'");
  });
});
