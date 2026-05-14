// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Fills the `setup)` case template. The mount phases that previously
// lived in __MOUNT_PHASES__ are now invoked directly via systemd-run inside
// the template — the anchor runs as a transient ellul-ns-<project>.service
// in ellul-namespaces.slice, so there's no need for an inner bash -c wrapper.

import setupTemplate from '@vps/templates/helpers/agent-namespace/setup.sh';
import { networkSetupBlock, previewDnatAndNsConfig, cleanupScriptBlock } from '../network';
import { cgroupBlock } from '../cgroup';
import { rsyncAllowlistShell } from '@vps/services/shared/rsync-allowlist';

export function setupBlock(): string {
  if (!setupTemplate.includes('__RSYNC_ALLOWLIST__')) {
    throw new Error(
      'setup.sh template missing __RSYNC_ALLOWLIST__ placeholder — refusing to ship a template that may skip cross-project snapshots',
    );
  }
  return setupTemplate
    .replace('__NETWORK_SETUP__', () => networkSetupBlock())
    .replace('__PREVIEW_DNAT__', () => previewDnatAndNsConfig('SETUP_PREVIEW_PORTS'))
    .replace('__CLEANUP_SCRIPT__', () => cleanupScriptBlock('SETUP_PREVIEW_PORTS'))
    .replace('__RSYNC_ALLOWLIST__', () => rsyncAllowlistShell())
    .replace('__CGROUP__', () => cgroupBlock());
}
