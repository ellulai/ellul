import { info, status, success } from '../../lib/output';
import { detectPlatform } from '../vm/platform';

export async function handleDown(_args: string[]): Promise<void> {
  const platform = detectPlatform();

  info('down', 'Stopping workspace...');

  if (platform === 'lima') {
    const { limaStop } = await import('../vm/lima');
    limaStop();
  } else if (platform === 'wsl2') {
    const { wslStop } = await import('../vm/wsl');
    wslStop();
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
