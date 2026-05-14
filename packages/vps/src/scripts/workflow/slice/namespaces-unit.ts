// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Aggregate slice for per-project namespace anchors. Each anchor is a
// transient ellul-ns-<project>.service launched by ellul-agent-namespace
// setup via systemd-run. Living in a separate slice from the control plane
// means anchors survive bridge restarts, anchor failures cannot OOM the
// control plane, and the warm-pool has its own resource ceiling.
//
// Body inlined from `@vps/shell/workflow/slice/namespaces-unit.slice`.

import sliceUnit from '@vps/shell/workflow/slice/namespaces-unit.slice';

export function getNamespacesSliceUnit(): string {
  return sliceUnit;
}
