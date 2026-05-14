// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Vault restore bash block — restores bind mounts and permissions from
 * the persisted vault on the volume.
 *
 * Returns a bash fragment (not standalone). Expects these variables:
 *   VAULT, SVC_USER, SVC_HOME, FIRST_BOOT
 *   Sets VAULT_RESTORED=true on success.
 */

import content from '@vps/shell/helpers/system/mount-volume/vault-restore.sh';

export function getVaultRestoreBlock(): string {
  return content;
}
