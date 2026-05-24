// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import * as fs from "node:fs";
import * as os from "node:os";
import {
  computeWorkloadSliceBudget,
  estimatePreviewSteadyMB,
  hotPreviewsCap,
} from "@vps/shared/memory-budget";
import { detectFramework } from "@vps/shared/framework";
import {
  makeAdmissionService,
  type AdmissionDecision,
  type AdmissionRequest,
  type AdmissionService,
  type EvictionCandidate,
  type HeadroomSignals,
} from "./Admission";
import { idlenessMs, listTracked, lruOrder } from "../preview/PreviewTracking";
import { listActive } from "../preview/PreviewUnits";

let cached: AdmissionService | null = null;

export function getPreviewAdmission(): AdmissionService {
  if (cached) return cached;
  cached = makeAdmissionService({
    signals: readSignals,
    capStateFor: (req) => {
      if (req.kind !== "preview") return null;
      return { current: countActiveSync(), max: hotPreviewsCap(physicalMB()) };
    },
    evictionCandidates: () => collectEvictionCandidates(),
    p95: { forRequest: () => null },
    emit: () => { /* event log routed at file-api level */ },
  });
  return cached;
}

export async function admitPreview(req: AdmissionRequest): Promise<AdmissionDecision> {
  return getPreviewAdmission().admit(req);
}

function physicalMB(): number {
  return Math.max(512, Math.round(os.totalmem() / (1024 * 1024)));
}

function readSignals(): HeadroomSignals {
  const phys = physicalMB();
  const budget = computeWorkloadSliceBudget(phys);
  const usedMB = readWorkloadSliceUsedMB();
  const psi = readWorkloadSlicePsi();
  return {
    physicalMB: phys,
    workloadMaxMB: budget.workloadMaxMB,
    workloadUsedMB: usedMB,
    psiMemAvg10: psi,
    systemHealth: deriveHealth(usedMB, budget.workloadMaxMB, psi),
  };
}

function readWorkloadSliceUsedMB(): number {
  try {
    const v = fs.readFileSync("/sys/fs/cgroup/ellul.slice/ellul-user-workload.slice/memory.current", "utf8").trim();
    const bytes = parseInt(v, 10);
    if (Number.isFinite(bytes)) return Math.round(bytes / (1024 * 1024));
  } catch { /* cgroup-v2 not mounted or slice not yet provisioned */ }
  try {
    const data = fs.readFileSync("/proc/meminfo", "utf8");
    const m = /MemAvailable:\s+(\d+)\s*kB/.exec(data);
    const memTotalM = /MemTotal:\s+(\d+)\s*kB/.exec(data);
    if (m && memTotalM) {
      const totalMB = Math.round(parseInt(memTotalM[1]!, 10) / 1024);
      const availMB = Math.round(parseInt(m[1]!, 10) / 1024);
      return Math.max(0, totalMB - availMB);
    }
  } catch { /* meminfo unreadable */ }
  return 0;
}

function readWorkloadSlicePsi(): number {
  try {
    const v = fs.readFileSync("/sys/fs/cgroup/ellul.slice/ellul-user-workload.slice/memory.pressure", "utf8");
    const m = /some\s+avg10=([0-9.]+)/.exec(v);
    if (m) return parseFloat(m[1]!);
  } catch { /* PSI unavailable */ }
  return 0;
}

function deriveHealth(usedMB: number, maxMB: number, psi: number): "green" | "yellow" | "red" {
  const util = maxMB > 0 ? (usedMB / maxMB) * 100 : 0;
  if (util >= 90 || psi >= 25) return "red";
  if (util >= 70 || psi >= 10) return "yellow";
  return "green";
}

function countActiveSync(): number {
  return listTracked().length;
}

function collectEvictionCandidates(): ReadonlyArray<EvictionCandidate> {
  const records = listTracked();
  const lru = new Set(lruOrder().map((r) => r.directory));
  const candidates: EvictionCandidate[] = [];
  for (const r of records) {
    const idle = idlenessMs(r.directory) ?? 0;
    if (idle < 60_000) continue;
    const framework = detectFramework(r.directory);
    const steady = estimatePreviewSteadyMB(framework?.id ?? null, framework?.runtime ?? null);
    candidates.push({
      id: r.directory,
      kind: "preview",
      freedMB: steady,
      lastActivityAt: r.lastActivityAt,
      protected: !lru.has(r.directory),
    });
  }
  return candidates;
}

void listActive;
