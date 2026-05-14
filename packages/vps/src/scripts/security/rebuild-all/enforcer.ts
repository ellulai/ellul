// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * enforcer.ts -- Assemble the enforcer shell script from .sh library modules.
 */

import * as fs from 'fs';
import * as path from 'path';

import skeleton from '@vps/templates/security/enforcer.sh';
import { ENFORCER_LIB_DIR } from './config';

// ─── Enforcer assembly (inlined -- can't use import.meta.url in CJS) ─

export function assembleEnforcerScript(apiUrl: string, svcHome: string = "/home/dev"): string {
  const readLib = (name: string): string => {
    const libPath = path.join(ENFORCER_LIB_DIR, `${name}.sh`);
    return fs.readFileSync(libPath, 'utf8').replace(/^#!\/bin\/bash\n/, '').trim();
  };

  // agent-sync must come before heartbeat so fetch_entitlement_if_stale
  // and poll_and_execute_commands can call the JWS helpers + sync_agent_bundle.
  const modules = [
    'constants', 'logging', 'terminals', 'security', 'status',
    'enforcement', 'deployment', 'agent-sync', 'heartbeat', 'services',
  ];

  const sections = modules.map((mod) => {
    const header = mod.charAt(0).toUpperCase() + mod.slice(1);
    return `# ============================================\n# ${header}\n# ============================================\n${readLib(mod)}`;
  });

  return skeleton
    .replace('__API_URL__', () => apiUrl)
    .replace('__SECTIONS__', () => sections.join('\n\n'))
    .replace('__SVC_HOME__', () => svcHome);
}
