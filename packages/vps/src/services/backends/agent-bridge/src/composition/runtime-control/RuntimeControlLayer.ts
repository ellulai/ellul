// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import * as os from "node:os";
import { spawn } from "node:child_process";

import { computeWorkloadSliceBudget, hotPreviewsCap, proClaudeSlotCap } from "@vps/shared/memory-budget";
import {
  makeAdmissionService,
  type AdmissionDecision,
  type AdmissionRequest,
  type CapState,
  type EvictionCandidate,
  type HeadroomSignals,
} from "@vps/services/backends/file-api/src/application/admission/Admission";

import { makeMetricsCollector, type MetricsCollector } from "../../application/runtime-control/MetricsCollector";
import { METRICS_PROMETHEUS_PORT } from "@vps/services/shared/ports";
import { makeSystemHealth, type MetricsTick, type SystemHealth, type SystemHealthSnapshot } from "../../application/runtime-control/SystemHealth";
import { makeInferenceQueue, type InferenceQueue } from "../../application/runtime-control/InferenceQueue";
import { makeSessionCheckpointService, type SessionCheckpointService } from "../../application/runtime-control/SessionCheckpointService";
import { makeProClaudeSlotManager, type ProClaudeSlotManager, type SlotSpawn } from "../../application/runtime-control/ProClaudeSlotManager";
import { makeDegradationController, type DegradationController } from "../../application/runtime-control/DegradationController";
import { makeDrainHandler, type DrainHandler } from "../../application/runtime-control/DrainHandler";
import { makeSessionCompactor, type CompactableAdapter, type SessionCompactor } from "../../application/runtime-control/SessionCompactor";
import { logEvent } from "../../shared/event-log";

export interface BroadcastSink {
  broadcastShutdown(payload: { event: "bridge_shutting_down"; drainStart: number; drainEnd: number }): void;
  closeWsAccepts(): void;
  broadcastSystemHealth(snap: SystemHealthSnapshot): void;
  broadcastSlotUpdate(slots: ReadonlyArray<unknown>): void;
  broadcastQueueUpdate(queues: ReadonlyArray<unknown>): void;
}

export interface PoolManagerSlim {
  evictColdScopes(reason: string): Promise<void>;
  flushIdle(reason: string): Promise<void>;
  compactableAdapters(): ReadonlyArray<CompactableAdapter>;
  setIdleSweepThresholdMs?: (ms: number) => void;
}

export interface RuntimeServicesDeps {
  broadcast: BroadcastSink;
  poolManager: PoolManagerSlim;
  physicalMB?: number;
  metricsIntervalMs?: number;
  prometheusPort?: number | null;
}

export interface RuntimeServices {
  metrics: MetricsCollector;
  health: SystemHealth;
  queue: InferenceQueue;
  checkpoints: SessionCheckpointService;
  proSlots: ProClaudeSlotManager;
  degradation: DegradationController;
  drain: DrainHandler;
  compactor: SessionCompactor;
  budget: ReturnType<typeof computeWorkloadSliceBudget>;
  stop: () => Promise<void>;
}

const DEFAULT_PHYSICAL_MB = Math.max(512, Math.round(os.totalmem() / (1024 * 1024)));

export function makeRuntimeServices(deps: RuntimeServicesDeps): RuntimeServices {
  const physicalMB = deps.physicalMB ?? DEFAULT_PHYSICAL_MB;
  const budget = computeWorkloadSliceBudget(physicalMB);

  const metrics = makeMetricsCollector({
    intervalMs: deps.metricsIntervalMs ?? 1000,
    prometheusPort: deps.prometheusPort ?? METRICS_PROMETHEUS_PORT,
  });

  const healthMetricsBridge = bridgeMetricsToHealth(metrics, budget.workloadMaxMB);
  const health = makeSystemHealth({
    metrics: healthMetricsBridge,
    emit: (snap) => deps.broadcast.broadcastSystemHealth(snap),
  });

  const queue = makeInferenceQueue();
  const queueOff = queue.subscribe((snap) => deps.broadcast.broadcastQueueUpdate(snap));

  const checkpoints = makeSessionCheckpointService({
    emit: (e) => logEvent("checkpoint.event", e as unknown as Record<string, unknown>),
  });

  let admissionRedMode = false;
  const compactor = makeSessionCompactor({
    adapters: deps.poolManager.compactableAdapters(),
    emit: (e) => logEvent("compactor.event", e as unknown as Record<string, unknown>),
  });

  let proSlotsRef: ProClaudeSlotManager | null = null;
  const slotAdmission = makeAdmissionService({
    signals: () => signalsFromMetrics(metrics, budget.workloadMaxMB, health.current(), admissionRedMode),
    capStateFor: (req: AdmissionRequest): CapState | null => {
      if (req.kind !== "pro_claude") return null;
      const active = proSlotsRef?.snapshot().filter((s) => s.state !== "empty" && s.state !== "evicted").length ?? 0;
      return { current: active, max: proClaudeSlotCap(physicalMB) };
    },
    evictionCandidates: (req: AdmissionRequest): ReadonlyArray<EvictionCandidate> => {
      if (req.kind !== "pro_claude") return [];
      const slots = proSlotsRef?.snapshot() ?? [];
      return slots
        .filter((s) => s.state === "warm" && s.threadId !== null && s.threadId !== req.threadId)
        .map((s) => ({
          id: `slot-${s.slotIndex}`,
          kind: "pro_claude" as const,
          freedMB: budget.proClaudeSlotSoftHintMB,
          lastActivityAt: s.lastUseAt,
          protected: s.inWarmCache,
        }));
    },
    p95: { forRequest: () => null },
    emit: (e) => logEvent("admission.decision", e as unknown as Record<string, unknown>),
  });

  const slotSpawn = makeRealSlotSpawn(budget.proClaudeSlotSoftHintMB);
  const proSlots = makeProClaudeSlotManager({
    slotCap: proClaudeSlotCap(physicalMB),
    warmCacheSize: 2,
    admit: {
      admit: async () => {
        const decision: AdmissionDecision = await slotAdmission.admit({ kind: "pro_claude" });
        if (decision.ok) return { ok: true };
        const r = decision.reason;
        const reason: import("../../application/runtime-control/ProClaudeSlotManager").TypedSlotRejection =
          r === "ERR_ADMISSION_TIER_CAP" ? "ERR_ADMISSION_TIER_CAP" :
          r === "ERR_ADMISSION_DEGRADED_RED" ? "ERR_ADMISSION_DEGRADED_RED" :
          "ERR_ADMISSION_PRESSURE_HIGH";
        return { ok: false, reason };
      },
    },
    spawn: slotSpawn,
    checkpoint: {
      save: async (threadId) => {
        const cp = await checkpoints.load(threadId);
        if (!cp) return;
        await checkpoints.checkpoint(threadId, cp.adapter, cp.payload, cp.sessionId, cp.turn);
      },
      loadResumeId: async (threadId) => {
        const cp = await checkpoints.load(threadId);
        return cp?.adapter === "claude" ? cp.sessionId : null;
      },
    },
    emit: (e) => {
      logEvent("pro-slot.event", e as unknown as Record<string, unknown>);
      if (proSlotsRef) deps.broadcast.broadcastSlotUpdate(proSlotsRef.snapshot());
    },
  });
  proSlotsRef = proSlots;

  const degradation = makeDegradationController({
    health,
    compactor: { runNow: (opts) => compactor.runNow(opts) },
    poolManager: {
      evictColdScopes: (reason) => deps.poolManager.evictColdScopes(reason),
    },
    previewKeepalive: {
      setIdleThresholdMs: (ms) => {
        if (deps.poolManager.setIdleSweepThresholdMs) deps.poolManager.setIdleSweepThresholdMs(ms);
        logEvent("keepalive.idle.set", { ms });
      },
    },
    admission: {
      setRedMode: (on) => {
        admissionRedMode = on;
        logEvent("admission.redMode", { on });
      },
    },
    emit: (e) => logEvent("degradation.event", e),
  });

  const drain = makeDrainHandler({
    broadcast: {
      broadcastShutdown: (p) => deps.broadcast.broadcastShutdown(p),
      closeWsAccepts: () => deps.broadcast.closeWsAccepts(),
    },
    slots: { evictAll: (reason) => proSlots.evictAll(reason) },
    pools: { flushIdle: (reason) => deps.poolManager.flushIdle(reason) },
    checkpoints: { flushPending: async () => { /* per-call awaited; nothing buffered */ } },
    emit: (e) => logEvent("drain.event", e),
  });

  void hotPreviewsCap;
  compactor.start();
  degradation.start();

  return {
    metrics,
    health,
    queue,
    checkpoints,
    proSlots,
    degradation,
    drain,
    compactor,
    budget,
    async stop() {
      degradation.stop();
      compactor.stop();
      health.stop();
      queueOff();
      healthMetricsBridge.stop();
      await metrics.stop();
    },
  };
}

interface BridgedSource {
  subscribe: (l: (t: MetricsTick) => void) => () => void;
  stop: () => void;
}

function bridgeMetricsToHealth(metrics: MetricsCollector, workloadMaxMB: number): BridgedSource {
  const listeners = new Set<(t: MetricsTick) => void>();
  const off = metrics.subscribe((samples) => {
    const slice = samples.find((s) => s.key.cgroupPath.endsWith("ellul-user-workload.slice"));
    if (!slice) return;
    const tick: MetricsTick = {
      sliceUtilizationPct: Math.min(100, Math.round((slice.memoryCurrentBytes / (1024 * 1024) / workloadMaxMB) * 100)),
      psiMemAvg10: slice.psiMem.avg10,
    };
    for (const l of listeners) {
      try { l(tick); } catch { /* listener errors not fatal */ }
    }
  });
  return {
    subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
    stop() { off(); listeners.clear(); },
  };
}

function signalsFromMetrics(
  metrics: MetricsCollector,
  workloadMaxMB: number,
  systemHealth: "green" | "yellow" | "red",
  redMode: boolean,
): HeadroomSignals {
  const sample = metrics.latest("ellul-user-workload.slice");
  const usedMB = sample ? Math.round(sample.memoryCurrentBytes / (1024 * 1024)) : 0;
  const psi = sample?.psiMem.avg10 ?? 0;
  return {
    physicalMB: workloadMaxMB,
    workloadMaxMB,
    workloadUsedMB: usedMB,
    psiMemAvg10: psi,
    systemHealth: redMode ? "red" : systemHealth,
  };
}

function makeRealSlotSpawn(softHintMB: number): SlotSpawn {
  return {
    async spawnSlot(slotIndex, threadId, resumeSessionId) {
      const props = `MemoryHigh=${softHintMB}M,MemorySwapMax=0,TasksMax=256`;
      const args = [
        "-n",
        "/usr/local/bin/ellul-spawn-scope",
        "ellul-user-workload.slice",
        `ellul-pro-claude-slot${slotIndex}`,
        props,
        "--",
        "/usr/local/bin/ellul-claude-ns",
        ...(resumeSessionId ? ["--resume", resumeSessionId] : []),
      ];
      const env: Record<string, string> = {
        ...filterEnv(process.env),
        ELLUL_NS_PROJECT: "__host__",
        ELLUL_PRO_SLOT_THREAD_ID: threadId,
      };
      const child = spawn("sudo", args, { env, detached: true, stdio: "ignore" });
      child.unref();
      if (typeof child.pid !== "number") throw new Error("spawn failed: no pid");
      return { pid: child.pid };
    },
    async killSlot(pid, signal) {
      try { process.kill(pid, signal); }
      catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ESRCH") throw err;
      }
    },
    async waitExit(pid, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try { process.kill(pid, 0); }
        catch { return "exited"; }
        await new Promise((r) => setTimeout(r, 100));
      }
      return "timeout";
    },
  };
}

function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") out[k] = v;
  return out;
}
