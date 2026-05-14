// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Lock-web-only script - permanently disables SSH key installation
 * without installing a key. Creates sovereign lock with port 22 blocked.
 * One-way operation.
 *
 * SAFETY: Verifies web terminal is accessible before blocking SSH to prevent bricking.
 */

import content from '@vps/shell/security/lock-web-only.sh';

export function getLockWebOnlyScript(): string {
  return content;
}
