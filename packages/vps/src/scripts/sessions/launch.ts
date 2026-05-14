// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Session launcher script - uses explicit PATH since .bashrc exits early for non-interactive shells.
 * Handles launching different terminal sessions (main, opencode, claude, etc.)
 * @param svcUser - Service user name (coder for free tier, dev for paid)
 */

import skeleton from '@vps/templates/sessions/launch.sh';

export function getSessionLauncherScript(svcUser: string = "dev"): string {
  const svcHome = `/home/${svcUser}`;
  return skeleton
    .split('__SVC_HOME__').join(svcHome);
}
