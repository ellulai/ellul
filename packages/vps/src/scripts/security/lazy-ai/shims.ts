// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import content from '@vps/shell/security/lazy-ai/shims.sh';

/**
 * Lazy AI shims - shell functions that wait for AI tools to install.
 */
export function getLazyAiShimsScript(): string {
  return content;
}
