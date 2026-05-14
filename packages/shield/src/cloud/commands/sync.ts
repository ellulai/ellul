// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Sync Command — `ellul sync`
 *
 * Re-generates managed instruction blocks in all agent config files
 * and updates .mcp.json. Reads the project name from .ellul/project.json
 * in the current working directory.
 *
 * Agent-friendly:
 *   - Already idempotent (regenerates all files)
 *   - --json output with consistent envelope
 *   - --help with examples
 */

import type { ParsedArgs } from '../../lib/flags';
import { success, info, EXIT, isJsonMode } from '../../lib/output';
import { showCommandHelp, registerCommand } from '../../lib/help';
import { requireProjectJson } from '../../lib/context';
import { syncAllInstructionFiles } from '../instructions';

registerCommand({
  name: 'sync',
  summary: 'Sync agent instruction files',
  usage: 'ellul sync',
  flags: [],
  examples: [
    'ellul sync',
    'ellul sync --json',
  ],
});

export async function syncCommand(args: ParsedArgs): Promise<void> {
  if (args.has('help')) {
    showCommandHelp('sync');
    process.exit(0);
  }

  const project = requireProjectJson('sync');
  const files = await syncAllInstructionFiles(project.projectName);

  if (!isJsonMode()) {
    info('sync', `Updated ${files.length} files for project "${project.projectName}":`);
    for (const file of files) {
      process.stderr.write(`  - ${file}\n`);
    }
    process.stderr.write('\n');
  }

  success({
    projectName: project.projectName,
    files,
  });
}
