// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * AI flow command functions — each returns a bash function body.
 */

import saveContent from '@vps/shell/workflow/ai-flow/commands/save.sh';
import shipContent from '@vps/shell/workflow/ai-flow/commands/ship.sh';
import shipUpdateContent from '@vps/shell/workflow/ai-flow/commands/ship-update.sh';
import shipManualContent from '@vps/shell/workflow/ai-flow/commands/ship-manual.sh';
import helpContent from '@vps/shell/workflow/ai-flow/commands/help.sh';

export function cmd_save(): string {
  return saveContent;
}

export function cmd_ship(): string {
  return shipContent;
}

export function cmd_ship_update(): string {
  return shipUpdateContent;
}

export function cmd_ship_manual(): string {
  return shipManualContent;
}

export function cmd_help(): string {
  return helpContent;
}
