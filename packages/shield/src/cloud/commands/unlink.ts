// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Unlink Command — `ellul unlink`
 *
 * Local-only eject: removes all ellul middleware from the current
 * workspace without touching VPS data. The remote sandbox spins down
 * but persists — you can `ellul link` back at any time.
 *
 * Agent-friendly:
 *   - Already idempotent (succeeds even if not linked)
 *   - --json output with consistent envelope
 *   - --help with examples
 */

import fs from 'fs/promises';
import path from 'path';
import type { ParsedArgs } from '../../lib/flags';
import { success, isJsonMode } from '../../lib/output';
import { showCommandHelp, registerCommand } from '../../lib/help';
import { readProjectJson, readProxyInfo } from '../../lib/context';
import { removeAllInstructionFiles } from '../instructions';

registerCommand({
  name: 'unlink',
  summary: 'Detach workspace (VPS data preserved)',
  usage: 'ellul unlink',
  flags: [],
  examples: [
    'ellul unlink',
    'ellul unlink --json',
  ],
  notes: [
    'VPS data is untouched. Run `ellul link <name>` to reconnect.',
  ],
});

export interface UnlinkResult {
  projectName: string | null;
  projectSlug: string | null;
  cleaned: string[];
}

/**
 * Core unlink logic — performs cleanup and returns result data.
 * Used by both the `unlink` command and internally by `destroy`.
 * Does NOT emit success() — callers are responsible for that.
 */
export async function unlinkProjectCore(): Promise<UnlinkResult> {
  const cwd = process.cwd();
  const ellulDir = path.join(cwd, '.ellul');
  const projectFile = path.join(ellulDir, 'project.json');

  // Read project identity before removing it
  const project = readProjectJson(cwd);
  const label = project
    ? `${project.projectName} (${project.projectSlug})`
    : 'unbound project';

  if (!isJsonMode()) {
    process.stderr.write(`\n  Unlinking ${label}...\n\n`);
  }

  // 1. Remove managed instruction blocks + .mcp.json entry
  const cleaned = await removeAllInstructionFiles();
  if (!isJsonMode()) {
    for (const file of cleaned) {
      process.stderr.write(`  ✓ Cleaned ${file}\n`);
    }
    if (cleaned.length === 0) {
      process.stderr.write('  · No instruction files found\n');
    }
  }

  // 2. Delete .ellul/project.json
  if (project) {
    try {
      await fs.unlink(projectFile);
      if (!isJsonMode()) process.stderr.write('  ✓ Removed .ellul/project.json\n');

      // Remove .ellul/ dir if now empty
      try {
        await fs.rmdir(ellulDir);
        if (!isJsonMode()) process.stderr.write('  ✓ Removed .ellul/ (empty)\n');
      } catch {
        // Directory not empty — other files exist, leave it
      }
    } catch {
      if (!isJsonMode()) process.stderr.write('  · .ellul/project.json already absent\n');
    }
  }

  // 3. Signal running daemon to disconnect this project (best-effort)
  if (project) {
    const proxy = readProxyInfo();
    if (proxy) {
      try {
        await fetch(`${proxy.url}/_internal/disconnect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId: project.projectId }),
        });
        if (!isJsonMode()) process.stderr.write('  ✓ Daemon notified\n');
      } catch {
        // Daemon not running or doesn't support disconnect — fine
      }
    }
  }

  if (!isJsonMode()) {
    process.stderr.write(
      `\n  Unlinked. VPS data is untouched — run \`ellul link ${project?.projectName || '<name>'}\` to reconnect.\n\n`,
    );
  }

  return {
    projectName: project?.projectName ?? null,
    projectSlug: project?.projectSlug ?? null,
    cleaned,
  };
}

/**
 * CLI entry point for `ellul unlink`.
 * Calls core logic and emits structured success output.
 */
export async function unlinkProject(args: ParsedArgs): Promise<void> {
  if (args.has('help')) {
    showCommandHelp('unlink');
    process.exit(0);
  }

  const result = await unlinkProjectCore();
  success({ ...result });
}
