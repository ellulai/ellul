// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * ellul-change-tier - Change server billing tier
 *
 * Involves billing changes (Stripe) and potentially infrastructure
 * migration if moving between cloud providers.
 */

import template from '@vps/templates/security/vps-operations/change-tier.sh';
import { getScriptPreamble } from "./common";

export function getChangeTierScript(apiUrl: string): string {
  const preamble = getScriptPreamble({
    scriptName: "ellul-change-tier",
    usageSuffix: "<starter|pro|plus|business|scale>",
    apiUrl,
    standardAction: "change tiers",
    webLockedAction: "change tier",
  });

  return template.replace('__PREAMBLE__', () => preamble);
}
