// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { describe, it, expect, beforeEach } from 'vitest';

import {
  admissionMetrics,
  reconcilerMetrics,
  deleteMetrics,
  trackingMetrics,
  snapshot,
  renderPrometheus,
  _resetMetricsForTests,
} from './PreviewMetrics';

describe('preview-metrics', () => {
  beforeEach(() => {
    _resetMetricsForTests();
  });

  it('counters are monotonic and never decrement', () => {
    admissionMetrics.accept();
    admissionMetrics.accept();
    admissionMetrics.rejectConcurrency();
    const s = snapshot();
    expect(s.admission.accepted).toBe(2);
    expect(s.admission.rejectedConcurrency).toBe(1);
  });

  it('delete step failure map tracks per-step', () => {
    deleteMetrics.start();
    deleteMetrics.fail('drain');
    deleteMetrics.fail('drain');
    deleteMetrics.fail('remove');
    const s = snapshot();
    expect(s.delete.started).toBe(1);
    expect(s.delete.failed).toBe(3);
    expect(s.delete.stepFailures).toEqual({ drain: 2, remove: 1 });
  });

  it('gauges reflect the last written value', () => {
    reconcilerMetrics.tickEnd(42, 3);
    trackingMetrics.setTrackedCount(7);
    const s = snapshot();
    expect(s.reconciler.lastTickElapsedMs).toBe(42);
    expect(s.reconciler.lastTickActiveCount).toBe(3);
    expect(s.tracking.currentlyTracked).toBe(7);
  });

  it('prometheus output parses as exposition format', () => {
    admissionMetrics.accept();
    reconcilerMetrics.tickEnd(10, 2);
    deleteMetrics.fail('verify');
    const text = renderPrometheus();
    // Required exposition markers
    expect(text).toMatch(/^# HELP ellul_preview_admission_accepted_total/m);
    expect(text).toMatch(/^# TYPE ellul_preview_admission_accepted_total counter/m);
    expect(text).toMatch(/^ellul_preview_admission_accepted_total 1$/m);
    // Gauge presence
    expect(text).toMatch(/^ellul_preview_reconciler_last_tick_elapsed_ms 10$/m);
    // Labelled per-step delete failure
    expect(text).toMatch(/ellul_preview_delete_step_failures_total\{step="verify"\} 1/);
  });

  it('snapshot is defensively cloned (mutation does not leak)', () => {
    admissionMetrics.accept();
    const s1 = snapshot();
    s1.admission.accepted = 9999;
    const s2 = snapshot();
    expect(s2.admission.accepted).toBe(1);
  });
});
