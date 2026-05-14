// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import seccompExecSource from '@vps/shell/helpers/agent-namespace/seccomp-exec.c';

/**
 * Return the C source for the seccomp-BPF exec wrapper.
 * Deployed to /opt/ellul/seccomp-exec.c and compiled during provisioning.
 */
export function getSeccompExecSource(): string {
  return seccompExecSource;
}
