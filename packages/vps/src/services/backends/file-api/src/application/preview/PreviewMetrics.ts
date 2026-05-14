// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// - Counters only go up. Never reset on process restart (we

export interface PreviewMetrics {
  admission: {
    accepted: number;
    acceptedAfterEvict: number;
    acceptedAfterDrain: number;
    rejectedConcurrency: number;
    rejectedMemoryCritical: number;
    rejectedLoad: number;
    rejectedPressure: number;
    rejectedDrainTimeout: number;
    rejectedBudgetUnavailable: number;
    psiEvictLru: number;
    evictionsGraceful: number;
    evictionsImmediate: number;
    // Rolling samples (bounded window) of drain durations in ms.
    drainDurationsMs: number[];
  };
  reconciler: {
    ticks: number;
    failedUnitsReset: number;
    idleEvictions: number;
    pressureEvictions: number;
    observationErrors: number;
    lastTickElapsedMs: number;
    lastTickActiveCount: number;
  };
  budget: {
    physicalMB: number;
    reservedMB: number;
    previewBudgetMB: number;
    perPreviewCapMB: number;
    headroomMB: number;
    activeReservedMB: number;
  };
  delete: {
    started: number;
    completed: number;
    failed: number;
    stepFailures: Record<string, number>;
  };
  tracking: {
    currentlyTracked: number;
  };
  // ms-epoch when this file-api process started.
  startedAt: number;
}

const DRAIN_SAMPLE_CAP = 512;

const state: PreviewMetrics = {
  admission: {
    accepted: 0,
    acceptedAfterEvict: 0,
    acceptedAfterDrain: 0,
    rejectedConcurrency: 0,
    rejectedMemoryCritical: 0,
    rejectedLoad: 0,
    rejectedPressure: 0,
    rejectedDrainTimeout: 0,
    rejectedBudgetUnavailable: 0,
    psiEvictLru: 0,
    evictionsGraceful: 0,
    evictionsImmediate: 0,
    drainDurationsMs: [],
  },
  reconciler: {
    ticks: 0,
    failedUnitsReset: 0,
    idleEvictions: 0,
    pressureEvictions: 0,
    observationErrors: 0,
    lastTickElapsedMs: 0,
    lastTickActiveCount: 0,
  },
  budget: {
    physicalMB: 0,
    reservedMB: 0,
    previewBudgetMB: 0,
    perPreviewCapMB: 0,
    headroomMB: 0,
    activeReservedMB: 0,
  },
  delete: {
    started: 0,
    completed: 0,
    failed: 0,
    stepFailures: {},
  },
  tracking: {
    currentlyTracked: 0,
  },
  startedAt: Date.now(),
};

export const admissionMetrics = {
  accept: () => state.admission.accepted++,
  acceptAfterEvict: () => state.admission.acceptedAfterEvict++,
  acceptAfterDrain: () => state.admission.acceptedAfterDrain++,
  rejectConcurrency: () => state.admission.rejectedConcurrency++,
  rejectMemoryCritical: () => state.admission.rejectedMemoryCritical++,
  rejectLoad: () => state.admission.rejectedLoad++,
  rejectPressure: () => state.admission.rejectedPressure++,
  rejectDrainTimeout: () => state.admission.rejectedDrainTimeout++,
  rejectBudgetUnavailable: () => state.admission.rejectedBudgetUnavailable++,
  psiEvict: () => state.admission.psiEvictLru++,
  evictionGraceful: () => state.admission.evictionsGraceful++,
  evictionImmediate: () => state.admission.evictionsImmediate++,
  recordDrainMs: (ms: number) => {
    state.admission.drainDurationsMs.push(Math.max(0, Math.round(ms)));
    if (state.admission.drainDurationsMs.length > DRAIN_SAMPLE_CAP) {
      state.admission.drainDurationsMs.splice(
        0,
        state.admission.drainDurationsMs.length - DRAIN_SAMPLE_CAP,
      );
    }
  },
};

export const budgetMetrics = {
  setBudget: (b: { physicalMB: number; reservedMB: number; previewBudgetMB: number; perPreviewCapMB: number }) => {
    state.budget.physicalMB = b.physicalMB;
    state.budget.reservedMB = b.reservedMB;
    state.budget.previewBudgetMB = b.previewBudgetMB;
    state.budget.perPreviewCapMB = b.perPreviewCapMB;
  },
  setHeadroomMB: (n: number) => {
    state.budget.headroomMB = Math.max(0, Math.round(n));
  },
  setActiveReservedMB: (n: number) => {
    state.budget.activeReservedMB = Math.max(0, Math.round(n));
  },
};

export const reconcilerMetrics = {
  tickStart: () => {
    state.reconciler.ticks++;
  },
  tickEnd: (elapsedMs: number, activeCount: number) => {
    state.reconciler.lastTickElapsedMs = elapsedMs;
    state.reconciler.lastTickActiveCount = activeCount;
  },
  failedUnitsReset: (n: number) => {
    state.reconciler.failedUnitsReset += n;
  },
  idleEviction: () => state.reconciler.idleEvictions++,
  pressureEviction: () => state.reconciler.pressureEvictions++,
  observationError: () => state.reconciler.observationErrors++,
};

export const deleteMetrics = {
  start: () => state.delete.started++,
  complete: () => state.delete.completed++,
  fail: (step: string) => {
    state.delete.failed++;
    state.delete.stepFailures[step] = (state.delete.stepFailures[step] ?? 0) + 1;
  },
};

export const trackingMetrics = {
  setTrackedCount: (n: number) => {
    state.tracking.currentlyTracked = n;
  },
};

// Snapshot — used by tests + the /metrics endpoint.
export function snapshot(): PreviewMetrics {
  return JSON.parse(JSON.stringify(state));
}

// Prometheus text-exposition format. One counter per line, help +
export function renderPrometheus(): string {
  const s = snapshot();
  const lines: string[] = [];
  const emitCounter = (name: string, help: string, value: number) => {
    lines.push(`# HELP ellul_${name} ${help}`);
    lines.push(`# TYPE ellul_${name} counter`);
    lines.push(`ellul_${name} ${value}`);
  };
  const emitGauge = (name: string, help: string, value: number) => {
    lines.push(`# HELP ellul_${name} ${help}`);
    lines.push(`# TYPE ellul_${name} gauge`);
    lines.push(`ellul_${name} ${value}`);
  };

  emitCounter('preview_admission_accepted_total',
    'Preview starts admitted without eviction', s.admission.accepted);
  emitCounter('preview_admission_accepted_after_evict_total',
    'Preview starts admitted after evicting an LRU victim', s.admission.acceptedAfterEvict);
  emitCounter('preview_admission_accepted_after_drain_total',
    'Preview starts admitted after post-eviction memory drain completed', s.admission.acceptedAfterDrain);
  emitCounter('preview_admission_rejected_concurrency_total',
    'Rejected because at MAX_CONCURRENT and no evictable victim', s.admission.rejectedConcurrency);
  emitCounter('preview_admission_rejected_memory_critical_total',
    'Rejected because memory below critical floor', s.admission.rejectedMemoryCritical);
  emitCounter('preview_admission_rejected_load_total',
    'Rejected because 1-min loadavg above CPU count × multiplier', s.admission.rejectedLoad);
  emitCounter('preview_admission_rejected_pressure_total',
    'Rejected because cgroup v2 PSI memory.full.avg60 > 10% or some.avg10 > 40%', s.admission.rejectedPressure);
  emitCounter('preview_admission_rejected_drain_timeout_total',
    'Rejected because post-eviction drain did not complete in DRAIN_TIMEOUT_MS', s.admission.rejectedDrainTimeout);
  emitCounter('preview_admission_rejected_budget_unavailable_total',
    'Rejected because the candidate peak RSS exceeds the preview budget even with every eviction', s.admission.rejectedBudgetUnavailable);
  emitCounter('preview_admission_psi_evict_lru_total',
    'PSI caused an LRU eviction on admission (soft-pressure protective)', s.admission.psiEvictLru);
  emitCounter('preview_admission_evictions_graceful_total',
    'Evictions completed via SIGTERM + graceful stop', s.admission.evictionsGraceful);
  emitCounter('preview_admission_evictions_immediate_total',
    'Evictions completed via immediate SIGKILL (pressure-driven path)', s.admission.evictionsImmediate);
  // Drain duration — exported as a summary sketch: count + sum + p50/p95/p99.
  const drains = s.admission.drainDurationsMs;
  const drainCount = drains.length;
  const drainSum = drains.reduce((a, b) => a + b, 0);
  lines.push(`# HELP ellul_preview_admission_drain_duration_ms Summary of drain durations (post-eviction memory recovery) in milliseconds`);
  lines.push(`# TYPE ellul_preview_admission_drain_duration_ms summary`);
  lines.push(`ellul_preview_admission_drain_duration_ms_count ${drainCount}`);
  lines.push(`ellul_preview_admission_drain_duration_ms_sum ${drainSum}`);
  if (drainCount > 0) {
    const sorted = [...drains].sort((a, b) => a - b);
    const pick = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
    lines.push(`ellul_preview_admission_drain_duration_ms{quantile="0.5"} ${pick(0.5)}`);
    lines.push(`ellul_preview_admission_drain_duration_ms{quantile="0.95"} ${pick(0.95)}`);
    lines.push(`ellul_preview_admission_drain_duration_ms{quantile="0.99"} ${pick(0.99)}`);
  }

  emitGauge('preview_budget_physical_mb',
    'Physical memory visible to the host in MB', s.budget.physicalMB);
  emitGauge('preview_budget_reserved_mb',
    'MB reserved for kernel + control plane — never available to previews', s.budget.reservedMB);
  emitGauge('preview_budget_preview_pool_mb',
    'MB available to the preview cgroup slice in aggregate', s.budget.previewBudgetMB);
  emitGauge('preview_budget_per_preview_cap_mb',
    'Hard memory cap enforced per preview unit in MB', s.budget.perPreviewCapMB);
  emitGauge('preview_budget_headroom_mb',
    'MemAvailable minus the sum of reserved-but-unstarted preview peaks', s.budget.headroomMB);
  emitGauge('preview_budget_active_reserved_mb',
    'Sum of estimated peak RSS for every currently-tracked preview', s.budget.activeReservedMB);

  emitCounter('preview_reconciler_ticks_total',
    'Number of reconciler sweeps since startup', s.reconciler.ticks);
  emitCounter('preview_reconciler_failed_units_reset_total',
    'systemd units reset-failed by reconciler', s.reconciler.failedUnitsReset);
  emitCounter('preview_reconciler_idle_evictions_total',
    'Previews evicted because idle > IDLE_EVICT_AFTER_MS', s.reconciler.idleEvictions);
  emitCounter('preview_reconciler_pressure_evictions_total',
    'Previews evicted by reconciler due to memory pressure', s.reconciler.pressureEvictions);
  emitCounter('preview_reconciler_observation_errors_total',
    'Tick observation errors (ss query, systemctl query)', s.reconciler.observationErrors);
  emitGauge('preview_reconciler_last_tick_elapsed_ms',
    'Wall time of the most recent reconciler tick', s.reconciler.lastTickElapsedMs);
  emitGauge('preview_reconciler_last_tick_active_count',
    'Active preview count observed on the most recent tick', s.reconciler.lastTickActiveCount);

  emitCounter('preview_delete_started_total',
    'Sandbox/app delete invocations', s.delete.started);
  emitCounter('preview_delete_completed_total',
    'Sandbox/app deletes that completed successfully', s.delete.completed);
  emitCounter('preview_delete_failed_total',
    'Sandbox/app deletes that failed at any step', s.delete.failed);
  for (const [step, n] of Object.entries(s.delete.stepFailures)) {
    lines.push(`# HELP ellul_preview_delete_step_failures_total Delete step failures by step`);
    lines.push(`# TYPE ellul_preview_delete_step_failures_total counter`);
    lines.push(`ellul_preview_delete_step_failures_total{step="${step}"} ${n}`);
  }

  emitGauge('preview_tracked_count',
    'Previews currently in the activity-tracking registry', s.tracking.currentlyTracked);
  emitGauge('preview_subsystem_started_seconds',
    'ms-epoch when this file-api process started', s.startedAt);

  return lines.join('\n') + '\n';
}

// Test helper — resets every counter.
export function _resetMetricsForTests(): void {
  state.admission = {
    accepted: 0,
    acceptedAfterEvict: 0,
    acceptedAfterDrain: 0,
    rejectedConcurrency: 0,
    rejectedMemoryCritical: 0,
    rejectedLoad: 0,
    rejectedPressure: 0,
    rejectedDrainTimeout: 0,
    rejectedBudgetUnavailable: 0,
    psiEvictLru: 0,
    evictionsGraceful: 0,
    evictionsImmediate: 0,
    drainDurationsMs: [],
  };
  state.reconciler = {
    ticks: 0,
    failedUnitsReset: 0,
    idleEvictions: 0,
    pressureEvictions: 0,
    observationErrors: 0,
    lastTickElapsedMs: 0,
    lastTickActiveCount: 0,
  };
  state.budget = {
    physicalMB: 0,
    reservedMB: 0,
    previewBudgetMB: 0,
    perPreviewCapMB: 0,
    headroomMB: 0,
    activeReservedMB: 0,
  };
  state.delete = { started: 0, completed: 0, failed: 0, stepFailures: {} };
  state.tracking = { currentlyTracked: 0 };
  state.startedAt = Date.now();
}
