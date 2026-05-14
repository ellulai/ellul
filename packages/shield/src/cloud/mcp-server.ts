#!/usr/bin/env node

// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * ellul-mcp — Unified MCP Server for AI Agent Integration
 *
 * Single binary for both cloud and local modes. Detects mode from
 * .ellul/project.json and delegates to the appropriate handler.
 *
 * Cloud mode: connects to auth proxy daemon via HTTP (port-based)
 * Local mode: connects to local daemon via Unix socket or TCP
 */

import * as path from 'path';
import { detectMode } from '../lib/mode';

// Deprecation notice for legacy binary name
const _binName = path.basename(process.argv[1] || '');
if (_binName === 'ellul-mcp-local') {
  process.stderr.write("[deprecated] 'ellul-mcp-local' is now 'ellul-mcp'. Use 'ellul-mcp' instead.\n");
}

async function main(): Promise<void> {
  const mode = detectMode();

  if (mode === 'uninitialized') {
    process.stderr.write(
      '[mcp] No .ellul/project.json found in current directory.\n' +
      "[mcp] Run 'ellul init' to create a project first.\n",
    );
    process.exit(1);
  }

  if (mode === 'local') {
    try {
      const { startLocalMcp } = await import('../local/mcp/server');
      await startLocalMcp();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('better-sqlite3') || msg.includes('better_sqlite3')) {
        process.stderr.write(
          '[mcp] Local mode requires better-sqlite3 which is not installed.\n' +
          '[mcp] Install with: npm install better-sqlite3\n',
        );
        process.exit(1);
      }
      throw err;
    }
  } else {
    const { startCloudMcp } = await import('./mcp-cloud');
    await startCloudMcp();
  }
}

main().catch((err) => {
  process.stderr.write(`[mcp] Fatal: ${err}\n`);
  process.exit(1);
});
