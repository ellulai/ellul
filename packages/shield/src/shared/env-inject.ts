// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Environment Injection — `eval $(ellul env)`
 *
 * Reads secrets from the auth proxy and outputs shell-safe export statements.
 * Secrets live in RAM only — never written to disk.
 *
 * Output format:
 *   export DATABASE_URL="postgresql://..."
 *   export STRIPE_SECRET_KEY="sk_test_..."
 *   export ELLUL_PROJECT="my-app"
 *   export ELLUL_PROXY="http://127.0.0.1:12345"
 *
 * Shell-safe escaping: $, `, ", \, ! are escaped to prevent eval injection.
 * Same pattern as Doppler CLI, 1Password CLI, and direnv.
 *
 * Agent-friendly:
 *   - --json outputs consistent envelope: {"ok":true,"data":{"secrets":{...},...}}
 *   - --help with examples
 *
 * Usage:
 *   eval $(ellul env)                 — inject into current shell
 *   eval $(ellul env --project=foo)   — inject for specific project
 *   ellul env --json                  — output as JSON (for non-shell consumers)
 */

import type { ParsedArgs } from '../lib/flags';
import { fail, EXIT, isJsonMode } from '../lib/output';
import { showCommandHelp, registerCommand } from '../lib/help';
import { requireProxy, readProjectJson } from '../lib/context';

/** Valid shell variable name: starts with letter or underscore, alphanumeric + underscore only. */
const ENV_KEY_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Shell-safe escape a value for use inside double quotes.
 * Escapes: $ ` " \ ! (the five dangerous chars in bash double-quoted strings)
 */
export function shellEscape(value: string): string {
  return value
    .replace(/\\/g, '\\\\')   // \ → \\  (must be first)
    .replace(/"/g, '\\"')      // " → \"
    .replace(/\$/g, '\\$')    // $ → \$
    .replace(/`/g, '\\`')     // ` → \`
    .replace(/!/g, '\\!')     // ! → \!  (bash history expansion)
}

registerCommand({
  name: 'env',
  summary: 'Output shell-safe secret exports',
  usage: 'ellul env [options]',
  flags: [
    { name: 'project', description: 'Project name override', valueHint: 'name' },
    { name: 'env', description: 'Target environment (default: production)', valueHint: 'production|development' },
  ],
  examples: [
    'eval $(ellul env)',
    'eval $(ellul env --project=foo)',
    'ellul env --json',
    'ellul env --env=development --json',
  ],
});

export async function injectEnv(args: ParsedArgs): Promise<void> {
  if (args.has('help')) {
    showCommandHelp('env');
    process.exit(0);
  }

  const proxyUrl = requireProxy('env');

  // Read project config from .ellul/project.json (local state, not global config)
  let projectName = args.get('project');
  if (!projectName) {
    const project = readProjectJson();
    if (project) projectName = project.projectName;
  }

  if (!projectName) {
    fail(EXIT.USAGE, 'env', 'No project found.', 'Run `ellul init` in this directory, or use --project=NAME.');
  }

  const env = (args.get('env') as 'production' | 'development') || 'production';

  // Fetch secrets from auth proxy
  const url = `${proxyUrl}/_auth/secrets/values?app=${encodeURIComponent(projectName)}&env=${encodeURIComponent(env)}`;
  let secrets: Record<string, string>;

  try {
    const response = await fetch(url);

    if (response.status === 401 || response.status === 403) {
      fail(EXIT.AUTH, 'env', 'Authentication failed.', 'Run `ellul login` first.');
    }

    if (!response.ok) {
      const body = await response.text();
      fail(EXIT.NETWORK, 'env', `Failed to fetch secrets: ${response.status} ${body}`);
    }

    const data = await response.json() as { values: Record<string, string> };
    secrets = data.values;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
      fail(EXIT.NETWORK, 'env', 'Auth proxy not reachable.', 'Start with: ellul');
    }
    fail(EXIT.NETWORK, 'env', `Failed to connect to auth proxy: ${err instanceof Error ? err.message : err}`);
  }

  if (isJsonMode()) {
    // Structured JSON envelope
    process.stdout.write(JSON.stringify({
      ok: true,
      data: {
        secrets,
        count: Object.keys(secrets).length,
        project: projectName,
        env,
      },
    }, null, 2) + '\n');
    return;
  }

  // Output shell-safe export statements
  for (const [key, value] of Object.entries(secrets)) {
    // Validate key name to prevent shell injection via malicious key names.
    if (!ENV_KEY_REGEX.test(key)) {
      process.stderr.write(`[env] Skipping invalid key name: ${key}\n`);
      continue;
    }
    process.stdout.write(`export ${key}="${shellEscape(value)}"\n`);
  }

  // Always include meta variables
  process.stdout.write(`export ELLUL_PROJECT="${shellEscape(projectName)}"\n`);
  process.stdout.write(`export ELLUL_PROXY="${shellEscape(proxyUrl)}"\n`);

  process.stderr.write(`[env] Injected ${Object.keys(secrets).length} secrets for "${projectName}" (${env})\n`);
}
