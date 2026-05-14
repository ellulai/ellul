// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * APPLY-WHITELIST action — nftables rule generation from JSON input.
 */

import content from '@vps/shell/helpers/netns/whitelist.sh';

export function whitelistBlock(): string {
  return content;
}
