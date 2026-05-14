// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Capabilities Routes
 *
 * Declares what this VPS version supports.
 * No authentication required — must work before session exists.
 * Dashboard fetches this on connect to adapt UI for the VPS version.
 */

import fs from 'fs';
import { execFileSync } from 'child_process';
import type { Hono } from 'hono';
import { CAPABILITIES } from '@vps/version';

const AGENT_VERSIONS_FILE = '/etc/ellul/shield-data/.agent-versions.json';

function readInstalledVersion(): string {
  try {
    const raw = fs.readFileSync(AGENT_VERSIONS_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, string>;
    return parsed['ellul-env'] ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Register capabilities routes on Hono app
 */
export function registerCapabilitiesRoutes(app: Hono): void {
  app.get('/_auth/capabilities', (c) => {
    return c.json({
      version: readInstalledVersion(),
      endpoints: CAPABILITIES.endpoints,
      features: [...CAPABILITIES.features],
    });
  });

  /**
   * POST /_auth/wake-enforcer — Send SIGUSR1 to enforcer for instant command pickup.
   *
   * Called by API (Cloud Run) after enqueuing a command. Reduces command latency
   * from 10s (next heartbeat poll) to <1s (immediate signal).
   *
   * Auth: server ID in body (UUID, unguessable). Verifies against local server-id.
   * SIGUSR1 is harmless (just triggers an immediate heartbeat poll).
   * No session required — listed in DIRECT_AUTH_PATHS (bypasses forward_auth).
   */
  app.post('/_auth/wake-enforcer', async (c) => {
    try {
      const body = await c.req.json().catch(() => null);
      const providedId = body?.serverId || '';

      const localId = fs.readFileSync('/etc/ellul-bootstrap/server-id', 'utf8').trim();
      if (!providedId || providedId !== localId) {
        return c.json({ success: false, error: 'Invalid server ID' }, 401);
      }

      const pidFile = '/run/ellul-enforcer.pid';
      if (!fs.existsSync(pidFile)) {
        return c.json({ success: false, error: 'Enforcer not running' }, 404);
      }

      const pid = fs.readFileSync(pidFile, 'utf8').trim();
      if (!/^\d+$/.test(pid)) {
        return c.json({ success: false, error: 'Invalid PID' }, 500);
      }

      execFileSync('kill', ['-USR1', pid], { timeout: 2000 });
      return c.json({ success: true, pid: parseInt(pid) });
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    }
  });
}
