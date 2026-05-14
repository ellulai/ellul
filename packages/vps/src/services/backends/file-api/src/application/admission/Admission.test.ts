// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { describe, expect, it } from "vitest";
import {
  makeAdmissionService,
  tierCapForRequest,
  type AdmissionDeps,
  type AdmissionEvent,
  type AdmissionRequest,
  type EvictionCandidate,
  type HeadroomSignals,
} from "./Admission";

function makeDeps(overrides: Partial<{
  signals: HeadroomSignals;
  cap: { current: number; max: number } | null;
  candidates: EvictionCandidate[];
  p95: number | null;
}> = {}): { deps: AdmissionDeps; events: AdmissionEvent[] } {
  const events: AdmissionEvent[] = [];
  const sig: HeadroomSignals = overrides.signals ?? {
    physicalMB: 4096,
    workloadMaxMB: 2540,
    workloadUsedMB: 500,
    psiMemAvg10: 0,
    systemHealth: "green",
  };
  const cap = overrides.cap ?? null;
  const candidates = overrides.candidates ?? [];
  const p95 = overrides.p95 === undefined ? null : overrides.p95;
  let id = 0;
  return {
    events,
    deps: {
      signals: () => sig,
      capStateFor: () => cap,
      evictionCandidates: () => candidates,
      p95: { forRequest: () => p95 },
      emit: (e) => events.push(e),
      now: () => 1_700_000_000_000,
      randomId: () => `adm-${++id}`,
    },
  };
}

describe("AdmissionService.admit", () => {
  it("accepts when reserved fits in headroom", async () => {
    const { deps, events } = makeDeps({ p95: 200 });
    const svc = makeAdmissionService(deps);
    const r = await svc.admit({ kind: "pool", adapter: "opencode" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.tag).toBe("accept");
      expect(r.reservedMB).toBe(200);
    }
    expect(events).toHaveLength(1);
    expect(events[0]!.tag).toBe("accept");
  });

  it("uses telemetry P95 when provided, defaults otherwise", async () => {
    const { deps: deps1, events: e1 } = makeDeps({ p95: null });
    const r1 = await makeAdmissionService(deps1).admit({ kind: "pool", adapter: "opencode" });
    expect(r1.ok && r1.reservedMB).toBe(240); // calibrated default

    const { deps: deps2, events: e2 } = makeDeps({ p95: 180 });
    const r2 = await makeAdmissionService(deps2).admit({ kind: "pool", adapter: "opencode" });
    expect(r2.ok && r2.reservedMB).toBe(180);
    expect(e1[0]!.p95Source).toBe("default");
    expect(e2[0]!.p95Source).toBe("telemetry");
  });

  it("evicts cold pool first, then idle previews", async () => {
    const { deps } = makeDeps({
      signals: { physicalMB: 4096, workloadMaxMB: 2000, workloadUsedMB: 1900, psiMemAvg10: 0, systemHealth: "green" },
      candidates: [
        { id: "preview1", kind: "preview", freedMB: 200, lastActivityAt: 1000 },
        { id: "pool1", kind: "pool", freedMB: 240, lastActivityAt: 2000 },
        { id: "pool2", kind: "pool", freedMB: 100, lastActivityAt: 500 },
      ],
      p95: 400,
    });
    const r = await makeAdmissionService(deps).admit({ kind: "pool", adapter: "opencode" });
    if (!r.ok || r.tag !== "accept_after_evict") throw new Error("expected accept_after_evict");
    expect(r.evict.map((e) => e.id)).toEqual(["pool2", "pool1"]);
  });

  it("never over-evicts", async () => {
    const { deps } = makeDeps({
      signals: { physicalMB: 4096, workloadMaxMB: 2000, workloadUsedMB: 1990, psiMemAvg10: 0, systemHealth: "green" },
      candidates: [
        { id: "p1", kind: "pool", freedMB: 240, lastActivityAt: 1 },
        { id: "p2", kind: "pool", freedMB: 240, lastActivityAt: 2 },
        { id: "p3", kind: "preview", freedMB: 200, lastActivityAt: 3 },
      ],
      p95: 100,
    });
    const r = await makeAdmissionService(deps).admit({ kind: "pool", adapter: "opencode" });
    if (!r.ok || r.tag !== "accept_after_evict") throw new Error("expected accept_after_evict");
    expect(r.evict).toHaveLength(1);
    expect(r.evict[0]!.freedMB).toBeGreaterThanOrEqual(100 - (2000 - 1990));
  });

  it("rejects ERR_ADMISSION_NO_HEADROOM when eviction plan insufficient", async () => {
    const { deps } = makeDeps({
      signals: { physicalMB: 4096, workloadMaxMB: 1000, workloadUsedMB: 950, psiMemAvg10: 0, systemHealth: "green" },
      candidates: [{ id: "p1", kind: "pool", freedMB: 50, lastActivityAt: 1 }],
      p95: 500,
    });
    const r = await makeAdmissionService(deps).admit({ kind: "pool", adapter: "opencode" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("ERR_ADMISSION_NO_HEADROOM");
      expect(r.required.evictableMB).toBe(50);
    }
  });

  it("rejects ERR_ADMISSION_TIER_CAP when cap reached", async () => {
    const { deps } = makeDeps({ cap: { current: 3, max: 3 }, p95: 100 });
    const r = await makeAdmissionService(deps).admit({ kind: "pro_claude", threadId: "t1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("ERR_ADMISSION_TIER_CAP");
  });

  it("rejects ERR_ADMISSION_DEGRADED_RED when system health red", async () => {
    const { deps } = makeDeps({
      signals: { physicalMB: 4096, workloadMaxMB: 2540, workloadUsedMB: 100, psiMemAvg10: 0, systemHealth: "red" },
      p95: 100,
    });
    const r = await makeAdmissionService(deps).admit({ kind: "preview", frameworkId: "next" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("ERR_ADMISSION_DEGRADED_RED");
  });

  it("rejects ERR_ADMISSION_PRESSURE_HIGH when PSI > 25", async () => {
    const { deps } = makeDeps({
      signals: { physicalMB: 4096, workloadMaxMB: 2540, workloadUsedMB: 100, psiMemAvg10: 30, systemHealth: "yellow" },
      p95: 100,
    });
    const r = await makeAdmissionService(deps).admit({ kind: "preview", frameworkId: "next" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("ERR_ADMISSION_PRESSURE_HIGH");
  });

  it("rejects ERR_ADMISSION_FRAMEWORK_TOO_BIG when reservation > workloadMax", async () => {
    const { deps } = makeDeps({
      signals: { physicalMB: 4096, workloadMaxMB: 500, workloadUsedMB: 0, psiMemAvg10: 0, systemHealth: "green" },
      p95: 1000,
    });
    const r = await makeAdmissionService(deps).admit({ kind: "preview", frameworkId: "next" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("ERR_ADMISSION_FRAMEWORK_TOO_BIG");
  });

  it("emits a structured admission.decision event for every call", async () => {
    const { deps, events } = makeDeps({ p95: 100 });
    const svc = makeAdmissionService(deps);
    await svc.admit({ kind: "pool", adapter: "cursor" });
    await svc.admit({ kind: "pool", adapter: "opencode" });
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e.event).toBe("admission.decision");
      expect(e.admissionId).toMatch(/^adm-/);
    }
  });

  it("serialises concurrent admit calls", async () => {
    let usedMB = 0;
    const sig: HeadroomSignals = { physicalMB: 4096, workloadMaxMB: 2000, workloadUsedMB: 0, psiMemAvg10: 0, systemHealth: "green" };
    const deps: AdmissionDeps = {
      signals: () => ({ ...sig, workloadUsedMB: usedMB }),
      capStateFor: () => null,
      evictionCandidates: () => [],
      p95: { forRequest: () => 500 },
      emit: () => {},
      now: () => 1,
      randomId: () => "x",
    };
    const svc = makeAdmissionService(deps);
    const results = await Promise.all([
      svc.admit({ kind: "pool", adapter: "opencode" }).then((r) => { if (r.ok) usedMB += r.reservedMB; return r; }),
      svc.admit({ kind: "pool", adapter: "opencode" }).then((r) => { if (r.ok) usedMB += r.reservedMB; return r; }),
      svc.admit({ kind: "pool", adapter: "opencode" }).then((r) => { if (r.ok) usedMB += r.reservedMB; return r; }),
      svc.admit({ kind: "pool", adapter: "opencode" }).then((r) => { if (r.ok) usedMB += r.reservedMB; return r; }),
      svc.admit({ kind: "pool", adapter: "opencode" }).then((r) => { if (r.ok) usedMB += r.reservedMB; return r; }),
    ]);
    const accepted = results.filter((r) => r.ok).length;
    expect(accepted).toBeLessThanOrEqual(4);
    const final = await svc.admit({ kind: "pool", adapter: "opencode" });
    if (!final.ok) expect(final.reason).toBe("ERR_ADMISSION_NO_HEADROOM");
  });

  it("respects 'protected' eviction candidates (LRU-of-2 warm Pro slot)", async () => {
    const { deps } = makeDeps({
      signals: { physicalMB: 8192, workloadMaxMB: 4000, workloadUsedMB: 3800, psiMemAvg10: 0, systemHealth: "green" },
      candidates: [
        { id: "slot1", kind: "pro_claude", freedMB: 320, lastActivityAt: 1, protected: true },
        { id: "slot2", kind: "pro_claude", freedMB: 320, lastActivityAt: 2 },
      ],
      p95: 300,
    });
    const r = await makeAdmissionService(deps).admit({ kind: "pro_claude", threadId: "t" });
    if (!r.ok || r.tag !== "accept_after_evict") throw new Error("expected accept_after_evict");
    expect(r.evict.map((e) => e.id)).toEqual(["slot2"]);
  });
});

describe("tierCapForRequest", () => {
  it("Pro Claude cap: 1 on $20, 3 on $50", () => {
    expect(tierCapForRequest({ kind: "pro_claude" }, 4096)).toBe(1);
    expect(tierCapForRequest({ kind: "pro_claude" }, 8192)).toBe(3);
  });

  it("Hot previews cap: 2 on $20, 3 on $50", () => {
    expect(tierCapForRequest({ kind: "preview" }, 4096)).toBe(2);
    expect(tierCapForRequest({ kind: "preview" }, 8192)).toBe(3);
  });

  it("Pool / sandbox / system have no tier cap (null)", () => {
    expect(tierCapForRequest({ kind: "pool", adapter: "opencode" }, 4096)).toBeNull();
    expect(tierCapForRequest({ kind: "sandbox" }, 4096)).toBeNull();
    expect(tierCapForRequest({ kind: "system" }, 4096)).toBeNull();
  });
});
