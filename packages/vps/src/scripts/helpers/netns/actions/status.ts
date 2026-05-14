// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * STATUS action handler for network namespaces.
 * Returns the bash case body for the status action.
 */

import content from '@vps/shell/helpers/netns/actions/status.sh';

export function statusBlock(): string {
  return content;
}
