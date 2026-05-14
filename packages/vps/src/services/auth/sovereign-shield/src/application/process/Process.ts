// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Process Service
 *
 * Kill processes on development ports. Ported from enforcer
 * kill_dev_ports() in enforcement.sh.
 *
 * Called via bridge endpoint (passkey-authenticated).
 */

import { execFileSync } from 'child_process';
import { RESERVED_PORTS } from '@vps/shared/constants';

/** Default dev ports to kill (mirrors operations.routes.ts DEV_PORTS) */
export const DEV_PORTS = [3000, 3001, 4000, 5000, 5173, 8000, 8080, 8888, 9000];

/**
 * Kill processes listening on the given ports.
 * Refuses to kill system ports. Returns count of killed + skipped.
 */
export function killPorts(ports: number[]): { killed: number; skipped: number[] } {
  const skipped: number[] = [];
  let killed = 0;

  for (const port of ports) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;

    if (RESERVED_PORTS.has(port)) {
      skipped.push(port);
      continue;
    }

    try {
      execFileSync('bash', ['-c', 'fuser -k -n tcp "$1" 2>/dev/null', '_', String(port)], { timeout: 5_000, stdio: 'pipe' });
      killed++;
    } catch {
      // No process on port or already dead — not an error
    }
  }

  return { killed, skipped };
}
