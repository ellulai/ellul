// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Volume mount helper script.
 * Runs as root via sudo -- mounts block volumes at the service user's home.
 * Called by file-api during wake from hibernation.
 *
 * Composed from:
 *   - device-mount: device validation, filesystem setup, skeleton backup/restore
 *   - vault-restore: bind mount restoration from persisted vault
 *   - flush-unmount: flush, force-unmount, and LUKS-close actions
 */
import skeleton from '@vps/templates/helpers/system/mount-volume/mount-volume.sh';
import { getDeviceMountBlock } from './device-mount';
import { getVaultRestoreBlock } from './vault-restore';
import { getFlushUnmountBlock } from './flush-unmount';

export function getMountVolumeScript(): string {
  return skeleton
    .replace('__DEVICE_MOUNT__', () => getDeviceMountBlock())
    .replace('__VAULT_RESTORE__', () => getVaultRestoreBlock())
    .replace('__FLUSH_UNMOUNT__', () => getFlushUnmountBlock());
}
