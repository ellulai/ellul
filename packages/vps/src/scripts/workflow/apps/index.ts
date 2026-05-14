// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import appsContent from '@vps/shell/workflow/apps/apps.sh';
import inspectContent from '@vps/shell/workflow/apps/inspect.sh';

/**
 * Apps list tool - shows deployed applications.
 */
export function getAppsScript(): string {
  return appsContent;
}

/**
 * Inspect tool - AI-powered app analysis.
 */
export function getInspectScript(): string {
  return inspectContent;
}
