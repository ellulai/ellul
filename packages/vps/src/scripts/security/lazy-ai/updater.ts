// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Update AI tools script — user-facing command to update CLI tools from within the sandbox.
 * Deployed to /usr/local/bin/update-ai-tools. Runs as the service user (no root needed).
 *
 * No set -e: partial success is expected (one registry down shouldn't block the rest).
 * Each tool updates independently with isolated error handling.
 */

import content from '@vps/shell/security/lazy-ai/updater.sh';

export function getUpdateAiToolsScript(): string {
  return content;
}
