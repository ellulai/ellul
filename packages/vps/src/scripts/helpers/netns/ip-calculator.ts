// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * IP/subnet calculation logic for network namespaces.
 * Hash-based IP scheme using port number to guarantee no collisions.
 */

import content from '@vps/shell/helpers/netns/ip-calculator.sh';

export function ipCalculatorBlock(): string {
  return content;
}
