// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * ellul-rebuild - Rebuild this server with fresh OS
 *
 * Wipes all data and re-provisions. Server resets to Standard tier.
 * Returns new AI proxy token on success.
 */

import template from '@vps/templates/security/vps-operations/rebuild.sh';
import { getScriptPreamble } from "./common";

export function getRebuildScript(apiUrl: string): string {
  const preamble = getScriptPreamble({
    scriptName: "ellul-rebuild",
    apiUrl,
    standardAction: "rebuild this server",
    webLockedAction: "rebuild",
  });

  return template.replace('__PREAMBLE__', () => preamble);
}
