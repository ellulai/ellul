// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Flush, force-unmount, and LUKS-close bash blocks.
 *
 * Returns a bash fragment for the `flush`, `force-unmount`, and `luks-close`
 * case branches. Expects SVC_HOME to be set by the caller.
 */

import content from '@vps/shell/helpers/system/mount-volume/flush-unmount.sh';

export function getFlushUnmountBlock(): string {
  return content;
}
