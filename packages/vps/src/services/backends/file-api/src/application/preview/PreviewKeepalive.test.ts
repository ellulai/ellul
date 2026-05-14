// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { describe, expect, it } from "vitest";
import { makePreviewKeepalive, type ActivityObserver } from "./PreviewKeepalive";

function http(map: Record<string, number>): ActivityObserver {
  return { httpActivityAt: (d) => map[d] ?? null };
}

describe("PreviewKeepalive", () => {
  it("returns null lastActivity when never seen", () => {
    const k = makePreviewKeepalive({ http: http({}) });
    expect(k.lastActivityAt("a")).toBeNull();
    expect(k.isIdle("a")).toBe(true);
  });

  it("ws ping updates lastActivityAt", () => {
    const k = makePreviewKeepalive({ http: http({}), now: () => 5000 });
    k.observePing({ appDirectory: "a", port: 4000, at: 1000 });
    expect(k.lastActivityAt("a")).toBe(1000);
  });

  it("takes max(http, ws) as last activity", () => {
    const k = makePreviewKeepalive({ http: http({ a: 7000 }), now: () => 9000 });
    k.observePing({ appDirectory: "a", port: 4000, at: 5000 });
    expect(k.lastActivityAt("a")).toBe(7000);
    k.observePing({ appDirectory: "a", port: 4000, at: 8000 });
    expect(k.lastActivityAt("a")).toBe(8000);
  });

  it("isIdle uses configurable threshold", () => {
    let now = 100_000;
    const k = makePreviewKeepalive({ http: http({}), now: () => now, defaultIdleMs: 60_000 });
    k.observePing({ appDirectory: "a", port: 4000, at: 100_000 });
    expect(k.isIdle("a")).toBe(false);
    now = 161_000;
    expect(k.isIdle("a")).toBe(true);
  });

  it("setIdleThresholdMs honours new value (min 60s)", () => {
    const k = makePreviewKeepalive({ http: http({}) });
    k.setIdleThresholdMs(4 * 60 * 1000);
    expect(k.idleThresholdMs()).toBe(4 * 60 * 1000);
    k.setIdleThresholdMs(1);
    expect(k.idleThresholdMs()).toBe(60_000);
  });

  it("ping with older timestamp does not regress lastActivityAt", () => {
    const k = makePreviewKeepalive({ http: http({}), now: () => 0 });
    k.observePing({ appDirectory: "a", port: 4000, at: 5000 });
    k.observePing({ appDirectory: "a", port: 4000, at: 1000 });
    expect(k.lastActivityAt("a")).toBe(5000);
  });
});
