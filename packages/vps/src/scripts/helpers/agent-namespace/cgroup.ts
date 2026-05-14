// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Cgroup v2 memory limit setup for workspace isolation.
 * Runs after namespace anchor is created (Phase 5.5).
 */
import content from '@vps/shell/helpers/agent-namespace/cgroup.sh';

export function cgroupBlock(): string {
  return content;
}
