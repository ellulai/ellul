// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Input validation and global variable setup for the agent-namespace script.
 * Returns bash code that validates ACTION/PROJECT args and sets up SVC_USER, SVC_HOME, etc.
 */
import content from '@vps/shell/helpers/agent-namespace/validation.sh';

export function validationBlock(): string {
  return content;
}
