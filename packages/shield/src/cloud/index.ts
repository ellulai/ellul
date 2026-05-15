#!/usr/bin/env node

// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

// ellul CLI entry. Mode (cloud|local) in .ellul/project.json, set by `ellul init`.
// Dynamic import() per mode avoids pulling sqlite into cloud / shield-proxy into local.

import * as path from 'path';
import { parseArgs, type ParsedArgs } from '../lib/flags';
import { setJsonMode, fail, EXIT } from '../lib/output';
import { showUnifiedHelp, showVersion } from '../lib/help';
import { detectMode, isByosSystem, type ShieldMode } from '../lib/mode';

// ── Re-exports for library consumers ──

export { parseArgs, type ParsedArgs } from '../lib/flags';
export { setJsonMode, isJsonMode, fail, success, info, status, EXIT, type ExitCode } from '../lib/output';
export {
  showUnifiedHelp, showVersion, showCommandHelp,
  registerCommand, type CommandDef, type FlagDef,
} from '../lib/help';
export {
  readProjectJson, requireProjectJson, requireProxy, requireProxyPort,
  readProxyInfo, prompt, type ProjectJson,
} from '../lib/context';
export { detectMode, isByosSystem, type ShieldMode } from '../lib/mode';

// ── Deprecation notice for legacy binary name ──

const _binName = path.basename(process.argv[1] || '');
if (_binName === 'ellul-local') {
  process.stderr.write("[deprecated] 'ellul-local' is now 'ellul'. Use 'ellul' instead.\n");
}

// ── Parse args ──

const parsed = parseArgs(process.argv.slice(2));
const command = parsed.positional[0];

if (parsed.has('json')) setJsonMode(true);

if (parsed.has('version')) {
  showVersion(detectMode());
  process.exit(0);
}

// ── Command classification ──

const CLOUD_ONLY = new Set([
  'link', 'unlink', 'destroy', 'sync', 'git', 'dev', 'build', 'test',
]);

const LOCAL_ONLY = new Set([
  'start', 'stop', 'status', 'rebind', 'secrets', 'gates', 'rules', 'scan',
  'doctor', 'downgrade',
]);

const BYOS_ONLY = new Set([
  'up', 'down', 'ps', 'logs', 'config', 'uninstall',
  'expose', 'connect', 'migrate', 'upgrade',
]);

// ── Helpers ──

function assertMode(mode: ShieldMode, required: 'cloud' | 'local', cmd: string): void {
  if (mode === 'uninitialized') {
    fail(EXIT.USAGE, cmd, 'No project found in this directory.', "Run 'ellul init' to get started.");
  }
  if (mode !== required) {
    const alt = required === 'cloud' ? 'ellul upgrade' : 'ellul downgrade';
    fail(EXIT.USAGE, cmd, `'${cmd}' requires ${required} mode.`, `Switch with: ${alt}`);
  }
}

function assertInitialized(mode: ShieldMode, cmd: string): void {
  if (mode === 'uninitialized') {
    fail(EXIT.USAGE, cmd, 'No project found in this directory.', "Run 'ellul init' to get started.");
  }
}

/**
 * Delegate to the local command handler.
 * Catches missing better-sqlite3 (optionalDependency) with a clear message.
 */
async function runLocal(args: string[]): Promise<void> {
  try {
    const { handleLocalCommand } = await import('../local/commands/index');
    await handleLocalCommand(args);
  } catch (err) {
    if (err instanceof Error && isMissingDep(err)) {
      fail(
        EXIT.USAGE,
        'cli',
        'Local mode requires better-sqlite3 which is not installed.',
        'Install with: npm install better-sqlite3',
      );
    }
    throw err;
  }
}

async function runByos(args: string[]): Promise<void> {
  const { handleByosCommand } = await import('../byos/commands/index');
  await handleByosCommand(args);
}

function isMissingDep(err: Error): boolean {
  const msg = err.message || '';
  return (
    msg.includes("Cannot find module 'better-sqlite3'") ||
    msg.includes("Cannot find package 'better-sqlite3'") ||
    ((err as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND' && msg.includes('better-sqlite3'))
  );
}

// ── Main ──

async function main(): Promise<void> {
  // Help — mode-aware
  if (
    command === 'help' || command === '--help' || command === '-h' ||
    (parsed.has('help') && !command)
  ) {
    showUnifiedHelp(detectMode());
    process.exit(0);
  }

  // ── Init (mode-agnostic — this is where mode gets chosen) ──

  if (command === 'init') {
    const mode = detectMode();
    const explicitMode = parsed.get('mode');

    if (explicitMode === 'byos' || (isByosSystem() && explicitMode !== 'cloud' && explicitMode !== 'local')) {
      await runByos(process.argv.slice(2));
    } else if (explicitMode === 'local' || (mode === 'local' && !explicitMode)) {
      await runLocal(process.argv.slice(2));
    } else {
      const { initProject } = await import('./commands/init');
      await initProject(parsed);
    }
    return;
  }

  // ── Login (works pre-init, cloud-only by nature) ──

  if (command === 'login') {
    const { loginCommand } = await import('./commands/login');
    await loginCommand(parsed);
    return;
  }

  const mode = detectMode();

  // ── BYOS system commands ──

  if (BYOS_ONLY.has(command!)) {
    if (!isByosSystem() && mode !== 'byos') {
      fail(EXIT.USAGE, command!, `'${command}' requires ellul desktop.`, 'Install: curl -fsSL https://ellul.ai/install | sh');
    }
    await runByos(process.argv.slice(2));
    return;
  }

  // ── Cloud-only commands ──

  if (CLOUD_ONLY.has(command!)) {
    assertMode(mode, 'cloud', command!);

    switch (command) {
      case 'link': {
        const { linkProject } = await import('./commands/link');
        await linkProject(parsed);
        break;
      }
      case 'unlink': {
        const { unlinkProject } = await import('./commands/unlink');
        await unlinkProject(parsed);
        break;
      }
      case 'destroy': {
        const { destroyProject } = await import('./commands/destroy');
        await destroyProject(parsed);
        break;
      }
      case 'sync': {
        const { syncCommand } = await import('./commands/sync');
        await syncCommand(parsed);
        break;
      }
      case 'git': {
        const { gitCommand } = await import('./commands/git');
        await gitCommand(parsed);
        break;
      }
      case 'dev':
      case 'build':
      case 'test': {
        const { runSandbox } = await import('./ellul-dev');
        await runSandbox(command, parsed);
        break;
      }
    }
    return;
  }

  // ── Local-only commands ──

  if (LOCAL_ONLY.has(command!)) {
    if (mode === 'byos') {
      await runByos(process.argv.slice(2));
      return;
    }
    assertMode(mode, 'local', command!);
    await runLocal(process.argv.slice(2));
    return;
  }

  // ── Env (dual-mode, different behavior per mode) ──

  if (command === 'env') {
    assertInitialized(mode, 'env');

    if (mode === 'cloud') {
      if (parsed.positional[1] === 'import') {
        const { envImportCommand } = await import('./commands/env-import');
        await envImportCommand(parsed);
      } else {
        const { injectEnv } = await import('../shared/env-inject');
        await injectEnv(parsed);
      }
    } else {
      await runLocal(process.argv.slice(2));
    }
    return;
  }

  // ── Default: start daemon ──

  if (command === undefined || command === '') {
    if (mode === 'uninitialized') {
      if (isByosSystem()) {
        await runByos(['up']);
        return;
      }
      showUnifiedHelp(mode);
      process.exit(EXIT.USAGE);
    }

    if (mode === 'byos') {
      await runByos(['up']);
      return;
    }

    if (mode === 'cloud') {
      const { startProxyDaemon } = await import('./proxy-daemon');
      await startProxyDaemon({
        domain: parsed.get('domain'),
        projectName: parsed.get('project'),
      });
    } else {
      await runLocal(process.argv.slice(2));
    }
    return;
  }

  // ── Unknown command ──

  showUnifiedHelp(detectMode());
  process.exit(EXIT.USAGE);
}

main().catch((err) => {
  fail(EXIT.NETWORK, 'cli', `Fatal error: ${err instanceof Error ? err.message : err}`);
});
