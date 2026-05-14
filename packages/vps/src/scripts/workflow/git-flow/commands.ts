// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Git flow command functions — each returns a bash function body.
 */

import branchContent from '@vps/shell/workflow/git-flow/commands/branch.sh';
import saveContent from '@vps/shell/workflow/git-flow/commands/save.sh';
import shipContent from '@vps/shell/workflow/git-flow/commands/ship.sh';
import backupContent from '@vps/shell/workflow/git-flow/commands/backup.sh';
import forceBackupContent from '@vps/shell/workflow/git-flow/commands/force-backup.sh';
import pullContent from '@vps/shell/workflow/git-flow/commands/pull.sh';

export function cmd_branch(): string {
  return branchContent;
}

export function cmd_save(): string {
  return saveContent;
}

export function cmd_ship(): string {
  return shipContent;
}

export function cmd_backup(): string {
  return backupContent;
}

export function cmd_force_backup(): string {
  return forceBackupContent;
}

export function cmd_pull_latest(): string {
  return pullContent;
}
