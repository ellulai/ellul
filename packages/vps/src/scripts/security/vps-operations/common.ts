// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Shared bash preamble for VPS operation scripts.
 *
 * Every VPS operation script needs:
 * - Color codes
 * - Root check
 * - Server ID, API URL, token loading
 * - Tier guard (standard/web_locked redirect to dashboard)
 */

import skeleton from '@vps/templates/security/vps-operations/common.sh';

interface PreambleOptions {
  /** Script name for usage messages, e.g. "ellul-delete" */
  scriptName: string;
  /** Usage suffix after the script name, e.g. "<cloudflare|direct>" */
  usageSuffix?: string;
  /** Platform API base URL */
  apiUrl: string;
  /** Dashboard action description for standard tier, e.g. "delete this server" */
  standardAction: string;
  /** Dashboard action description for web_locked tier, e.g. "delete" */
  webLockedAction: string;
}

/**
 * Generate the common bash preamble shared by all VPS operation scripts.
 *
 * Returns a string containing: shebang, color codes, root check,
 * credential loading (server ID, token), and tier guard.
 *
 * After this preamble, the following variables are available:
 * - $RED, $GREEN, $YELLOW, $CYAN, $NC (colors)
 * - $SERVER_ID, $TOKEN, $API_URL, $TIER
 */
export function getScriptPreamble(opts: PreambleOptions): string {
  const usage = opts.usageSuffix
    ? `sudo ${opts.scriptName} ${opts.usageSuffix}`
    : `sudo ${opts.scriptName}`;

  return skeleton
    .split('__SCRIPT_NAME__').join(opts.scriptName)
    .split('__USAGE__').join(usage)
    .replace('__API_URL__', () => opts.apiUrl)
    .replace('__STANDARD_ACTION__', () => opts.standardAction)
    .replace('__WEB_LOCKED_ACTION__', () => opts.webLockedAction);
}
