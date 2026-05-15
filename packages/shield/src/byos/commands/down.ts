import { parseArgs } from '../../lib/flags';
import { info, status, success } from '../../lib/output';
import { registerCommand, showCommandHelp } from '../../lib/help';
import { detectPlatform } from '../vm/platform';

registerCommand({
  name: 'down',
  summary: 'Stop workspace (vault persists)',
  usage: 'ellul down',
  examples: ['ellul down'],
});

export async function handleDown(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  if (parsed.has('help')) {
    showCommandHelp('down');
    process.exit(0);
  }

  const platform = detectPlatform();

  info('down', 'Stopping workspace...');

  if (platform === 'lima') {
    const { limaStop } = await import('../vm/lima');
    try {
      limaStop();
      status('✓', 'VM stopped');
    } catch {
      status('·', 'VM was not running');
    }
  } else if (platform === 'wsl2') {
    const { wslStop } = await import('../vm/wsl');
    try {
      wslStop();
      status('✓', 'WSL2 distro stopped');
    } catch {
      status('·', 'Distro was not running');
    }
  } else {
    const { execFileSync } = await import('child_process');
    try {
      execFileSync('systemctl', ['stop', 'ellul-engine'], {
        stdio: 'inherit',
        timeout: 30000,
      });
      status('✓', 'Engine stopped');
    } catch {
      status('·', 'Engine was not running');
    }
  }

  success({ status: 'stopped' });
  info('down', 'Workspace stopped. Vault persists. Resume with: ellul up');
}
