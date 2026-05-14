// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * DESTROY action handler for network namespaces.
 * Returns the bash case body for the destroy action.
 */

import content from '@vps/shell/helpers/netns/actions/destroy.sh';

export function destroyBlock(): string {
  return content;
}
