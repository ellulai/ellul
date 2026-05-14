// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Environment Shield Preload Script
 *
 * Returns the contents of env-shield-preload.cjs for deployment to VPS.
 * Deployed to /usr/local/lib/ellul/env-shield-preload.cjs.
 * Injected via NODE_OPTIONS="--require ..." in shielded Node.js processes.
 *
 * Wraps process.env in a Proxy that:
 *   - Allows individual access: process.env.DATABASE_URL → works
 *   - Hides secret keys from enumeration: Object.keys(process.env) → no secrets
 *   - Prevents JSON.stringify(process.env) from leaking secrets
 *   - Prevents {...process.env} spread from capturing secrets
 */

import content from '@vps/configs/env-shield-preload.js.txt';

export function getEnvShieldPreload(): string {
  return content;
}
