// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import content from '@vps/shell/helpers/system/restore-identity.sh';

/**
 * Identity restore script.
 * Runs as root via sudo -- restores passkey DB from volume backup after wake.
 * Called by file-api's /api/restore-identity daemon endpoint.
 *
 * Copies $HOME/.ellul-identity/local-auth.db -> /etc/ellul/shield-data/local-auth.db
 * Sets permissions so sovereign-shield ($SVC_USER) can read/write it.
 * Restores .web_locked_activated marker if it was set at backup time.
 * Restarts sovereign-shield to pick up restored passkey DB.
 */
export function getRestoreIdentityScript(): string {
  return content;
}
