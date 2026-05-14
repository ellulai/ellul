// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Forwarding setup, DNAT rules, and agent blocking rules.
 */

import content from '@vps/shell/helpers/netns/iptables.sh';

export function forwardingSetupBlock(): string {
  return content;
}
