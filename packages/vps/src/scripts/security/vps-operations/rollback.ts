// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * ellul-rollback - Rollback to pre-update snapshot
 *
 * Restores server to its state before the last update.
 * Snapshots expire after 24 hours.
 */

import template from '@vps/templates/security/vps-operations/rollback.sh';
import { getScriptPreamble } from "./common";

export function getRollbackScript(apiUrl: string): string {
  const preamble = getScriptPreamble({
    scriptName: "ellul-rollback",
    apiUrl,
    standardAction: "rollback",
    webLockedAction: "rollback",
  });

  return template.replace('__PREAMBLE__', () => preamble);
}
