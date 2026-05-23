// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Caddy Admin API — shared reload utility for VPS services.
 *
 * Uses Node.js http module to POST the Caddyfile directly to Caddy's
 * admin unix socket. This avoids:
 * - `caddy reload` CLI, which fails in ProtectSystem=strict sandboxes
 *   (local validation tries to open log files in the read-only filesystem)
 * - `curl` shell-out, which adds an external binary dependency and
 *   shell escaping surface
 *
 * The admin API validates and applies the config server-side in Caddy's
 * own (unrestricted) process context.
 */

import * as fs from 'fs';
import * as http from 'http';

export const CADDY_ADMIN_SOCK = '/run/caddy/admin.sock';
const CADDYFILE_PATH = '/etc/caddy/Caddyfile';
const RELOAD_TIMEOUT_MS = 10_000;
const IS_ANDROID = process.env.ELLUL_PLATFORM === 'android';

export function reloadCaddy(): Promise<void> {
  const caddyfile = fs.readFileSync(CADDYFILE_PATH, 'utf8');
  const body = Buffer.from(caddyfile, 'utf8');

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (fn: typeof resolve | typeof reject, val?: unknown) => {
      if (settled) return;
      settled = true;
      (fn as Function)(val);
    };

    const opts: http.RequestOptions = IS_ANDROID
      ? { hostname: '127.0.0.1', port: 2019, path: '/load', method: 'POST' }
      : { socketPath: CADDY_ADMIN_SOCK, path: '/load', method: 'POST' };

    const req = http.request(
      {
        ...opts,
        headers: {
          'Content-Type': 'text/caddyfile',
          'Content-Length': body.length,
        },
        timeout: RELOAD_TIMEOUT_MS,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk; });
        res.on('error', (err) => settle(reject, new Error(`Caddy admin response error: ${err.message}`)));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            settle(reject, new Error(`Caddy admin API ${res.statusCode}: ${data.slice(0, 500)}`));
          } else {
            settle(resolve);
          }
        });
      },
    );

    req.on('error', (err) => settle(reject, new Error(`Caddy admin socket error: ${err.message}`)));
    req.on('timeout', () => {
      req.destroy();
      settle(reject, new Error(`Caddy admin API timeout (${RELOAD_TIMEOUT_MS}ms)`));
    });

    req.end(body);
  });
}
