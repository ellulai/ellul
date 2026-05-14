// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import content from '@vps/shell/workflow/maintenance/undo.sh';

/**
 * Undo/rollback tool - time machine for projects.
 */
export function getUndoScript(): string {
  return content;
}
