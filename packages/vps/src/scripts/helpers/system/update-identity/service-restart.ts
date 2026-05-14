// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Service restart and verification bash block — dependency-aware restart
 * with retry, stabilization check, and Caddy safety trap.
 *
 * Returns a bash fragment. Expects these variables:
 *   DOMAIN, CADDY_REGEN, FAILURES, SERVER_ID
 *   log() helper function
 */

import content from '@vps/shell/helpers/system/update-identity/service-restart.sh';

export function getServiceRestartBlock(): string {
  return content;
}
