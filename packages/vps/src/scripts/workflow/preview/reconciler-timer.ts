// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Boot-durable reconciler timer.
 *
 * The in-process `setTimeout` loop in `preview-reconciler.ts` runs
 * while file-api is alive. If file-api crashes or is restarting
 * during a reset-failed sweep, the sweep is simply missed — not
 * dangerous (next tick will catch up), but there's a window where
 * a failed preview unit holds systemd tracking with nothing to
 * reset it.
 *
 * This timer + service pair is an INDEPENDENT safety net:
 *
 *   - `ellul-preview-reconciler.timer` fires every 5 minutes and
 *     triggers a single-shot reconcile via HTTP to file-api's
 *     `/api/preview/reconcile` endpoint. If file-api is down, the
 *     timer retries on the next tick.
 *   - `ellul-preview-reconciler.service` is the one-shot unit the
 *     timer activates. It hits the local HTTP endpoint so no extra
 *     process is spawned inside file-api's address space.
 *
 * The primary 10-second in-process reconciler handles normal
 * operation; this timer catches the "file-api just restarted and
 * hasn't ticked yet" / "in-process reconciler stopped due to bug"
 * failure modes.
 *
 * 5-minute period chosen because the in-process loop is 10s —
 * timer fire is safety-net-only, not the steady-state driver.
 * Running every minute would log-spam journals for no benefit.
 *
 * Both unit bodies live under `@vps/shell/workflow/preview/` and are
 * inlined at build time — valid unit syntax, editor-inspectable, no JS
 * template-literal escaping required.
 */

import reconcilerService from '@vps/shell/workflow/preview/reconciler-service.service';
import reconcilerTimer from '@vps/shell/workflow/preview/reconciler-timer.timer';

/**
 * Service unit — one-shot HTTP POST to file-api's reconcile endpoint.
 * The `--max-time 10` prevents a hung connection from blocking future
 * timer fires.
 */
export function getReconcilerServiceUnit(): string {
  return reconcilerService;
}

/**
 * Timer unit — fires every 5 minutes. Uses OnBootSec so it runs
 * immediately after boot (not after a 5-minute grace period), then
 * OnUnitActiveSec for the period thereafter.
 */
export function getReconcilerTimerUnit(): string {
  return reconcilerTimer;
}
