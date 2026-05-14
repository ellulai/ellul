// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Caddyfile regeneration bash block — generates, validates, and atomically
 * swaps the Caddyfile after an identity change.
 *
 * Returns a bash fragment. Expects these variables:
 *   SERVER_ID, DOMAIN, DEPLOYMENT_MODEL
 *   log() helper function
 * Sets: CADDY_REGEN (bool), may append to FAILURES string.
 */

import content from '@vps/shell/helpers/system/update-identity/caddy-regen.sh';

export function getCaddyRegenBlock(): string {
  return content;
}
