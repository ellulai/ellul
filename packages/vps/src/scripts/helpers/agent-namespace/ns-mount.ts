// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Compiled mount helper source for provisioning payload.
 *
 * Deployed as /opt/ellul/ns-mount.c, compiled to /usr/local/bin/ellul-ns-mount.
 * Same deployment pattern as seccomp-exec.c.
 */

import content from '@vps/shell/helpers/agent-namespace/ns-mount.c';

export function getNsMountSource(): string {
  return content;
}
