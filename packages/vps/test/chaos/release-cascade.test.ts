// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { describe, it, expect } from "vitest";
import WebSocket from "ws";
import { spawnSync } from "node:child_process";

const isLinux = process.platform === "linux";
const run = isLinux ? describe : describe.skip;

run("chaos: release-cascade", () => {
  it("drain mid-session: clients receive bridge_shutting_down then reconnect", async () => {
    const ws = new WebSocket("ws://127.0.0.1:7700/ws");
    const drainEvents: unknown[] = [];
    let closed = false;

    await new Promise((r) => ws.once("open", r));
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.event === "bridge_shutting_down") drainEvents.push(msg);
      } catch {/* ignore */}
    });
    ws.on("close", () => { closed = true; });

    const r = spawnSync("curl", ["-s", "-X", "POST", "--unix-socket", "/run/ellul/agent-bridge.sock", "http://_/api/internal/bridge/drain"], { encoding: "utf8" });
    expect(r.status).toBe(0);

    await waitFor(() => drainEvents.length > 0, 3000);
    expect(drainEvents.length).toBeGreaterThan(0);

    await waitFor(() => closed, 10_000);
    expect(closed).toBe(true);

    await waitFor(() => pidOf("ellul-agent-bridge") > 0, 30_000);

    const ws2 = new WebSocket("ws://127.0.0.1:7700/ws");
    await new Promise((r) => ws2.once("open", r));
    ws2.close();
  }, 60_000);
});

function pidOf(unit: string): number {
  const r = spawnSync("systemctl", ["show", "-p", "MainPID", "--value", unit], { encoding: "utf8" });
  const v = parseInt((r.stdout || "0").trim(), 10);
  return Number.isFinite(v) ? v : 0;
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!cond() && Date.now() - start < timeoutMs) await new Promise((r) => setTimeout(r, 100));
}
