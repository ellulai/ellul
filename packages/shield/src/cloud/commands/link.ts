// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Link Command — `ellul link <project-name>`
 *
 * Re-attaches a local workspace to an existing remote sandbox on the VPS.
 * The inverse of `ellul unlink` — restores the local binding without
 * reprovisioning anything on the server.
 *
 * Agent-friendly:
 *   - Idempotent: if already bound to same project, returns success
 *   - --json output with consistent envelope
 *   - --help with examples
 */

import fs from 'fs/promises';
import path from 'path';
import type { ParsedArgs } from '../../lib/flags';
import { fail, success, info, status, EXIT, isJsonMode } from '../../lib/output';
import { showCommandHelp, registerCommand } from '../../lib/help';
import { readProjectJson, requireProxy, type ProjectJson } from '../../lib/context';
import { syncAllInstructionFiles } from '../instructions';

registerCommand({
  name: 'link',
  summary: 'Re-attach workspace to existing remote sandbox',
  usage: 'ellul link <project-name>',
  flags: [],
  examples: [
    'ellul link "My App"',
    'ellul link my-app --json',
  ],
});

export async function linkProject(args: ParsedArgs): Promise<void> {
  if (args.has('help')) {
    showCommandHelp('link');
    process.exit(0);
  }

  const nameArg = args.positional[1];
  if (!nameArg) {
    fail(EXIT.USAGE, 'link', 'No project name provided.', 'Usage: ellul link <project-name>');
  }

  const proxyUrl = requireProxy('link');

  const cwd = process.cwd();
  const ellulDir = path.join(cwd, '.ellul');
  const projectFile = path.join(ellulDir, 'project.json');

  // Idempotent: if already bound to the same project, return success
  const existing = readProjectJson(cwd);
  if (existing) {
    if (existing.projectName === nameArg || existing.projectSlug === nameArg) {
      info('link', `Already bound to "${existing.projectName}" (${existing.projectSlug}).`);
      success({
        projectId: existing.projectId,
        projectSlug: existing.projectSlug,
        projectName: existing.projectName,
        synced: [],
        alreadyExists: true,
      });
      return;
    }
    // Bound to a different project — conflict
    fail(
      EXIT.CONFLICT,
      'link',
      `This directory is already bound to "${existing.projectName}" (${existing.projectSlug}).`,
      'Run `ellul unlink` first to detach.',
    );
  }

  // Query VPS for existing project by display name
  let projectId: string;
  let projectSlug: string;
  let projectDisplayName: string;

  try {
    const res = await fetch(`${proxyUrl}/_auth/projects/lookup?name=${encodeURIComponent(nameArg)}`);

    if (res.status === 404) {
      fail(
        EXIT.USAGE,
        'link',
        `No project found with name "${nameArg}".`,
        `Use \`ellul init "${nameArg}"\` to create a new project.`,
      );
    }

    if (res.status === 401 || res.status === 403) {
      fail(EXIT.AUTH, 'link', `Authentication failed.`, 'Run `ellul login` first.');
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      fail(EXIT.NETWORK, 'link', `Server error: ${body.error ?? res.status}`);
    }

    const data = await res.json() as { id: string; slug: string; displayName: string };
    projectId = data.id;
    projectSlug = data.slug;
    projectDisplayName = data.displayName;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
      fail(EXIT.NETWORK, 'link', 'Auth proxy not reachable.', 'Start with: ellul');
    }
    fail(EXIT.NETWORK, 'link', `Failed to reach auth proxy: ${err instanceof Error ? err.message : err}`);
  }

  // Write .ellul/project.json
  await fs.mkdir(ellulDir, { recursive: true });
  const content: ProjectJson = {
    projectId,
    projectSlug,
    projectName: projectDisplayName,
  };
  await fs.writeFile(projectFile, JSON.stringify(content, null, 2) + '\n');

  // Re-inject agent instruction blocks + .mcp.json
  const synced = await syncAllInstructionFiles(projectDisplayName);

  // Signal running daemon to pick up the new project
  let daemonConnected = false;
  try {
    await fetch(`${proxyUrl}/_internal/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, projectSlug, projectName: projectDisplayName, directory: cwd }),
    });
    daemonConnected = true;
  } catch {
    // Daemon may not support connect yet — not fatal
  }

  if (!isJsonMode()) {
    status('✓', `Bound to "${projectDisplayName}" (${projectSlug})`);
    for (const file of synced) {
      status('✓', `Synced ${file}`);
    }
    if (daemonConnected) status('✓', 'Daemon connected');
    process.stderr.write(
      `\n  Linked. Project "${projectDisplayName}" is ready.\n` +
      `  .ellul/project.json is safe to commit — teammates can clone and connect.\n\n`,
    );
  }

  success({
    projectId,
    projectSlug,
    projectName: projectDisplayName,
    synced,
    alreadyExists: false,
  });
}
