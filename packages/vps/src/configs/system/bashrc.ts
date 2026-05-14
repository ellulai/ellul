// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Bash Configuration
 *
 * Bashrc and MOTD for the service user.
 */

import bashrcSkeleton from '@vps/templates/configs/system/bashrc.sh';
import motdSkeleton from '@vps/templates/configs/system/motd.sh';
import { buildMotdShellCase } from '@ellul.ai/i18n-messages/shell-strings';

/**
 * Bashrc configuration for the service user.
 *
 * @param aiProxyToken - The server's AI proxy token (unused — loaded from file at runtime)
 * @param svcUser - The service user name (coder for free tier, dev for paid)
 */
export function getBashrcConfig(aiProxyToken: string, svcUser: string = "dev"): string {
  const svcHome = `/home/${svcUser}`;
  return bashrcSkeleton
    .split('__SVC_HOME__').join(svcHome);
}

/**
 * MOTD (Message of the Day) script. The per-locale string variables
 * (BANNER_TAGLINE, DEPLOYED_HEADER, …) are emitted from
 * `packages/i18n-messages/messages/<locale>/vpsShell.json` by
 * `buildMotdShellCase()` — single source for every translatable
 * MOTD line. Adding a locale = drop in vpsShell.json; this template
 * stays untouched.
 */
export function getMotdScript(svcUser: string = "dev"): string {
  const svcHome = `/home/${svcUser}`;
  return motdSkeleton
    .split('__SVC_HOME__').join(svcHome)
    .split('__LOCALE_CASES__').join(buildMotdShellCase());
}
