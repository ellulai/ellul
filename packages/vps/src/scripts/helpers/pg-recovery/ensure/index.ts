// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import content from '@vps/shell/helpers/pg-recovery/ensure.sh';

/**
 * Shield-callable PG ensure script.
 *
 * Deployed to /usr/local/bin/shield-pg-ensure (mode 0755, root-owned).
 * Called by sovereign-shield via: sudo /usr/local/bin/shield-pg-ensure
 *
 * This is a thin wrapper that:
 *  1. Runs the full recovery script (handles WAL corruption, ownership, etc.)
 *  2. Detects and restarts the actual PostgreSQL cluster unit
 *  3. Waits for pg_isready with retries
 *  4. Exits 0 on success, 1 on failure
 *
 * No arguments accepted (zero injection surface). Hard timeout of 30s.
 * Shield-runner gets a scoped sudoers entry for exactly this path.
 */

export function getPgEnsureScript(): string {
  return content;
}
