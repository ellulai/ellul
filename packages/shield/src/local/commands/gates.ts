// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * ellul gates — Gate management CLI
 *
 * Commands:
 *   ellul gates status              Show all gate states
 *   ellul gates approve <gate>      Approve gate (operator-signed)
 *   ellul gates deny <gate>         Deny gate (operator-signed)
 *
 * These commands require the daemon to be running (they communicate via socket).
 */

import * as fs from 'fs';
import * as path from 'path';
import http from 'http';

const CONFIG_DIR = path.join(process.env.HOME || '~', '.ellul');
const SOCKET_PATH = path.join(CONFIG_DIR, 'daemon.sock');

function makeLocalRequest(
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (bodyStr) headers['Content-Length'] = String(Buffer.byteLength(bodyStr));

    const req = http.request({ socketPath: SOCKET_PATH, method, path: urlPath, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode || 500, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode || 500, data: { raw: data } }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function getProjectSlug(): string | null {
  try {
    const config = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), '.ellul', 'project.json'), 'utf8'),
    );
    return config.projectSlug || null;
  } catch { return null; }
}

export async function handleGates(args: string[]): Promise<void> {
  const subcommand = args[0];
  const project = getProjectSlug();

  if (!project) {
    process.stderr.write('Error: No project bound in cwd. Run: ellul init\n');
    process.exit(1);
  }

  if (!fs.existsSync(SOCKET_PATH)) {
    process.stderr.write('Error: Daemon not running. Start with: ellul\n');
    process.exit(1);
  }

  switch (subcommand) {
    case 'status': {
      const { status, data } = await makeLocalRequest('GET', `/_local/gates?project=${encodeURIComponent(project)}`);
      if (status !== 200) {
        process.stderr.write(`Error: ${JSON.stringify(data)}\n`);
        process.exit(1);
      }
      const gates = (data as { gates?: Array<{ gate: string; open: boolean; policy: string; expiresAt?: number | null }> }).gates || [];
      process.stderr.write(`Gates for ${project}:\n`);
      for (const g of gates) {
        const state = g.open ? 'OPEN' : 'closed';
        const expiry = g.expiresAt ? ` (expires ${new Date(g.expiresAt).toLocaleTimeString()})` : '';
        process.stderr.write(`  ${g.gate.padEnd(8)} ${state.padEnd(8)} policy: ${g.policy}${expiry}\n`);
      }
      break;
    }

    case 'approve': {
      const gate = args[1];
      if (!gate) {
        process.stderr.write('Usage: ellul gates approve <gate> [duration-seconds]\n');
        process.exit(1);
      }
      // Note: CLI approve bypasses operator signature for convenience when
      // the user is directly typing the command. In the daemon, the REPL
      // performs the actual operator-signed approval. This CLI command
      // sends a request that the daemon handles internally.
      process.stderr.write(`Gate approval must be done from the daemon REPL.\n`);
      process.stderr.write(`Start the daemon with 'ellul' and use /approve ${gate}\n`);
      break;
    }

    case 'deny': {
      const gate = args[1];
      if (!gate) {
        process.stderr.write('Usage: ellul gates deny <gate>\n');
        process.exit(1);
      }
      process.stderr.write(`Gate denial must be done from the daemon REPL.\n`);
      process.stderr.write(`Start the daemon with 'ellul' and use /deny ${gate}\n`);
      break;
    }

    default:
      process.stderr.write(
        'Usage: ellul gates <status|approve|deny>\n\n' +
        '  status              Show all gate states\n' +
        '  approve <gate>      Approve gate (from daemon REPL)\n' +
        '  deny <gate>         Deny gate (from daemon REPL)\n',
      );
      if (subcommand) process.exit(1);
  }
}
