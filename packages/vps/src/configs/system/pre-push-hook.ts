// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import content from '@vps/configs/system/pre-push-hook.sh';

/**
 * Pre-push hook that blocks git push without a valid GIT_PUSH_TOKEN.
 * Validates token against sovereign-shield before allowing the push.
 * Installed globally via git config core.hooksPath.
 */
export function getPrePushHook(): string {
  return content;
}
