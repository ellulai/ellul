// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import type { SliceMemoryVars } from '../preview/slice-unit';

export function getControlPlaneSliceUnit(vars?: SliceMemoryVars): string {
  const high = vars ? `${vars.controlPlaneHighMB}M` : '${ELLUL_CONTROL_PLANE_HIGH_MB}M';
  const max = vars ? `${vars.controlPlaneMaxMB}M` : '${ELLUL_CONTROL_PLANE_MAX_MB}M';
  return [
    '[Unit]',
    'Description=Aggregate cgroup cap for ellul control-plane services',
    'Before=slices.target',
    '',
    '[Slice]',
    `MemoryHigh=${high}`,
    `MemoryMax=${max}`,
    'MemorySwapMax=0',
    'ManagedOOMMemoryPressure=kill',
    'ManagedOOMMemoryPressureLimit=75%',
    'ManagedOOMSwap=kill',
    'TasksMax=600',
    'CPUQuota=300%',
    '',
  ].join('\n');
}
