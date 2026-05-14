// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * CREATE action handler for network namespaces.
 * Returns the bash case body for the create action.
 */

import content from '@vps/shell/helpers/netns/actions/create.sh';

export function createBlock(): string {
  return content;
}
