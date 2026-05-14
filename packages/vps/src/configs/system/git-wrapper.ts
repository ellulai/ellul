// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import content from '@vps/configs/system/git-wrapper.sh';

/**
 * Git wrapper script content.
 *
 * Intercepts `git pull` and `git fetch` commands and routes them through
 * sovereign-shield's internal API. This ensures credentials never leave
 * sovereign-shield's process memory while making git read operations
 * transparent for AI agents.
 *
 * All other git commands pass through to the real git binary.
 */
export function getGitWrapper(): string {
  return content;
}
