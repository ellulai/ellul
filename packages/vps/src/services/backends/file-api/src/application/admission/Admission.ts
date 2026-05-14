// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { computeWorkloadSliceBudget, frameworkMemoryProfile, hotPreviewsCap, proClaudeSlotCap } from "@vps/shared/memory-budget";
import type { Runtime } from "@vps/shared/framework";

export type WorkloadKind = "preview" | "pool" | "pro_claude" | "sandbox" | "system";
export type Adapter = "opencode" | "cursor" | "codex" | "claude";

export type TypedRejection =
  | "ERR_ADMISSION_NO_HEADROOM"
  | "ERR_ADMISSION_TIER_CAP"
  | "ERR_ADMISSION_DEGRADED_RED"
  | "ERR_ADMISSION_PRESSURE_HIGH"
  | "ERR_ADMISSION_FRAMEWORK_TOO_BIG";

export interface AdmissionRequest {
  kind: WorkloadKind;
  frameworkId?: string | null;
  runtime?: Runtime | null;
  adapter?: Adapter;
  sandbox?: string;
  threadId?: string;
}

export interface EvictionCandidate {
  id: string;
  kind: "preview" | "pool" | "pro_claude";
  freedMB: number;
  lastActivityAt: number;
  protected?: boolean;
}

export interface EvictionPlan {
  id: string;
  kind: EvictionCandidate["kind"];
  freedMB: number;
}

export type AdmissionDecision =
  | { ok: true; tag: "accept"; reservedMB: number; admissionId: string }
  | { ok: true; tag: "accept_after_evict"; reservedMB: number; admissionId: string; evict: ReadonlyArray<EvictionPlan> }
  | { ok: false; tag: "reject"; reason: TypedRejection; required: { headroomMB: number; evictableMB: number; capRemaining: number | null } };

export interface CapState {
  current: number;
  max: number;
}

export interface HeadroomSignals {
  physicalMB: number;
  workloadMaxMB: number;
  workloadUsedMB: number;
  psiMemAvg10: number;
  systemHealth: "green" | "yellow" | "red";
}

export interface P95Source {
  /** Returns P95 reservation MB for the request, or null to use calibrated default. */
  forRequest(req: AdmissionRequest): number | null;
}

export interface AdmissionDeps {
  signals: () => HeadroomSignals;
  capStateFor: (req: AdmissionRequest) => CapState | null;
  evictionCandidates: (req: AdmissionRequest) => ReadonlyArray<EvictionCandidate>;
  p95: P95Source;
  emit: (event: AdmissionEvent) => void;
  now?: () => number;
  randomId?: () => string;
}

export interface AdmissionEvent {
  event: "admission.decision";
  kind: WorkloadKind;
  tag: AdmissionDecision["tag"] | "reject";
  admissionId: string;
  reservedMB: number;
  evicted: ReadonlyArray<{ id: string; kind: EvictionCandidate["kind"]; freedMB: number }>;
  headroomMBBefore: number;
  psiMemAvg10: number;
  p95Source: "telemetry" | "default";
  rejectReason: TypedRejection | null;
}

export interface AdmissionService {
  admit(req: AdmissionRequest): Promise<AdmissionDecision>;
  headroom(): HeadroomSignals;
}

const DEFAULT_RESERVATIONS_MB: Record<string, number> = {
  pool_opencode: 240,
  pool_cursor: 200,
  pool_codex: 250,
  pool_claude: 100,
  pro_claude: 320,
  sandbox: 16,
};

function defaultReservation(req: AdmissionRequest): number {
  if (req.kind === "preview") {
    return frameworkMemoryProfile(req.frameworkId, req.runtime ?? null).devPeakMB;
  }
  if (req.kind === "pool" && req.adapter) return DEFAULT_RESERVATIONS_MB[`pool_${req.adapter}`] ?? 200;
  if (req.kind === "pro_claude") return DEFAULT_RESERVATIONS_MB.pro_claude!;
  if (req.kind === "sandbox") return DEFAULT_RESERVATIONS_MB.sandbox!;
  return 64;
}

const PRESSURE_HIGH_PCT = 25;

export function makeAdmissionService(deps: AdmissionDeps): AdmissionService {
  const now = deps.now ?? Date.now;
  const randomId = deps.randomId ?? defaultRandomId;
  let chain: Promise<unknown> = Promise.resolve();

  function planEviction(deficitMB: number, candidates: ReadonlyArray<EvictionCandidate>): {
    plan: EvictionPlan[];
    totalFreedMB: number;
  } {
    const sorted = [...candidates]
      .filter((c) => !c.protected)
      .sort((a, b) => tierOrder(a.kind) - tierOrder(b.kind) || a.lastActivityAt - b.lastActivityAt);
    const plan: EvictionPlan[] = [];
    let total = 0;
    for (const c of sorted) {
      if (total >= deficitMB) break;
      plan.push({ id: c.id, kind: c.kind, freedMB: c.freedMB });
      total += c.freedMB;
    }
    return { plan, totalFreedMB: total };
  }

  function evaluate(req: AdmissionRequest): AdmissionDecision {
    const sig = deps.signals();
    const cap = deps.capStateFor(req);
    const reservedTelemetry = deps.p95.forRequest(req);
    const reserved = reservedTelemetry ?? defaultReservation(req);
    const headroomMB = Math.max(0, sig.workloadMaxMB - sig.workloadUsedMB);
    const id = randomId();

    const reject = (reason: TypedRejection, evictableMB = 0): AdmissionDecision => {
      const decision: AdmissionDecision = {
        ok: false,
        tag: "reject",
        reason,
        required: { headroomMB, evictableMB, capRemaining: cap ? cap.max - cap.current : null },
      };
      deps.emit(buildEvent(req, decision, id, reserved, headroomMB, sig.psiMemAvg10, reservedTelemetry !== null, reason));
      return decision;
    };

    if (sig.systemHealth === "red" && req.kind !== "system") return reject("ERR_ADMISSION_DEGRADED_RED");
    if (cap && cap.current >= cap.max) return reject("ERR_ADMISSION_TIER_CAP");
    if (reserved > sig.workloadMaxMB) return reject("ERR_ADMISSION_FRAMEWORK_TOO_BIG");
    if (sig.psiMemAvg10 > PRESSURE_HIGH_PCT) return reject("ERR_ADMISSION_PRESSURE_HIGH");

    if (reserved <= headroomMB) {
      const decision: AdmissionDecision = { ok: true, tag: "accept", reservedMB: reserved, admissionId: id };
      deps.emit(buildEvent(req, decision, id, reserved, headroomMB, sig.psiMemAvg10, reservedTelemetry !== null, null));
      return decision;
    }

    const deficit = reserved - headroomMB;
    const candidates = deps.evictionCandidates(req);
    const { plan, totalFreedMB } = planEviction(deficit, candidates);
    if (totalFreedMB >= deficit) {
      const decision: AdmissionDecision = {
        ok: true,
        tag: "accept_after_evict",
        reservedMB: reserved,
        admissionId: id,
        evict: plan,
      };
      deps.emit(buildEvent(req, decision, id, reserved, headroomMB, sig.psiMemAvg10, reservedTelemetry !== null, null));
      return decision;
    }
    return reject("ERR_ADMISSION_NO_HEADROOM", totalFreedMB);
  }

  return {
    admit(req) {
      // Serialise admit calls to avoid two callers double-counting headroom.
      const next = chain.then(() => evaluate(req));
      chain = next.catch(() => undefined);
      return next as Promise<AdmissionDecision>;
    },
    headroom: deps.signals,
  };
}

function tierOrder(kind: EvictionCandidate["kind"]): number {
  if (kind === "pool") return 1;
  if (kind === "preview") return 2;
  return 3;
}

function buildEvent(
  req: AdmissionRequest,
  decision: AdmissionDecision,
  admissionId: string,
  reservedMB: number,
  headroomMB: number,
  psiMemAvg10: number,
  telemetry: boolean,
  rejectReason: TypedRejection | null,
): AdmissionEvent {
  const evicted = decision.ok && decision.tag === "accept_after_evict"
    ? decision.evict.map((e) => ({ id: e.id, kind: e.kind, freedMB: e.freedMB }))
    : [];
  return {
    event: "admission.decision",
    kind: req.kind,
    tag: decision.tag,
    admissionId,
    reservedMB,
    evicted,
    headroomMBBefore: headroomMB,
    psiMemAvg10,
    p95Source: telemetry ? "telemetry" : "default",
    rejectReason,
  };
}

let counter = 0;
function defaultRandomId(): string {
  counter = (counter + 1) | 0;
  return `adm-${Date.now().toString(36)}-${counter.toString(36)}`;
}

export function tierCapForRequest(req: AdmissionRequest, physicalMB: number): CapState["max"] | null {
  if (req.kind === "pro_claude") return proClaudeSlotCap(physicalMB);
  if (req.kind === "preview") return hotPreviewsCap(physicalMB);
  return null;
}

export { computeWorkloadSliceBudget };
