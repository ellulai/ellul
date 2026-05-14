// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import content from '@vps/shell/workflow/git-setup.sh';

/**
 * Git credential setup script for VPS.
 *
 * Called by the daemon when __GIT_TOKEN secret is detected during secrets sync.
 * Configures git credentials, identity, and remote so the user can push/pull
 * from the dashboard without touching the terminal.
 *
 * Supports GitHub, GitLab, and Bitbucket via HTTPS token authentication.
 */
export function getGitSetupScript(): string {
  return content;
}
