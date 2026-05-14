// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Device detection, filesystem setup, and mount bash block.
 *
 * Returns a bash fragment for the `mount` action. Handles:
 *   - Device path validation (raw devices + stable /dev/disk/by-id/ symlinks)
 *   - Async device wait (cloud attach can take 30-60s)
 *   - Filesystem detection and first-boot formatting
 *   - Skeleton home directory backup/restore
 *   - nosuid/nodev mount with fstab persistence
 *   - Ownership fixup (excluding vault)
 *
 * Expects: DEVICE, SVC_USER, SVC_HOME variables set by caller.
 * Sets: FIRST_BOOT variable for downstream vault restore.
 */

import content from '@vps/shell/helpers/system/mount-volume/device-mount.sh';

export function getDeviceMountBlock(): string {
  return content;
}
