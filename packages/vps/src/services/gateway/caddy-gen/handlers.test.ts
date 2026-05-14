// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Caddy handler generator tests — the dev-route invariants we must never
 * regress. The actual Caddyfile output is large and mostly boilerplate, so we
 * assert on the *invariants* we care about rather than snapshotting every
 * byte (which would churn on unrelated edits).
 */

import { describe, it, expect } from "vitest";
import { generateInitialDevRoute } from "./handlers";
import { FRAMEWORK_DEV_PATHS } from "@vps/shared/framework";

describe("generateInitialDevRoute", () => {
  const devDomain = "abc12345-dev.ellul.app";
  const consoleOrigin = "https://console.ellul.ai";

  it("emits the @dev host matcher and CSP", () => {
    const out = generateInitialDevRoute(devDomain, consoleOrigin);
    expect(out).toContain(`@dev host ${devDomain}`);
    expect(out).toContain(
      `frame-ancestors 'self' https://console.ellul.ai`,
    );
  });

  it("forwards real Host so HMR URL construction works (regression: f848d790)", () => {
    const out = generateInitialDevRoute(devDomain, consoleOrigin);
    expect(out).not.toContain("header_up Host localhost");
    expect(out).toContain("header_up X-Forwarded-Host {host}");
  });

  it("emits @framework matcher with ALL FRAMEWORK_DEV_PATHS paths", () => {
    const out = generateInitialDevRoute(devDomain, consoleOrigin);
    expect(out).toContain("@framework path");
    for (const p of FRAMEWORK_DEV_PATHS) {
      expect(out).toContain(p);
    }
  });

  it("rewrites Origin to upstream localhost on framework paths (not user routes)", () => {
    const out = generateInitialDevRoute(devDomain, consoleOrigin);
    // Must use top-level `request_header @framework` — `header_up` inside
    // reverse_proxy silently ignores named matchers in Caddy 2.x, which
    // would collapse the scope and rewrite Origin on every request.
    expect(out).toMatch(
      /request_header @framework Origin "http:\/\/localhost:\d+"/,
    );
    // No unscoped Origin rewrite (would affect user app routes).
    expect(out).not.toMatch(/^\s+header_up Origin /m);
    expect(out).not.toMatch(/^\s+header_up @framework Origin /m);
  });
});
