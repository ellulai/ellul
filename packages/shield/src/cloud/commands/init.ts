// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Init Command — `ellul init`
 *
 * Provisions a project on the VPS and writes identity to .ellul/project.json
 * in the current working directory. This is the Local State architecture:
 * project identity lives inside the repo (like .git/ or .vercel/), not in
 * a global config file that breaks when the folder is renamed.
 *
 * Identity model:
 *   slug = immutable directory name on VPS (e.g. "sbx-k8m2xpq"), auto-generated
 *   displayName = mutable user-facing name, stored in ellul.json on VPS
 *
 * .ellul/project.json contains NO secrets — just the immutable projectId,
 * projectSlug, and displayName. Safe and recommended to commit to Git so
 * teammates can clone and connect instantly.
 *
 * Agent-friendly:
 *   - Idempotent: re-running returns existing project data (exit 0)
 *   - --json output with consistent envelope
 *   - --name flag as alternative to positional arg
 *   - --help with examples
 */

import fs from 'fs/promises';
import path from 'path';
import type { ParsedArgs } from '../../lib/flags';
import { fail, success, info, status, EXIT, isJsonMode } from '../../lib/output';
import { showCommandHelp, registerCommand } from '../../lib/help';
import { readProjectJson, requireProxy, prompt, type ProjectJson } from '../../lib/context';
import { syncAllInstructionFiles } from '../instructions';

registerCommand({
  name: 'init',
  summary: 'Bind workspace to a VPS project',
  usage: 'ellul init [name]',
  flags: [
    { name: 'name', description: 'Project display name (alternative to positional arg)', valueHint: 'name' },
  ],
  examples: [
    'ellul init "My App"',
    'ellul init --name="My App" --json',
    'ellul init                          # interactive prompt',
  ],
});

export async function initProject(args: ParsedArgs): Promise<void> {
  if (args.has('help')) {
    showCommandHelp('init');
    process.exit(0);
  }

  const proxyUrl = requireProxy('init');

  const cwd = process.cwd();
  const ellulDir = path.join(cwd, '.ellul');
  const projectFile = path.join(ellulDir, 'project.json');

  // Idempotent: if already initialised, return existing data as success
  const existing = readProjectJson(cwd);
  if (existing) {
    const requestedName = args.positional[1] || args.get('name');
    // Conflict: different name explicitly requested
    if (requestedName && requestedName !== existing.projectName) {
      fail(
        EXIT.CONFLICT,
        'init',
        `This directory is already bound to project "${existing.projectName}" (${existing.projectSlug}).`,
        'Run `ellul unlink` first to detach, then `ellul init` to rebind.',
      );
    }
    // Same or no name — idempotent success
    info('init', `Already initialised as "${existing.projectName}" (${existing.projectSlug}).`);
    success({
      projectId: existing.projectId,
      projectSlug: existing.projectSlug,
      projectName: existing.projectName,
      synced: [],
      alreadyExists: true,
    });
    return;
  }

  // Resolve display name: --name flag > positional arg > interactive prompt
  let displayName = args.get('name') || args.positional[1];

  if (!displayName) {
    displayName = await prompt('Project name: ');
    if (!displayName) {
      fail(EXIT.USAGE, 'init', 'No project name provided.', 'Usage: ellul init "My App"');
    }
  }

  if (displayName.length > 64) {
    fail(EXIT.USAGE, 'init', 'Name too long (max 64 characters).');
  }

  // Provision on VPS via auth proxy — server generates the slug
  let projectId: string;
  let projectSlug: string;
  let projectDisplayName: string;
  try {
    const res = await fetch(`${proxyUrl}/_auth/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName }),
    });

    if (res.status === 401 || res.status === 403) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      fail(EXIT.AUTH, 'init', `Authentication failed: ${body.error ?? res.status}`, 'Run `ellul login` first.');
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      fail(EXIT.NETWORK, 'init', `Server rejected project: ${body.error ?? res.status}`);
    }

    const data = await res.json() as { id: string; slug: string; displayName: string };
    projectId = data.id;
    projectSlug = data.slug;
    projectDisplayName = data.displayName;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
      fail(EXIT.NETWORK, 'init', 'Auth proxy not reachable.', 'Start with: ellul');
    }
    fail(EXIT.NETWORK, 'init', `Failed to reach auth proxy: ${err instanceof Error ? err.message : err}`);
  }

  // Write .ellul/project.json
  await fs.mkdir(ellulDir, { recursive: true });
  const content: ProjectJson = {
    mode: 'cloud',
    projectId,
    projectSlug,
    projectName: projectDisplayName,
  };
  await fs.writeFile(projectFile, JSON.stringify(content, null, 2) + '\n');

  // Sync instruction files into the project directory
  const synced = await syncAllInstructionFiles(projectDisplayName);

  // Output
  if (!isJsonMode()) {
    const syncedList = synced.map((f) => `    - ${f}`).join('\n');
    process.stderr.write(
      `\n  Project provisioned.\n\n` +
      `  name : ${projectDisplayName}\n` +
      `  slug : ${projectSlug}\n` +
      `  id   : ${projectId}\n` +
      `  file : .ellul/project.json\n\n` +
      `  Instruction files synced:\n${syncedList}\n\n` +
      `  .ellul/project.json contains no secrets and is safe to commit to Git.\n` +
      `  Teammates who clone this repo can run \`ellul proxy\` and connect instantly.\n\n`,
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
