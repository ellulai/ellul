// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import content from '@vps/shell/workflow/doctor/perf-monitor.sh';

/**
 * Performance monitor script - reports status for dashboard.
 *
 * @param apiUrl - The ellul API URL
 * @param aiProxyToken - The server's AI proxy token
 */
export function getPerfMonitorScript(): string {
  return content;
}
