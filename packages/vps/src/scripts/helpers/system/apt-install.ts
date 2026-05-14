// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import content from '@vps/shell/helpers/system/apt-install.sh';

/**
 * Safe package installer script.
 * Runs as root via sudo -- wraps apt-get install with input validation.
 * Prevents command injection via carefully validated package names.
 */
export function getAptInstallScript(): string {
  return content;
}
