// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Preview module — per-preview systemd template units.
 *
 * There is no singleton bash daemon and no PM2 process manager. Each active
 * preview runs as an instance of `ellul-preview@<escaped>.service`, under
 * the shared `ellul-user-workload-previews.slice` cgroup cap (subslice of
 * `ellul-user-workload.slice` per resource-v2; was `ellul-previews.slice`
 * pre-v2). The instance launcher reads `<app>/.ellul/preview.json` and
 * execs the dev command.
 *
 * Exports here are consumed by the rebuild-all manifest to deploy:
 *   - /usr/local/bin/ellul-preview-instance    (instance launcher)
 *   - /usr/local/bin/ellul-preview-ctl         (sudo wrapper for file-api)
 *   - /etc/systemd/system/ellul-preview@.service (template unit)
 *   - /etc/systemd/system/ellul-user-workload-previews.slice   (aggregate cgroup)
 */

export { getPreviewInstanceLauncher } from './instance-launcher';
export { getPreviewCtlScript } from './preview-ctl';
export { getPreviewTemplateUnit } from './template-unit';
export { getPreviewSliceUnit, type SliceMemoryVars } from './slice-unit';
export { getReconcilerServiceUnit, getReconcilerTimerUnit } from './reconciler-timer';
