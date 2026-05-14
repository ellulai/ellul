// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Git flow script - branch, save, and ship commands.
 */
import skeleton from '@vps/templates/workflow/git-flow/git-flow.sh';
import {
  cmd_branch,
  cmd_save,
  cmd_ship,
  cmd_backup,
  cmd_force_backup,
  cmd_pull_latest,
} from "./commands.js";

export function getGitFlowScript(): string {
  return skeleton
    .replace('__CMD_BRANCH__', () => cmd_branch())
    .replace('__CMD_SAVE__', () => cmd_save())
    .replace('__CMD_SHIP__', () => cmd_ship())
    .replace('__CMD_BACKUP__', () => cmd_backup())
    .replace('__CMD_FORCE_BACKUP__', () => cmd_force_backup())
    .replace('__CMD_PULL_LATEST__', () => cmd_pull_latest());
}
