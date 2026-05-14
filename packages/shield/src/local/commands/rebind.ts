// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * ellul rebind — Explicit workspace rebind
 *
 * Required after moving a workspace directory or changing project.json.
 * Sends rebind request to the running daemon.
 */

import * as fs from 'fs';
import * as path from 'path';
import http from 'http';

const CONFIG_DIR = path.join(process.env.HOME || '~', '.ellul');
const SOCKET_PATH = path.join(CONFIG_DIR, 'daemon.sock');

export async function handleRebind(): Promise<void> {
  if (!fs.existsSync(SOCKET_PATH)) {
    process.stderr.write('Error: Daemon not running. Start with: ellul\n');
    process.exit(1);
  }

  const projectFile = path.join(process.cwd(), '.ellul', 'project.json');
  if (!fs.existsSync(projectFile)) {
    process.stderr.write('Error: No .ellul/project.json in cwd. Run: ellul init\n');
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
  if (!config.projectSlug) {
    process.stderr.write('Error: project.json missing projectSlug\n');
    process.exit(1);
  }

  process.stderr.write(`Rebinding project ${config.projectSlug} to ${process.cwd()}...\n`);

  const body = JSON.stringify({ dir: process.cwd() });

  const result = await new Promise<{ status: number; data: string }>((resolve, reject) => {
    const req = http.request({
      socketPath: SOCKET_PATH,
      method: 'POST',
      path: '/_local/projects/register',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode || 500, data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  if (result.status === 200) {
    process.stderr.write(`✓ Project rebound successfully\n`);
  } else {
    process.stderr.write(`Error: ${result.data}\n`);
    process.exit(1);
  }
}
