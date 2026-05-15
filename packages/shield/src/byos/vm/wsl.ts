import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { info, fail, status, EXIT } from '../../lib/output';

const DISTRO_NAME = 'ellul';
const IMAGE_PATH = path.join(
  process.env.HOME || process.env.USERPROFILE || '',
  '.ellul',
  'vm',
  'ellul.tar.gz',
);
const INSTALL_PATH = path.join(process.env.LOCALAPPDATA || '', 'ellul', 'wsl');

export function wslStatus(): 'running' | 'stopped' | 'absent' {
  try {
    const out = execFileSync('wsl', ['--list', '--verbose'], {
      encoding: 'utf16le',
      timeout: 10000,
      stdio: 'pipe',
    });
    for (const line of out.split('\n')) {
      if (line.includes(DISTRO_NAME)) {
        if (line.includes('Running')) return 'running';
        return 'stopped';
      }
    }
    return 'absent';
  } catch {
    return 'absent';
  }
}

export function wslImport(): void {
  try {
    execFileSync('wsl', ['--status'], { encoding: 'utf8', timeout: 10000, stdio: 'pipe' });
  } catch {
    fail(EXIT.USAGE, 'vm', 'WSL2 is not installed.', 'Install with: wsl --install');
  }

  if (!fs.existsSync(IMAGE_PATH)) {
    fail(
      EXIT.USAGE,
      'vm',
      'WSL2 image not found.',
      `Expected: ${IMAGE_PATH}\nRun the installer first.`,
    );
  }

  info('vm', 'Importing WSL2 distro...');
  fs.mkdirSync(INSTALL_PATH, { recursive: true });
  execFileSync('wsl', ['--import', DISTRO_NAME, INSTALL_PATH, IMAGE_PATH], {
    stdio: 'inherit',
    timeout: 300000,
  });
  status('✓', 'WSL2 distro imported');
}

export function wslStart(): void {
  const state = wslStatus();
  if (state === 'absent') wslImport();

  if (state === 'running') {
    status('✓', 'WSL2 distro already running');
    return;
  }

  info('vm', 'Starting WSL2 distro...');
  execFileSync(
    'wsl',
    ['-d', DISTRO_NAME, '--exec', '/usr/local/bin/ellul-engine', '--daemon'],
    { stdio: 'inherit', timeout: 120000 },
  );
  status('✓', 'WSL2 distro started');
}

export function wslStop(): void {
  const state = wslStatus();
  if (state !== 'running') {
    status('·', 'WSL2 distro not running');
    return;
  }
  info('vm', 'Stopping WSL2 distro...');
  execFileSync('wsl', ['--terminate', DISTRO_NAME], { stdio: 'inherit', timeout: 30000 });
  status('✓', 'WSL2 distro stopped');
}

export function wslUnregister(): void {
  try {
    execFileSync('wsl', ['--unregister', DISTRO_NAME], { stdio: 'inherit', timeout: 30000 });
  } catch {}
}

export function wslShell(cmd: string): string {
  return execFileSync('wsl', ['-d', DISTRO_NAME, '--exec', 'bash', '-c', cmd], {
    encoding: 'utf8',
    timeout: 30000,
    stdio: 'pipe',
  }).trim();
}
