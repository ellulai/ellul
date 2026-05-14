// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Destroy Command — `ellul destroy <project-name>`
 *
 * Nuclear teardown: permanently deletes the remote sandbox AND unlinks
 * the local workspace. This is irreversible — all VPS data is destroyed:
 *   - Database schemas and data (DROP OWNED BY)
 *   - Secrets and environment variables
 *   - Workspace files and build cache
 *   - Network namespace and firewall rules
 *   - Git credentials and deploy tokens
 *   - Project directory on VPS
 *
 * Safety: requires the developer to type the exact project name as
 * confirmation. No --force flag, no --confirm flag, no shorthand, no undo.
 * Agents cannot destroy projects — this is a human-only operation.
 *
 * Agent-friendly:
 *   - --json output with consistent envelope
 *   - --help with examples
 */

import type { ParsedArgs } from '../../lib/flags';
import { fail, success, info, status, EXIT, isJsonMode } from '../../lib/output';
import { showCommandHelp, registerCommand } from '../../lib/help';
import { readProjectJson, requireProxy, prompt } from '../../lib/context';
import { unlinkProjectCore } from './unlink';

registerCommand({
  name: 'destroy',
  summary: 'Permanently destroy remote sandbox (human-only)',
  usage: 'ellul destroy <project-name>',
  flags: [],
  examples: [
    'ellul destroy my-project',
    'ellul destroy my-project --json',
  ],
  notes: [
    'This action is IRREVERSIBLE. All VPS data will be permanently deleted.',
    'Requires interactive confirmation — agents cannot bypass this.',
  ],
});

export async function destroyProject(args: ParsedArgs): Promise<void> {
  if (args.has('help')) {
    showCommandHelp('destroy');
    process.exit(0);
  }

  const nameArg = args.positional[1];
  if (!nameArg) {
    fail(EXIT.USAGE, 'destroy', 'No project name provided.', 'Usage: ellul destroy <project-name>');
  }

  const proxyUrl = requireProxy('destroy');

  // Resolve project identity — check local binding first, then query VPS
  let projectSlug: string;
  let projectDisplayName: string;

  const existing = readProjectJson();
  if (existing && (existing.projectName === nameArg || existing.projectSlug === nameArg)) {
    projectSlug = existing.projectSlug;
    projectDisplayName = existing.projectName;
  } else {
    const resolved = await lookupProject(proxyUrl, nameArg);
    projectSlug = resolved.slug;
    projectDisplayName = resolved.displayName;
  }

  // Safety confirmation — ALWAYS interactive, no bypass flags.
  // Agents cannot destroy projects. This is deliberate.
  process.stderr.write(
    `\n  DESTRUCTIVE OPERATION\n\n` +
    `  This will permanently destroy "${projectDisplayName}" (${projectSlug}):\n\n` +
    `    - Database schemas and all data\n` +
    `    - Secrets and environment variables\n` +
    `    - Workspace files and build cache\n` +
    `    - Network namespace and firewall rules\n` +
    `    - Git credentials and deploy tokens\n` +
    `    - Project directory on VPS\n\n` +
    `  This action is IRREVERSIBLE.\n\n`,
  );

  const confirmation = await prompt(`  Type "${projectDisplayName}" to confirm: `);
  if (confirmation !== projectDisplayName) {
    process.stderr.write('\n  Aborted. Nothing was destroyed.\n\n');
    if (isJsonMode()) {
      success({ aborted: true, projectName: projectDisplayName });
    }
    return;
  }

  // Send DELETE to VPS via auth proxy
  info('destroy', 'Destroying remote sandbox...');
  let destroyed: string[] = [];

  try {
    const res = await fetch(`${proxyUrl}/_auth/projects/${encodeURIComponent(projectSlug)}`, {
      method: 'DELETE',
    });

    if (res.status === 401 || res.status === 403) {
      fail(EXIT.AUTH, 'destroy', 'Authentication failed.', 'Run `ellul login` first.');
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      fail(EXIT.NETWORK, 'destroy', `Server rejected teardown: ${body.error ?? res.status}`);
    }

    const data = await res.json().catch(() => ({})) as { destroyed?: string[] };
    destroyed = data.destroyed ?? ['Remote sandbox destroyed'];

    if (!isJsonMode()) {
      for (const item of destroyed) {
        status('✓', item);
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
      fail(EXIT.NETWORK, 'destroy', 'Auth proxy not reachable.', 'Start with: ellul');
    }
    fail(EXIT.NETWORK, 'destroy', `Failed to reach VPS: ${err instanceof Error ? err.message : err}`);
  }

  // Run local unlink as final cleanup (core function — no duplicate success() emission)
  info('destroy', 'Cleaning up local workspace...');
  const unlinkResult = await unlinkProjectCore();

  if (!isJsonMode()) {
    process.stderr.write(`  "${projectDisplayName}" has been permanently destroyed.\n\n`);
  }

  success({
    projectName: projectDisplayName,
    projectSlug,
    destroyed,
    cleaned: unlinkResult.cleaned,
    aborted: false,
  });
}

async function lookupProject(
  proxyUrl: string,
  name: string,
): Promise<{ slug: string; displayName: string }> {
  try {
    const res = await fetch(`${proxyUrl}/_auth/projects/lookup?name=${encodeURIComponent(name)}`);

    if (res.status === 404) {
      fail(
        EXIT.USAGE,
        'destroy',
        `No project found with name "${name}".`,
        'Cannot destroy what doesn\'t exist.',
      );
    }

    if (res.status === 401 || res.status === 403) {
      fail(EXIT.AUTH, 'destroy', 'Authentication failed.', 'Run `ellul login` first.');
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      fail(EXIT.NETWORK, 'destroy', `Server error: ${body.error ?? res.status}`);
    }

    return await res.json() as { slug: string; displayName: string };
  } catch (err) {
    fail(EXIT.NETWORK, 'destroy', `Failed to reach auth proxy: ${err instanceof Error ? err.message : err}`);
  }
}
