// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import type { SliceMemoryVars } from '../preview/slice-unit';

export function getUserWorkloadSliceUnit(vars?: SliceMemoryVars): string {
  const high = vars ? `${vars.workloadHighMB}M` : '${ELLUL_WORKLOAD_HIGH_MB}M';
  const max = vars ? `${vars.workloadMaxMB}M` : '${ELLUL_WORKLOAD_MAX_MB}M';
  return [
    '[Unit]',
    'Description=Aggregate cgroup cap for ellul user workloads (previews + per-sandbox adapter pools + Pro Claude slot processes)',
    'Before=slices.target',
    '',
    '[Slice]',
    `MemoryHigh=${high}`,
    `MemoryMax=${max}`,
    'MemorySwapMax=0',
    'ManagedOOMMemoryPressure=kill',
    'ManagedOOMMemoryPressureLimit=80%',
    'ManagedOOMSwap=kill',
    'TasksMax=4096',
    'CPUQuota=600%',
    '',
  ].join('\n');
}
