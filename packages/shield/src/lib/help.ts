// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Help Registry — each command registers metadata, renderer produces consistent output.
 *
 * Format:
 *
 *   ellul init — Bind workspace to a VPS project
 *
 *   Usage:
 *     ellul init [name]
 *
 *   Options:
 *     --name=<name>    Project display name (alt to positional)
 *     --json           Output as JSON
 *     --help           Show this help
 *
 *   Examples:
 *     ellul init "My App"
 *     ellul init --name="My App" --json
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { isJsonMode, success } from './output';
import type { ShieldMode } from './mode';

export interface FlagDef {
  name: string;
  description: string;
  valueHint?: string;
}

export interface CommandDef {
  name: string;
  summary: string;
  usage: string;
  flags?: FlagDef[];
  examples?: string[];
  notes?: string[];
}

const registry = new Map<string, CommandDef>();

/** Common flags added to every command's help */
const GLOBAL_FLAGS: FlagDef[] = [
  { name: 'json', description: 'Output result as JSON' },
  { name: 'help', description: 'Show this help' },
];

export function registerCommand(def: CommandDef): void {
  registry.set(def.name, def);
}

export function showCommandHelp(commandName: string): void {
  const def = registry.get(commandName);
  if (!def) {
    process.stderr.write(`No help available for "${commandName}".\n`);
    process.exit(1);
  }
  renderHelp(def);
}

export function showUnifiedHelp(mode?: ShieldMode): void {
  const lines: string[] = [];
  lines.push('ellul — Sovereign development CLI\n');
  lines.push('Usage:');
  lines.push('  ellul [command] [options]\n');

  const showCloud = !mode || mode === 'cloud' || mode === 'uninitialized';
  const showLocal = !mode || mode === 'local' || mode === 'uninitialized';

  if (showCloud && showLocal) {
    lines.push('Getting Started:');
    lines.push('  init [name]             Initialize project (add --mode=local for free tier)');
    lines.push('  login                   Browser passkey login (cloud mode)');
    lines.push('');
  }

  if (showCloud) {
    lines.push(showLocal ? 'Cloud Mode:' : 'Commands:');
    const cmds: [string, string][] = [
      ['(default)', 'Start interactive daemon (proxy + sync + gates)'],
      ['login', 'Browser passkey login'],
      ['init [name]', 'Bind workspace to a VPS project'],
      ['link <name>', 'Re-attach to existing remote sandbox'],
      ['unlink', 'Detach workspace (VPS data preserved)'],
      ['destroy <name>', 'Permanently destroy remote sandbox'],
      ['env', 'Output shell-safe secret exports'],
      ['env import', 'Import .env files into encrypted vault'],
      ['sync', 'Sync agent instruction files'],
      ['git <sub>', 'Git provider management'],
      ['dev|build|test', 'Run in sovereign sandbox'],
    ];
    const maxLen = Math.max(...cmds.map(([n]) => n.length));
    for (const [name, desc] of cmds) {
      lines.push(`  ${name.padEnd(maxLen + 2)}${desc}`);
    }
    lines.push('');
  }

  if (showLocal) {
    lines.push(showCloud ? 'Local Mode:' : 'Commands:');
    const cmds: [string, string][] = [
      ['(default)', 'Start daemon with interactive REPL'],
      ['init [name]', 'Initialize project in current directory'],
      ['start --detach', 'Start daemon in background'],
      ['stop', 'Stop running daemon'],
      ['status', 'Show daemon and project status'],
      ['secrets <sub>', 'Manage secrets (set|list|import|reveal|delete)'],
      ['gates <sub>', 'Manage gates (status|approve|deny)'],
      ['rules <sub>', 'Manage guardrail rules (list|add|proposals|approve|deny)'],
      ['scan', 'Run guardrail scan on current workspace'],
      ['doctor', 'Run health diagnostics'],
      ['env', 'Print eval-able socket/proxy URL'],
      ['rebind', 'Rebind workspace after moving directory'],
    ];
    const maxLen = Math.max(...cmds.map(([n]) => n.length));
    for (const [name, desc] of cmds) {
      lines.push(`  ${name.padEnd(maxLen + 2)}${desc}`);
    }
    lines.push('');
  }

  lines.push('Global Options:');
  lines.push('  --json       Output as JSON');
  lines.push('  --version    Show version');
  lines.push('  --help       Show this help');
  lines.push('');

  if (mode === 'uninitialized') {
    lines.push('Get started:');
    lines.push('  ellul init "My App"               # Cloud mode (requires account)');
    lines.push('  ellul init "My App" --mode=local   # Local mode (free, no account)');
  } else {
    lines.push('Examples:');
    if (showCloud) {
      lines.push('  ellul init "My App"');
      lines.push('  ellul env --json');
      lines.push('  eval $(ellul env)');
    }
    if (showLocal) {
      lines.push('  ellul init "My App" --mode=local');
      lines.push('  ellul secrets set DATABASE_URL "postgres://..."');
      lines.push('  ellul gates approve test');
    }
  }
  lines.push('');

  process.stderr.write(lines.join('\n') + '\n');
}

export function showVersion(mode?: ShieldMode): void {
  const version = readVersion();
  const modeStr = mode && mode !== 'uninitialized' ? ` (${mode})` : '';
  if (isJsonMode()) {
    success({ version, ...(mode ? { mode } : {}) });
  } else {
    process.stdout.write(`${version}${modeStr}\n`);
  }
}

declare const __SHIELD_VERSION__: string | undefined;

function readVersion(): string {
  // Injected at build time by tsup define
  if (typeof __SHIELD_VERSION__ === 'string') return __SHIELD_VERSION__;

  // Fallback for dev/test (tsc output)
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const pkgPath = path.resolve(path.dirname(thisFile), '../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function renderHelp(def: CommandDef): void {
  const lines: string[] = [];
  lines.push(`ellul ${def.name} — ${def.summary}\n`);
  lines.push('Usage:');
  lines.push(`  ${def.usage}\n`);

  const allFlags = [...(def.flags ?? []), ...GLOBAL_FLAGS];
  if (allFlags.length > 0) {
    lines.push('Options:');
    const entries = allFlags.map((f) => {
      const label = f.valueHint ? `--${f.name}=<${f.valueHint}>` : `--${f.name}`;
      return [label, f.description] as [string, string];
    });
    const maxLen = Math.max(...entries.map(([l]) => l.length));
    for (const [label, desc] of entries) {
      lines.push(`  ${label.padEnd(maxLen + 2)}${desc}`);
    }
    lines.push('');
  }

  if (def.examples && def.examples.length > 0) {
    lines.push('Examples:');
    for (const ex of def.examples) {
      lines.push(`  ${ex}`);
    }
    lines.push('');
  }

  if (def.notes && def.notes.length > 0) {
    for (const note of def.notes) {
      lines.push(note);
    }
    lines.push('');
  }

  process.stderr.write(lines.join('\n') + '\n');
}
