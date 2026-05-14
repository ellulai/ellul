// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import skeleton from '@vps/templates/workflow/expose.sh';
import { generateBashStackDetect } from '@vps/shared/framework';

/**
 * Expose tool — thin client that delegates to Sovereign Shield.
 *
 * All privileged logic (Caddy config generation, tier enforcement,
 * file writes, service reload) runs server-side in sovereign-shield
 * via POST /api/workflow/expose.
 *
 * This script only does local-only validation and stack detection
 * before sending the request.
 */
export function getExposeScript(): string {
  return skeleton
    .replace('__STACK_DETECT_BLOCK__', () => generateBashStackDetect());
}
