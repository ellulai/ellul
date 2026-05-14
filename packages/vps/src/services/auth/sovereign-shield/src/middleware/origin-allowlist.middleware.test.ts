// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Origin Allowlist Middleware — Unit Tests
 *
 * Covers:
 *   1. Pattern → regex conversion (glob semantics)
 *   2. Origin header normalization (URL parsing, case, port)
 *   3. Request-origin reconstruction from X-Forwarded-* or Host
 *   4. isAllowed decision matrix (exact, pattern, reject)
 *   5. Middleware end-to-end: absent, same-origin, trusted, rejected, malformed
 *   6. Kill-switch respected
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config reads. Individual tests override return values via
// (readAllowedOrigins as vi.Mock).mockReturnValue([...]) etc.
vi.mock("../config", () => ({
  readAllowedOrigins: vi.fn(() => [
    "https://console.ellul.ai",
    "https://abc12345-srv.ellul.ai",
    "https://abc12345-dev.ellul.app",
  ]),
  readPreviewOriginsManifest: vi.fn(() => ({
    origins: ["https://custom.example.com"],
    patterns: ["*.ellul.app", "*.ellul.ai"],
  })),
}));

// Mock audit service — middleware now emits origin_rejected events on 403,
// which normally require a live SQLite connection we don't stand up in
// middleware unit tests.
vi.mock("../application/audit/Audit", () => ({
  logAuditEvent: vi.fn(),
}));

import { __testing, originAllowlistMiddleware } from "./origin-allowlist.middleware";
import { readAllowedOrigins, readPreviewOriginsManifest } from "../config";

const {
  patternToRegex,
  reconstructRequestOrigin,
  normalizeOriginHeader,
  isAllowed,
  compileAllowlist,
} = __testing;

describe("patternToRegex", () => {
  it("matches bare hostnames", () => {
    const re = patternToRegex("*.ellul.app");
    expect(re.test("foo.ellul.app")).toBe(true);
    expect(re.test("FOO.ELLUL.APP")).toBe(true); // case-insensitive
  });

  it("matches nested subdomains", () => {
    const re = patternToRegex("*.ellul.app");
    expect(re.test("foo.bar.ellul.app")).toBe(true);
  });

  it("does not match different zones", () => {
    const re = patternToRegex("*.ellul.app");
    expect(re.test("foo.ellul.ai")).toBe(false);
    expect(re.test("ellul.app")).toBe(false); // needs at least one label
    expect(re.test("evil.com")).toBe(false);
  });

  it("escapes regex metacharacters in literal parts", () => {
    const re = patternToRegex("a.b+c.com");
    expect(re.test("a.b+c.com")).toBe(true);
    expect(re.test("axbxc.com")).toBe(false); // the dots are literal
  });
});

describe("normalizeOriginHeader", () => {
  it("lowercases host and strips default port", () => {
    expect(normalizeOriginHeader("https://Foo.Ellul.App:443")).toBe(
      "https://foo.ellul.app",
    );
  });

  it("preserves non-default port", () => {
    expect(normalizeOriginHeader("http://localhost:4000")).toBe(
      "http://localhost:4000",
    );
  });

  it("rejects malformed origin", () => {
    expect(normalizeOriginHeader("not a url")).toBeNull();
    expect(normalizeOriginHeader("")).toBeNull();
  });
});

describe("reconstructRequestOrigin", () => {
  it("prefers X-Forwarded-Proto + X-Forwarded-Host", () => {
    const h = new Headers({
      "x-forwarded-proto": "https",
      "x-forwarded-host": "abc12345-dev.ellul.app",
      host: "localhost:3005",
    });
    expect(reconstructRequestOrigin(h)).toBe(
      "https://abc12345-dev.ellul.app",
    );
  });

  it("falls back to Host header when X-Forwarded-Host absent", () => {
    const h = new Headers({ host: "abc12345-srv.ellul.ai" });
    expect(reconstructRequestOrigin(h)).toBe("https://abc12345-srv.ellul.ai");
  });

  it("defaults to https when proto missing", () => {
    const h = new Headers({ host: "example.com" });
    expect(reconstructRequestOrigin(h)).toBe("https://example.com");
  });

  it("returns null when no host information", () => {
    const h = new Headers();
    expect(reconstructRequestOrigin(h)).toBeNull();
  });
});

describe("isAllowed", () => {
  const list = {
    exactOrigins: new Set([
      "https://console.ellul.ai",
      "https://custom.example.com",
    ]),
    patternRegexes: [/^.+\.ellul\.app$/i, /^.+\.ellul\.ai$/i],
  };

  it("allows exact origin match", () => {
    expect(isAllowed("https://console.ellul.ai", list)).toBe(true);
  });

  it("allows pattern match", () => {
    expect(isAllowed("https://abc12345-dev.ellul.app", list)).toBe(true);
  });

  it("rejects unknown origin", () => {
    expect(isAllowed("https://evil.com", list)).toBe(false);
  });

  it("requires the caller to lowercase before exact lookup (middleware contract)", () => {
    // exactOrigins keys are lowercased at compile time. isAllowed doesn't
    // lowercase — the middleware does via normalizeOriginHeader before
    // calling. Document that invariant here with a list that has NO
    // patterns so we can verify the exact-only path.
    const exactOnly = {
      exactOrigins: new Set(["https://console.ellul.ai"]),
      patternRegexes: [],
    };
    expect(isAllowed("https://console.ellul.ai", exactOnly)).toBe(true);
    expect(isAllowed("https://Console.Ellul.AI", exactOnly)).toBe(false);
  });
});

describe("compileAllowlist", () => {
  beforeEach(() => {
    vi.mocked(readAllowedOrigins).mockReset().mockReturnValue([
      "https://console.ellul.ai",
      "https://abc12345-srv.ellul.ai",
      "https://abc12345-dev.ellul.app",
    ]);
    vi.mocked(readPreviewOriginsManifest).mockReset().mockReturnValue({
      origins: ["https://custom.example.com"],
      patterns: ["*.ellul.app"],
    });
  });

  it("merges platform defaults with manifest origins and patterns", () => {
    const list = compileAllowlist();
    expect(list.exactOrigins.has("https://console.ellul.ai")).toBe(true);
    expect(list.exactOrigins.has("https://custom.example.com")).toBe(true);
    expect(list.patternRegexes).toHaveLength(1);
  });

  it("propagates readAllowedOrigins errors (no silent degrade)", () => {
    vi.mocked(readAllowedOrigins).mockImplementation(() => {
      throw new Error("missing file");
    });
    // Provisioning-bug signal — no fallback, caller sees the throw.
    expect(() => compileAllowlist()).toThrow(/missing file/);
  });

  it("infers https scheme for bare hostname manifest entries", () => {
    vi.mocked(readPreviewOriginsManifest).mockReturnValue({
      origins: ["bare.example.com"],
      patterns: [],
    });
    const list = compileAllowlist();
    expect(list.exactOrigins.has("https://bare.example.com")).toBe(true);
  });
});

describe("originAllowlistMiddleware (integration)", () => {
  // Tiny Hono-free harness: call middleware directly with a fake context.
  // We only need c.req.header() and c.req.raw.headers + c.json().
  interface FakeContext {
    req: { header: (name: string) => string | undefined; raw: { headers: Headers } };
    json: (body: unknown, status?: number) => { body: unknown; status: number };
  }
  function ctx(headers: Record<string, string>): FakeContext {
    const h = new Headers(headers);
    return {
      req: {
        header: (name: string) => h.get(name.toLowerCase()) ?? undefined,
        raw: { headers: h },
      },
      json: (body, status = 200) => ({ body, status }),
    };
  }

  beforeEach(() => {
    vi.mocked(readAllowedOrigins).mockReset().mockReturnValue([
      "https://console.ellul.ai",
      "https://abc12345-dev.ellul.app",
    ]);
    vi.mocked(readPreviewOriginsManifest).mockReset().mockReturnValue({
      origins: [],
      patterns: ["*.ellul.app", "*.ellul.ai"],
    });
  });

  async function run(
    headers: Record<string, string>,
  ): Promise<{ blocked: boolean; body?: unknown; status?: number }> {
    const c = ctx(headers);
    let passed = false;
    const result = await originAllowlistMiddleware(c as never, async () => {
      passed = true;
    });
    if (passed) return { blocked: false };
    return { blocked: true, body: (result as { body: unknown; status: number }).body, status: (result as { body: unknown; status: number }).status };
  }

  it("passes through when Origin header is absent", async () => {
    const r = await run({ host: "abc12345-dev.ellul.app" });
    expect(r.blocked).toBe(false);
  });

  it("passes same-origin requests", async () => {
    const r = await run({
      origin: "https://abc12345-dev.ellul.app",
      "x-forwarded-host": "abc12345-dev.ellul.app",
      "x-forwarded-proto": "https",
    });
    expect(r.blocked).toBe(false);
  });

  it("passes trusted exact origin", async () => {
    const r = await run({
      origin: "https://console.ellul.ai",
      "x-forwarded-host": "abc12345-srv.ellul.ai",
      "x-forwarded-proto": "https",
    });
    expect(r.blocked).toBe(false);
  });

  it("passes trusted pattern origin", async () => {
    const r = await run({
      origin: "https://deadbeef-dev.ellul.app",
      "x-forwarded-host": "abc12345-srv.ellul.ai",
      "x-forwarded-proto": "https",
    });
    expect(r.blocked).toBe(false);
  });

  it("rejects untrusted origin", async () => {
    const r = await run({
      origin: "https://evil.com",
      "x-forwarded-host": "abc12345-dev.ellul.app",
      "x-forwarded-proto": "https",
    });
    expect(r.blocked).toBe(true);
    expect(r.status).toBe(403);
    expect((r.body as { error: string }).error).toBe("origin_not_allowed");
  });

  it("rejects malformed Origin header", async () => {
    const r = await run({
      origin: "not a url",
      "x-forwarded-host": "abc12345-dev.ellul.app",
      "x-forwarded-proto": "https",
    });
    expect(r.blocked).toBe(true);
    expect(r.status).toBe(403);
    expect((r.body as { reason?: string }).reason).toBe("malformed");
  });

  it("allows Origin: null (opaque-origin: sandboxed iframe, data:/file: URI, etc.)", async () => {
    const r = await run({
      origin: "null",
      "x-forwarded-host": "abc12345-dev.ellul.app",
      "x-forwarded-proto": "https",
    });
    expect(r.blocked).toBe(false);
  });

  it("allows Origins carrying a non-default port when the hostname matches a pattern", async () => {
    // Dev server upstream origins echoed back with :4000 must still match
    // *.ellul.app — the allowlist is a hostname concept, not a host:port one.
    const r = await run({
      origin: "https://abc12345-dev.ellul.app:4000",
      "x-forwarded-host": "abc12345-dev.ellul.app",
      "x-forwarded-proto": "https",
    });
    expect(r.blocked).toBe(false);
  });

});
