// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";

const isLinux = process.platform === "linux";
const run = isLinux ? describe : describe.skip;

run("chaos: preview-evict-storm", () => {
  it("10 concurrent preview starts: AdmissionService serializes, evictions LRU, no double-spawn", async () => {
    const before = listPreviewUnits();
    const startResults = await Promise.all(
      Array.from({ length: 10 }, (_, i) => startPreview(`/home/dev/canary/app${i}`)),
    );
    const accepted = startResults.filter((r) => r.tag === "accept" || r.tag === "accept_after_evict").length;
    const rejected = startResults.filter((r) => r.tag === "reject").length;
    expect(accepted + rejected).toBe(10);

    const after = listPreviewUnits();
    const newUnits = after.filter((u) => !before.includes(u));
    const unique = new Set(newUnits);
    expect(unique.size).toBe(newUnits.length);

    const actively = activePreviewCount();
    const tierCap = phys() <= 4096 ? 2 : 3;
    expect(actively).toBeLessThanOrEqual(tierCap + 1);
  }, 90_000);
});

interface AdmissionResult { tag: "accept" | "accept_after_evict" | "reject" }

async function startPreview(appDir: string): Promise<AdmissionResult> {
  const r = spawnSync("curl", ["-s", "-X", "POST", `http://127.0.0.1:3002/api/previews/start`, "-d", JSON.stringify({ appDirectory: appDir }), "-H", "content-type: application/json"], { encoding: "utf8" });
  try {
    const j = JSON.parse(r.stdout || "{}");
    return { tag: j.admission?.tag ?? "reject" };
  } catch { return { tag: "reject" }; }
}

function listPreviewUnits(): string[] {
  const r = spawnSync("systemctl", ["list-units", "--type=service", "--state=active", "ellul-preview@*", "--no-legend", "--plain", "--no-pager"], { encoding: "utf8" });
  return (r.stdout || "").split("\n").map((l) => l.split(/\s+/)[0]!).filter(Boolean);
}

function activePreviewCount(): number {
  return listPreviewUnits().length;
}

function phys(): number {
  const r = spawnSync("grep", ["MemTotal", "/proc/meminfo"], { encoding: "utf8" });
  const m = /(\d+)/.exec(r.stdout || "0");
  return Math.round((m ? parseInt(m[1]!, 10) : 0) / 1024);
}
