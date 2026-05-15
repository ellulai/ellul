import * as fs from 'fs';
import * as path from 'path';
import { parseArgs } from '../../lib/flags';
import { info, status, success } from '../../lib/output';
import { registerCommand, showCommandHelp } from '../../lib/help';
import { prompt } from '../../lib/context';
import { isEngineReachable } from '../../lib/engine-client';
import { detectPlatform } from '../vm/platform';

registerCommand({
  name: 'uninstall',
  summary: 'Remove ellul desktop',
  usage: 'ellul uninstall [--purge] [--yes]',
  flags: [
    { name: 'purge', description: 'Also remove vault data (irreversible)' },
    { name: 'yes', description: 'Skip confirmation prompt' },
  ],
  examples: ['ellul uninstall', 'ellul uninstall --purge --yes'],
});

export async function handleUninstall(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  if (parsed.has('help')) {
    showCommandHelp('uninstall');
    process.exit(0);
  }
  const purge = parsed.has('purge');
  const yes = parsed.has('yes');

  if (!yes) {
    const msg = purge
      ? 'This will remove ellul, all VMs, configuration, AND vault data. This cannot be undone.'
      : 'This will remove ellul, all VMs, and configuration. Vault data will be preserved.';

    const answer = await prompt(`${msg}\nContinue? [y/N] `);
    if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
      info('uninstall', 'Cancelled.');
      success({ cancelled: true });
      return;
    }
  }

  if (isEngineReachable()) {
    info('uninstall', 'Stopping workspace...');
    const { handleDown } = await import('./down');
    await handleDown([]);
  }

  const platform = detectPlatform();
  const home = process.env.HOME || '';

  if (platform === 'lima') {
    const { limaStop, limaDelete } = await import('../vm/lima');
    try {
      limaStop();
    } catch {}
    limaDelete();
    status('✓', 'Lima VM removed');
  } else if (platform === 'wsl2') {
    const { wslStop, wslUnregister } = await import('../vm/wsl');
    try {
      wslStop();
    } catch {}
    wslUnregister();
    status('✓', 'WSL2 distro removed');
  }

  const configDir = path.join(home, '.ellul');
  if (fs.existsSync(configDir)) {
    if (purge) {
      fs.rmSync(configDir, { recursive: true, force: true });
      status('✓', 'Configuration and vault removed');
    } else {
      for (const entry of fs.readdirSync(configDir)) {
        if (entry === 'vault' || entry === 'vault-export') continue;
        fs.rmSync(path.join(configDir, entry), { recursive: true, force: true });
      }
      status('✓', 'Configuration removed (vault preserved)');
    }
  }

  const binPath = process.execPath;
  const binDir = path.dirname(binPath);
  const standardPaths = [
    '/usr/local/bin',
    path.join(home, '.local', 'bin'),
    path.join(home, 'bin'),
  ];

  if (standardPaths.some((p) => binDir.startsWith(p))) {
    try {
      fs.unlinkSync(binPath);
      const mcpPath = path.join(binDir, 'ellul-mcp');
      if (fs.existsSync(mcpPath)) fs.unlinkSync(mcpPath);
      status('✓', `Removed ${binPath}`);
    } catch (e: unknown) {
      status('!', `Could not remove ${binPath}: ${e instanceof Error ? e.message : e}. Remove manually.`);
    }
  } else {
    info('uninstall', `CLI at ${binPath} — remove manually if installed via package manager.`);
  }

  info('uninstall', 'Uninstall complete.');
  success({ purged: purge });
}
