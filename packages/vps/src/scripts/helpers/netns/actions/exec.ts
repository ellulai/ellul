// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * EXEC action handler for network namespaces.
 * Returns the bash case body for the exec action.
 */

import content from '@vps/shell/helpers/netns/actions/exec.sh';

export function execBlock(): string {
  return content;
}
