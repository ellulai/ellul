// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * The `teardown)` case: destroy namespace and clean up.
 */

import teardownTemplate from '@vps/templates/helpers/agent-namespace/teardown.sh';
import { networkTeardownBlock } from '../network';

export function teardownBlock(): string {
  return teardownTemplate
    .replace('__NETWORK_TEARDOWN__', () => networkTeardownBlock());
}
