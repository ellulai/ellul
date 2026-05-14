// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import content from '@vps/shell/workflow/doctor/health-checks.sh';

/**
 * Doctor script - system diagnostics and health check.
 */
export function getDoctorScript(): string {
  return content;
}
