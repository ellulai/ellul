// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * The `enter)` case: fast nsenter into existing persistent namespace.
 */
import content from '@vps/shell/helpers/agent-namespace/enter.sh';

export function enterBlock(): string {
  return content;
}
