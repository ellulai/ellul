// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Permission metrics — lightweight in-process counters & histograms.
 *
 * Prometheus text format over a dedicated read endpoint. No pull from
 * the DB at scrape time: every counter increments synchronously when
 * a state transition fires in permission.service, so scrape latency
 * is O(1) regardless of permission_requests row count.
 *
 * Labels kept intentionally narrow:
 *   - gate       — which gate type (env, db_write, etc.)
 *   - action     — grant_timed|grant_session|grant_always|deny|deny_always
 *   - outcome    — created|resolved|conflict|expired|revoked
 * We DELIBERATELY omit sandboxId to avoid cardinality explosion on multi-tenant
 * hosts. Per-sandbox detail lives in audit_log for offline analysis.
 */

import { permissionBus, type PermissionEvent } from './Permission';

// ── Counters ────────────────────────────────────────────────────────────

type CounterKey = string;
const counters = new Map<CounterKey, number>();

function bump(name: string, labels: Record<string, string>): void {
  const key = formatKey(name, labels);
  counters.set(key, (counters.get(key) ?? 0) + 1);
}

function formatKey(name: string, labels: Record<string, string>): string {
  const parts = Object.keys(labels).sort().map((k) => `${k}="${escapeLabel(labels[k] ?? '')}"`);
  return `${name}{${parts.join(',')}}`;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

// ── Histogram (time-to-resolve) ────────────────────────────────────────
// Exponential buckets from 250ms to 5min covers the realistic range —
// anything over 5min indicates the agent will have timed out and is a
// hard bug signal worth a separate alarm.
const LATENCY_BUCKETS_MS = [250, 500, 1_000, 2_000, 5_000, 15_000, 60_000, 300_000];

interface HistState {
  counts: number[];     // count per bucket + infinity
  sum: number;
  total: number;
}

const histograms = new Map<string, HistState>();

function observe(name: string, labels: Record<string, string>, valueMs: number): void {
  const key = formatKey(name, labels);
  let state = histograms.get(key);
  if (!state) {
    state = {
      counts: new Array(LATENCY_BUCKETS_MS.length + 1).fill(0),
      sum: 0,
      total: 0,
    };
    histograms.set(key, state);
  }
  state.sum += valueMs;
  state.total += 1;
  let placed = false;
  for (let i = 0; i < LATENCY_BUCKETS_MS.length; i++) {
    const bound = LATENCY_BUCKETS_MS[i]!;
    if (valueMs <= bound) {
      state.counts[i] = (state.counts[i] ?? 0) + 1;
      placed = true;
      break;
    }
  }
  if (!placed) {
    const lastIdx = LATENCY_BUCKETS_MS.length;
    state.counts[lastIdx] = (state.counts[lastIdx] ?? 0) + 1;
  }
}

// ── Event wiring ────────────────────────────────────────────────────────

export function initPermissionMetrics(): void {
  permissionBus.on('event', (event: PermissionEvent) => {
    switch (event.type) {
      case 'request.created':
        bump('ellul_permission_requested_total', { gate: String(event.request.gate) });
        break;
      case 'request.resolved': {
        const action = event.request.resolution?.action ?? 'unknown';
        bump('ellul_permission_resolved_total', {
          gate: String(event.request.gate),
          action,
          outcome: action.startsWith('grant') ? 'granted' : 'denied',
        });
        if (event.request.resolvedAt && event.request.createdAt) {
          const latency = event.request.resolvedAt - event.request.createdAt;
          observe('ellul_permission_time_to_resolve_ms', {
            gate: String(event.request.gate),
            outcome: action.startsWith('grant') ? 'granted' : 'denied',
          }, latency);
        }
        break;
      }
      case 'request.revoked':
        bump('ellul_permission_revoked_total', { gate: String(event.request.gate) });
        break;
      case 'request.expired':
        bump('ellul_permission_expired_total', { gate: String(event.request.gate) });
        break;
      case 'request.seen':
        // Not a counter — surfaces nothing useful for SLOs.
        break;
    }
  });
}

/**
 * Called explicitly from the grant/deny routes when shield rejects with
 * 409 (resolved elsewhere). Not derivable from the event bus because
 * nothing transitions.
 */
export function recordConflict(gate: string): void {
  bump('ellul_permission_conflict_total', { gate });
}

/**
 * Called by the gate_response handler in agent-bridge via shield when a
 * PoP signature fails verification. Drives alerting on possible replay
 * attempts.
 */
export function recordPopRejection(reason: 'invalid' | 'replay' | 'expired' | 'missing', gate: string): void {
  bump('ellul_permission_pop_rejected_total', { reason, gate });
}

// ── Exposure ───────────────────────────────────────────────────────────

/**
 * Serialize current state as Prometheus text format (application/openmetrics-text
 * compatible for the counter + histogram shapes we use).
 */
export function renderMetrics(): string {
  const lines: string[] = [];

  lines.push('# HELP ellul_permission_requested_total Permission requests created');
  lines.push('# TYPE ellul_permission_requested_total counter');
  lines.push('# HELP ellul_permission_resolved_total Permission requests resolved (granted or denied)');
  lines.push('# TYPE ellul_permission_resolved_total counter');
  lines.push('# HELP ellul_permission_conflict_total Resolutions rejected as 409 (resolved elsewhere)');
  lines.push('# TYPE ellul_permission_conflict_total counter');
  lines.push('# HELP ellul_permission_revoked_total Previously granted permissions revoked');
  lines.push('# TYPE ellul_permission_revoked_total counter');
  lines.push('# HELP ellul_permission_expired_total Pending permissions that aged out');
  lines.push('# TYPE ellul_permission_expired_total counter');
  lines.push('# HELP ellul_permission_pop_rejected_total PoP signature rejections by reason');
  lines.push('# TYPE ellul_permission_pop_rejected_total counter');

  for (const [key, value] of counters) {
    lines.push(`${key} ${value}`);
  }

  lines.push('# HELP ellul_permission_time_to_resolve_ms Wall-clock latency from request creation to resolution');
  lines.push('# TYPE ellul_permission_time_to_resolve_ms histogram');
  for (const [key, state] of histograms) {
    // key looks like `ellul_permission_time_to_resolve_ms{gate="env",outcome="granted"}`
    const nameAndLabels = key.match(/^([^{]+)(\{.*\})$/);
    if (!nameAndLabels || !nameAndLabels[1] || !nameAndLabels[2]) continue;
    const name = nameAndLabels[1];
    const labels = nameAndLabels[2];
    const labelsInner = labels.slice(1, -1); // strip braces
    let cumulative = 0;
    for (let i = 0; i < LATENCY_BUCKETS_MS.length; i++) {
      cumulative += state.counts[i] ?? 0;
      const bucketLabels = labelsInner ? `${labelsInner},le="${LATENCY_BUCKETS_MS[i]}"` : `le="${LATENCY_BUCKETS_MS[i]}"`;
      lines.push(`${name}_bucket{${bucketLabels}} ${cumulative}`);
    }
    cumulative += state.counts[LATENCY_BUCKETS_MS.length] ?? 0;
    const infLabels = labelsInner ? `${labelsInner},le="+Inf"` : `le="+Inf"`;
    lines.push(`${name}_bucket{${infLabels}} ${cumulative}`);
    lines.push(`${name}_sum${labels} ${state.sum}`);
    lines.push(`${name}_count${labels} ${state.total}`);
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Snapshot for tests / health pages. Returns a plain object, never
 * mutated by callers.
 */
export function snapshotMetrics(): {
  counters: Record<string, number>;
  histograms: Record<string, { buckets: Record<string, number>; sum: number; count: number }>;
} {
  const c: Record<string, number> = {};
  for (const [k, v] of counters) c[k] = v;

  const h: Record<string, { buckets: Record<string, number>; sum: number; count: number }> = {};
  for (const [k, s] of histograms) {
    const buckets: Record<string, number> = {};
    let cumulative = 0;
    for (let i = 0; i < LATENCY_BUCKETS_MS.length; i++) {
      cumulative += s.counts[i] ?? 0;
      buckets[String(LATENCY_BUCKETS_MS[i])] = cumulative;
    }
    cumulative += s.counts[LATENCY_BUCKETS_MS.length] ?? 0;
    buckets['+Inf'] = cumulative;
    h[k] = { buckets, sum: s.sum, count: s.total };
  }

  return { counters: c, histograms: h };
}

/** Test-only — resets all metric state. Not exported from the package. */
export function _resetMetrics(): void {
  counters.clear();
  histograms.clear();
}
