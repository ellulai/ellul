// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import content from '@vps/configs/system/pre-commit-hook.sh';

/**
 * Pre-commit hook that blocks commits containing secrets or sensitive files.
 * Installed globally via git config core.hooksPath.
 */
export function getPreCommitHook(): string {
  return content;
}
