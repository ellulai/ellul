import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { info, fail, status, EXIT } from '../../lib/output';

const VM_NAME = 'ellul';
const TEMPLATE_DIR = path.join(process.env.HOME || '~', '.ellul', 'vm');
const TEMPLATE_PATH = path.join(TEMPLATE_DIR, 'lima-template.yaml');

export function limaStatus(): 'running' | 'stopped' | 'absent' {
  try {
    const out = execFileSync('limactl', ['list', '--json'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: 'pipe',
    });
    const instances = JSON.parse(out) as Array<{ name: string; status: string }>;
    const inst = instances.find((i) => i.name === VM_NAME);
    if (!inst) return 'absent';
    return inst.status === 'Running' ? 'running' : 'stopped';
  } catch {
    return 'absent';
  }
}

export function limaCreate(): void {
  try {
    execFileSync('limactl', ['--version'], { encoding: 'utf8', timeout: 5000, stdio: 'pipe' });
  } catch {
    fail(EXIT.USAGE, 'vm', 'Lima is not installed.', 'Install with: brew install lima');
  }

  if (!fs.existsSync(TEMPLATE_PATH)) {
    fail(
      EXIT.USAGE,
      'vm',
      'Lima template not found.',
      `Expected: ${TEMPLATE_PATH}\nRun the installer: curl -fsSL https://ellul.ai/install | sh`,
    );
  }

  info('vm', 'Creating VM from template...');
  execFileSync('limactl', ['create', '--name=' + VM_NAME, '--tty=false', TEMPLATE_PATH], {
    stdio: 'inherit',
    timeout: 300000,
  });
  status('✓', 'VM created');
}

export function limaStartSync(): void {
  const state = limaStatus();
  if (state === 'absent') limaCreate();

  if (state === 'running') {
    status('✓', 'VM already running');
    return;
  }

  info('vm', 'Starting VM...');
  execFileSync('limactl', ['start', VM_NAME], {
    stdio: 'inherit',
    timeout: 300000,
  });
  status('✓', 'VM started');
}

export function limaStop(): void {
  const state = limaStatus();
  if (state !== 'running') {
    status('·', 'VM not running');
    return;
  }
  info('vm', 'Stopping VM...');
  execFileSync('limactl', ['stop', VM_NAME], { stdio: 'inherit', timeout: 120000 });
  status('✓', 'VM stopped');
}

export function limaDelete(): void {
  try {
    execFileSync('limactl', ['delete', '--force', VM_NAME], {
      stdio: 'inherit',
      timeout: 60000,
    });
  } catch {}
}

export function limaShell(cmd: string): string {
  return execFileSync('limactl', ['shell', VM_NAME, '--', 'bash', '-c', cmd], {
    encoding: 'utf8',
    timeout: 30000,
    stdio: 'pipe',
  }).trim();
}
