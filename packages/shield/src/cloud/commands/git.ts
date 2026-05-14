// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Git Command — `ellul git <subcommand>`
 *
 * Full git provider support for the CLI Shield, enabling users to
 * connect providers, browse repos, and link/unlink repos without
 * ever opening the web dashboard.
 *
 * Agent-friendly:
 *   - --provider flag to skip interactive picker
 *   - --json on repos and status
 *   - --help per subcommand
 *   - REPL-only commands return structured errors with hints
 *
 * Subcommands:
 *   connect [provider]     Connect GitHub/GitLab/Bitbucket via OAuth
 *   repos [provider]       List repos from connected provider
 *   link [repo]            Link repo to current project
 *   unlink                 Unlink repo from current project
 *   status                 Show linked repo info
 *   disconnect [provider]  Disconnect a git provider
 */

import type { ParsedArgs } from '../../lib/flags';
import { fail, success, info, EXIT, isJsonMode } from '../../lib/output';
import { showCommandHelp, registerCommand } from '../../lib/help';
import { requireProxy as requireProxyCtx, requireProjectJson, prompt } from '../../lib/context';

// NOTE: connect, link, unlink, and disconnect are REPL-only commands.
// They require operator key signatures that only exist in the
// daemon's volatile RAM. Standalone CLI redirects to REPL.

type Provider = 'github' | 'gitlab' | 'bitbucket';
const PROVIDERS: Provider[] = ['github', 'gitlab', 'bitbucket'];
const PROVIDER_LABELS: Record<Provider, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
};

// ── Help Registrations ──

registerCommand({
  name: 'git',
  summary: 'Git provider management',
  usage: 'ellul git <subcommand> [options]',
  flags: [],
  examples: [
    'ellul git repos --provider=github --json',
    'ellul git status --json',
    'ellul git repos --search=myrepo',
  ],
  notes: [
    'Subcommands: connect, repos, link, unlink, status, disconnect',
    'connect/link/unlink/disconnect require the REPL (start `ellul` then type /git-<action>).',
  ],
});

registerCommand({
  name: 'git repos',
  summary: 'List repos from connected provider',
  usage: 'ellul git repos [provider]',
  flags: [
    { name: 'provider', description: 'Provider to list from', valueHint: 'github|gitlab|bitbucket' },
    { name: 'search', description: 'Filter repos by name', valueHint: 'query' },
  ],
  examples: [
    'ellul git repos',
    'ellul git repos --provider=github',
    'ellul git repos --provider=github --search=api --json',
  ],
});

registerCommand({
  name: 'git status',
  summary: 'Show linked repo info',
  usage: 'ellul git status',
  flags: [],
  examples: [
    'ellul git status',
    'ellul git status --json',
  ],
});

registerCommand({
  name: 'git connect',
  summary: 'Connect GitHub/GitLab/Bitbucket via OAuth (REPL only)',
  usage: 'ellul git connect [provider]',
  flags: [],
  examples: [
    '# Requires the interactive daemon:',
    'ellul            # start daemon',
    '/git-connect       # in the REPL',
  ],
  notes: ['Requires operator key — only available in the interactive REPL.'],
});

registerCommand({
  name: 'git link',
  summary: 'Link repo to current project (REPL only)',
  usage: 'ellul git link [repo]',
  flags: [],
  examples: [
    '# Requires the interactive daemon:',
    'ellul            # start daemon',
    '/git-link          # in the REPL',
  ],
  notes: ['Requires operator key — only available in the interactive REPL.'],
});

registerCommand({
  name: 'git unlink',
  summary: 'Unlink repo from current project (REPL only)',
  usage: 'ellul git unlink',
  flags: [],
  examples: [
    '# Requires the interactive daemon:',
    'ellul            # start daemon',
    '/git-unlink        # in the REPL',
  ],
  notes: ['Requires operator key — only available in the interactive REPL.'],
});

registerCommand({
  name: 'git disconnect',
  summary: 'Disconnect a git provider (REPL only)',
  usage: 'ellul git disconnect [provider]',
  flags: [],
  examples: [
    '# Requires the interactive daemon:',
    'ellul            # start daemon',
    '/git-disconnect    # in the REPL',
  ],
  notes: ['Requires operator key — only available in the interactive REPL.'],
});

// ── Helpers ──

async function proxyFetch(proxyUrl: string, method: string, urlPath: string, body?: Record<string, unknown>): Promise<{ status: number; data: Record<string, unknown> }> {
  try {
    const res = await fetch(`${proxyUrl}${urlPath}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as Record<string, unknown>;
    return { status: res.status, data };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
      fail(EXIT.NETWORK, 'git', 'Auth proxy not reachable.', 'Start with: ellul');
    }
    fail(EXIT.NETWORK, 'git', `Failed to reach auth proxy: ${err instanceof Error ? err.message : err}`);
  }
}

async function pickProvider(proxyUrl: string, providerFlag?: string, promptText?: string): Promise<{ provider: Provider; connections: Array<Record<string, unknown>> }> {
  const { data } = await proxyFetch(proxyUrl, 'GET', '/_auth/bridge/git-connections');
  const connections = (data.connections ?? []) as Array<Record<string, unknown>>;

  if (connections.length === 0) {
    fail(EXIT.USAGE, 'git', 'No providers connected.', 'Run `ellul git connect` first (requires REPL).');
  }

  // --provider flag: direct selection
  if (providerFlag) {
    const normalized = providerFlag.toLowerCase() as Provider;
    if (!PROVIDERS.includes(normalized)) {
      fail(EXIT.USAGE, 'git', `Invalid provider: "${providerFlag}".`, 'Must be one of: github, gitlab, bitbucket.');
    }
    const match = connections.find((c) => c.provider === normalized);
    if (!match) {
      fail(EXIT.USAGE, 'git', `Provider "${providerFlag}" is not connected.`, 'Run `ellul git connect` first (requires REPL).');
    }
    return { provider: normalized, connections };
  }

  // Single provider: auto-select
  if (connections.length === 1) {
    return { provider: connections[0].provider as Provider, connections };
  }

  // Interactive picker
  process.stderr.write(`\n  ${promptText || 'Select a provider'}:\n\n`);
  connections.forEach((c, i) => {
    process.stderr.write(`  ${i + 1}) ${PROVIDER_LABELS[c.provider as Provider] || c.provider} (${c.providerUsername})\n`);
  });
  process.stderr.write('\n');

  const choice = await prompt('  Choice: ');
  const idx = parseInt(choice, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= connections.length) {
    fail(EXIT.USAGE, 'git', 'Invalid choice.');
  }

  return { provider: connections[idx]!.provider as Provider, connections };
}

// ── Subcommands ──

function operatorOnlyMessage(action: string, args: ParsedArgs): never {
  if (args.has('help')) {
    showCommandHelp(`git ${action}`);
    process.exit(0);
  }
  fail(
    EXIT.USAGE,
    'git',
    `${action} requires the operator key (only available in the interactive daemon).`,
    `Use the REPL command instead: start \`ellul\` then type /git-${action.toLowerCase()}`,
  );
}

async function reposCommand(args: ParsedArgs): Promise<void> {
  if (args.has('help')) {
    showCommandHelp('git repos');
    process.exit(0);
  }

  const proxyUrl = requireProxyCtx('git');
  const search = args.get('search') || '';
  const providerFlag = args.get('provider') || args.positional[2]; // ellul git repos [provider]

  const { provider } = await pickProvider(proxyUrl, providerFlag, 'List repos from');

  const qs = search ? `&search=${encodeURIComponent(search)}` : '';
  const { status: httpStatus, data } = await proxyFetch(proxyUrl, 'GET', `/_auth/bridge/git-repos?provider=${provider}${qs}`);

  if (httpStatus === 401 || httpStatus === 403) {
    fail(EXIT.AUTH, 'git', 'Authentication failed.', 'Run `ellul login` first.');
  }

  if (httpStatus >= 400) {
    fail(EXIT.NETWORK, 'git', `Failed to list repos: ${data.error}`);
  }

  const repos = (data.repos ?? []) as Array<Record<string, unknown>>;

  if (isJsonMode()) {
    success({
      provider,
      repos: repos.map((r) => ({
        name: r.fullName || r.name,
        isPrivate: r.isPrivate,
        url: r.url,
      })),
      count: repos.length,
    });
    return;
  }

  if (repos.length === 0) {
    if (!isJsonMode()) process.stderr.write('[git] No repos found.\n');
    success({ provider, repos: [], count: 0 });
    return;
  }

  process.stderr.write(`\n  Repos from ${PROVIDER_LABELS[provider]}:\n\n`);
  repos.forEach((r, i) => {
    const visibility = r.isPrivate ? '\x1b[33mprivate\x1b[0m' : '\x1b[32mpublic\x1b[0m';
    process.stderr.write(`  ${String(i + 1).padStart(3)}) ${r.fullName || r.name} (${visibility})\n`);
  });
  process.stderr.write('\n');

  success({
    provider,
    repos: repos.map((r) => ({
      name: r.fullName || r.name,
      isPrivate: r.isPrivate,
      url: r.url,
    })),
    count: repos.length,
  });
}

async function statusCommand(args: ParsedArgs): Promise<void> {
  if (args.has('help')) {
    showCommandHelp('git status');
    process.exit(0);
  }

  const proxyUrl = requireProxyCtx('git');
  const project = requireProjectJson('git');

  const { status: httpStatus, data } = await proxyFetch(proxyUrl, 'GET', '/_auth/bridge/git-links');

  if (httpStatus === 401 || httpStatus === 403) {
    fail(EXIT.AUTH, 'git', 'Authentication failed.', 'Run `ellul login` first.');
  }

  if (httpStatus >= 400) {
    fail(EXIT.NETWORK, 'git', `Failed to check links: ${data.error}`);
  }

  const links = (data.links ?? []) as Array<Record<string, unknown>>;
  const current = links.find((l) => l.appName === project.projectName);

  if (!current) {
    if (isJsonMode()) {
      success({ linked: false, project: project.projectName });
    } else {
      process.stderr.write('\n  No repo linked to this project.\n');
      process.stderr.write('  Run `ellul git link` to link a repo.\n\n');
    }
    return;
  }

  const result = {
    linked: true,
    project: project.projectName,
    provider: current.provider,
    providerLabel: PROVIDER_LABELS[current.provider as Provider] || current.provider,
    repo: current.repoFullName,
    branch: current.defaultBranch || 'main',
    linkedAt: current.linkedAt || null,
  };

  if (!isJsonMode()) {
    process.stderr.write(
      `\n  \x1b[2mproject\x1b[0m   ${project.projectName}\n` +
      `  \x1b[2mprovider\x1b[0m  ${result.providerLabel}\n` +
      `  \x1b[2mrepo\x1b[0m      ${result.repo}\n` +
      `  \x1b[2mbranch\x1b[0m    ${result.branch}\n` +
      `  \x1b[2mlinked\x1b[0m    ${current.linkedAt ? new Date(current.linkedAt as string | number).toLocaleString() : 'unknown'}\n\n`,
    );
  }

  success(result);
}

// ── Main Entry ──

export async function gitCommand(args: ParsedArgs): Promise<void> {
  const subcommand = args.positional[1];

  if (args.has('help') && !subcommand) {
    showCommandHelp('git');
    process.exit(0);
  }

  switch (subcommand) {
    case 'connect':
      operatorOnlyMessage('connect', args);
    case 'repos':
      await reposCommand(args);
      break;
    case 'link':
      operatorOnlyMessage('link', args);
    case 'unlink':
      operatorOnlyMessage('unlink', args);
    case 'status':
      await statusCommand(args);
      break;
    case 'disconnect':
      operatorOnlyMessage('disconnect', args);
    default:
      showCommandHelp('git');
      process.exit(EXIT.USAGE);
  }
}
