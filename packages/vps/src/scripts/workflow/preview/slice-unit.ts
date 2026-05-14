// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Aggregate cgroup slice for every preview unit, deployed to
 * /etc/systemd/system/ellul-user-workload-previews.slice.
 *
 * Sizing is host-aware: cap matches admission's perPreviewBudget exactly.
 * Two emit modes:
 *   - no args: bash-variable placeholders (`${ELLUL_PREVIEW_BUDGET_MB}M`)
 *     for unquoted heredoc substitution in the provisioning payload.
 *   - vars passed: concrete MB values for direct fs writes (rebuild-all).
 *
 * Single source of truth: memory-budget.ts.
 */

export interface SliceMemoryVars {
  workloadMaxMB: number;
  workloadHighMB: number;
  previewBudgetMB: number;
  previewHighMB: number;
  controlPlaneMaxMB: number;
  controlPlaneHighMB: number;
}

export function getPreviewSliceUnit(vars?: SliceMemoryVars): string {
  const high = vars ? `${vars.previewHighMB}M` : '${ELLUL_PREVIEW_HIGH_MB}M';
  const max = vars ? `${vars.previewBudgetMB}M` : '${ELLUL_PREVIEW_BUDGET_MB}M';
  return [
    '[Unit]',
    'Description=Aggregate cgroup cap for all ellul preview units (subslice of ellul-user-workload.slice)',
    'Before=slices.target',
    '',
    '[Slice]',
    `MemoryHigh=${high}`,
    `MemoryMax=${max}`,
    'MemorySwapMax=0',
    'ManagedOOMMemoryPressure=kill',
    'ManagedOOMMemoryPressureLimit=60%',
    'ManagedOOMSwap=kill',
    'TasksMax=1200',
    'CPUQuota=300%',
    '',
  ].join('\n');
}
