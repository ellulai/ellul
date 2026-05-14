// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import content from '@vps/configs/system/gitignore.txt';

/**
 * Global gitignore configuration for ellul servers.
 * Prevents accidental commits of secrets and common generated files.
 */
export function getGlobalGitignore(): string {
  return content;
}
