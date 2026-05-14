// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * ellul-delete - Permanently delete this server
 *
 * Proves SSH access by requiring terminal execution.
 * Calls platform API to destroy server and cancel subscription.
 */

import template from '@vps/templates/security/vps-operations/delete.sh';
import { getScriptPreamble } from "./common";

export function getDeleteScript(apiUrl: string): string {
  const preamble = getScriptPreamble({
    scriptName: "ellul-delete",
    apiUrl,
    standardAction: "delete this server",
    webLockedAction: "delete",
  });

  return template.replace('__PREAMBLE__', () => preamble);
}
