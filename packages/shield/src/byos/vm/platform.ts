import { execFileSync } from 'child_process';

export type VmPlatform = 'lima' | 'wsl2' | 'native';

export function detectPlatform(): VmPlatform {
  if (process.platform === 'darwin') return 'lima';
  if (process.platform === 'win32') return 'wsl2';
  return 'native';
}

export function isLimaInstalled(): boolean {
  try {
    execFileSync('limactl', ['--version'], { encoding: 'utf8', timeout: 5000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export function limaInstanceExists(): boolean {
  try {
    const out = execFileSync('limactl', ['list', '--json'], { encoding: 'utf8', timeout: 5000, stdio: 'pipe' });
    const instances = JSON.parse(out) as Array<{ name: string }>;
    return instances.some((i) => i.name === 'ellul');
  } catch {
    return false;
  }
}

export function isWslInstalled(): boolean {
  try {
    execFileSync('wsl', ['--status'], { encoding: 'utf8', timeout: 10000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export function wslDistroExists(): boolean {
  try {
    const out = execFileSync('wsl', ['--list', '--quiet'], { encoding: 'utf16le', timeout: 10000, stdio: 'pipe' });
    return out.split('\n').map((l) => l.trim()).includes('ellul');
  } catch {
    return false;
  }
}
