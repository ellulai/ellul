// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * ellul-deployment - Switch deployment model
 *
 * Switches between Cloudflare Edge (CF terminates TLS) and
 * Direct Connect (VPS terminates TLS via Let's Encrypt).
 */

import template from '@vps/templates/security/vps-operations/deployment.sh';
import { getScriptPreamble } from "./common";

export function getDeploymentScript(apiUrl: string): string {
  const preamble = getScriptPreamble({
    scriptName: "ellul-deployment",
    usageSuffix: "<cloudflare|direct>",
    apiUrl,
    standardAction: "switch deployment",
    webLockedAction: "switch deployment",
  });

  return template.replace('__PREAMBLE__', () => preamble);
}
