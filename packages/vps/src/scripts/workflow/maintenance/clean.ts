// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import content from '@vps/shell/workflow/maintenance/clean.sh';

/**
 * Clean/janitor tool - disk cleanup.
 */
export function getCleanScript(): string {
  return content;
}
