// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Workflow scripts index - exports all workflow script generators.
 */
export { getGitFlowScript } from "./git-flow";
export { getGitSetupScript } from "./git-setup";
export { getExposeScript } from "./expose";
export { getAppsScript, getInspectScript } from "./apps";
export { getUndoScript, getCleanScript } from "./maintenance";
export { getDoctorScript, getPerfMonitorScript, getPerfMonitorService } from "./doctor";
export { getServiceInstallerScript } from "./service-installer";
export {
  getPreviewInstanceLauncher,
  getPreviewCtlScript,
  getPreviewTemplateUnit,
  getPreviewSliceUnit,
  getReconcilerServiceUnit,
  getReconcilerTimerUnit,
} from "./preview";
export type { SliceMemoryVars } from "./preview/slice-unit";
export { getControlPlaneSliceUnit } from "./slice/control-plane-unit";
export { getNamespacesSliceUnit } from "./slice/namespaces-unit";
// resource-v2: aggregate user-workload slice. Parent of:
//   - ellul-user-workload-previews.slice (renamed previews)
//   - ellul-user-workload-sbx-<id>.slice (transient per-sandbox)
//   - ellul-pro-claude-slot<N>.scope     (transient slot scopes)
// Spec: docs/v2/architecture/resource-v2/02-cgroup-topology.md
export { getUserWorkloadSliceUnit } from "./slice/user-workload-unit";

// resource-v2: validating wrapper around `systemd-run --scope`. Sole sudoers
// entry; allowlist regexes for slice/unit/property names live in-script.
// Spec: docs/v2/architecture/resource-v2/03-spawn-routing.md
export { getSpawnScopeScript, getSpawnScopeSudoers } from "./spawn-scope";
export { getContextScript, getContextReadme } from "./context";
export { getAiFlowScript } from "./ai-flow";
export { getRuntimeInstallerScript } from "./runtime-installer";
