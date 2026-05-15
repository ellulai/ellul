import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { parseArgs } from '../../lib/flags';
import { info, fail, status, success, EXIT } from '../../lib/output';
import { registerCommand, showCommandHelp } from '../../lib/help';
import { engineCall, isEngineReachable } from '../../lib/engine-client';
import { detectPlatform } from '../vm/platform';

registerCommand({
  name: 'upgrade',
  summary: 'Update CLI, services, or VM image',
  usage: 'ellul upgrade [--cli] [--services] [--vm]',
  flags: [
    { name: 'cli', description: 'Update CLI binary only' },
    { name: 'services', description: 'Update engine services only' },
    { name: 'vm', description: 'Update VM image only' },
  ],
  examples: ['ellul upgrade', 'ellul upgrade --cli', 'ellul upgrade --services'],
});

export async function handleUpgrade(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  if (parsed.has('help')) {
    showCommandHelp('upgrade');
    process.exit(0);
  }
  const upgradeCli = parsed.has('cli');
  const upgradeServices = parsed.has('services');
  const upgradeVm = parsed.has('vm');
  const upgradeAll = !upgradeCli && !upgradeServices && !upgradeVm;

  if (upgradeCli || upgradeAll) await upgradeCLI();
  if (upgradeServices || upgradeAll) await upgradeServiceBundle();
  if (upgradeVm || upgradeAll) await upgradeVMImage();

  success({ upgraded: true });
}

async function upgradeCLI(): Promise<void> {
  info('upgrade', 'Checking for CLI updates...');

  const binPath = process.execPath;
  const isNativeExe =
    !binPath.endsWith('node') &&
    !binPath.endsWith('node.exe') &&
    !binPath.endsWith('bun');

  if (!isNativeExe) {
    status('·', 'Running from package manager — update with: npm update -g @ellul.ai/shield');
    return;
  }

  const platform =
    process.platform === 'darwin'
      ? 'darwin'
      : process.platform === 'win32'
        ? 'win'
        : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const binaryName = `ellul-${platform}-${arch}`;
  const cdnBase = 'https://cdn.ellul.ai/cli';

  let expectedHash: string;
  try {
    const res = await fetch(`${cdnBase}/${binaryName}.sha256`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    expectedHash = (await res.text()).trim().split(/\s+/)[0]!;
  } catch (e: unknown) {
    fail(EXIT.NETWORK, 'upgrade', `Failed to check for updates: ${e instanceof Error ? e.message : e}`);
  }

  const currentHash = crypto
    .createHash('sha256')
    .update(fs.readFileSync(binPath))
    .digest('hex');

  if (currentHash === expectedHash) {
    status('✓', 'CLI already up to date');
    return;
  }

  info('upgrade', 'Downloading new CLI binary...');

  const tmpPath = path.join(os.tmpdir(), `ellul-update-${Date.now()}`);
  try {
    const res = await fetch(`${cdnBase}/${binaryName}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(tmpPath, buf);
  } catch (e: unknown) {
    fail(EXIT.NETWORK, 'upgrade', `Download failed: ${e instanceof Error ? e.message : e}`);
  }

  const downloadHash = crypto
    .createHash('sha256')
    .update(fs.readFileSync(tmpPath))
    .digest('hex');

  if (downloadHash !== expectedHash) {
    fs.unlinkSync(tmpPath);
    fail(EXIT.NETWORK, 'upgrade', 'SHA-256 verification failed. Download may be corrupted.');
  }

  try {
    fs.chmodSync(tmpPath, 0o755);
    fs.copyFileSync(tmpPath, binPath);
    fs.unlinkSync(tmpPath);
    status('✓', 'CLI updated');
  } catch (e: unknown) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
    fail(EXIT.NETWORK, 'upgrade', `Failed to replace binary: ${e instanceof Error ? e.message : e}`, 'Try running with sudo.');
  }
}

async function upgradeServiceBundle(): Promise<void> {
  if (!isEngineReachable()) {
    status('·', 'Engine not running — skipping service update');
    return;
  }

  info('upgrade', 'Checking for service updates...');

  try {
    const check = (await engineCall('update.check')) as {
      available: boolean;
      version?: string;
    };

    if (!check.available) {
      status('✓', 'Services up to date');
      return;
    }

    info('upgrade', `New version available: ${check.version}`);
    await engineCall('update.apply', {}, 120000);
    status('✓', 'Services updated');
  } catch (e: unknown) {
    fail(EXIT.NETWORK, 'upgrade', `Service update failed: ${e instanceof Error ? e.message : e}`);
  }
}

async function upgradeVMImage(): Promise<void> {
  const platform = detectPlatform();
  if (platform === 'native') {
    status('·', 'Native Linux — no VM to update');
    return;
  }

  info('upgrade', 'Checking for VM image updates...');

  const cdnBase = 'https://cdn.ellul.ai/vm';
  const imageName =
    platform === 'lima'
      ? `ellul-lima-${process.arch === 'arm64' ? 'arm64' : 'x64'}.tar.gz`
      : 'ellul-wsl2.tar.gz';

  let remoteHash: string;
  try {
    const res = await fetch(`${cdnBase}/${imageName}.sha256`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    remoteHash = (await res.text()).trim().split(/\s+/)[0]!;
  } catch {
    status('·', 'Could not check for VM updates');
    return;
  }

  const localImageDir = path.join(process.env.HOME || '', '.ellul', 'vm');
  const localImagePath = path.join(localImageDir, imageName);

  if (fs.existsSync(localImagePath)) {
    const localHash = crypto
      .createHash('sha256')
      .update(fs.readFileSync(localImagePath))
      .digest('hex');
    if (localHash === remoteHash) {
      status('✓', 'VM image up to date');
      return;
    }
  }

  info('upgrade', 'Downloading new VM image...');
  const tmpPath = path.join(os.tmpdir(), `ellul-vm-update-${Date.now()}`);

  try {
    const res = await fetch(`${cdnBase}/${imageName}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(tmpPath, buf);
  } catch (e: unknown) {
    fail(EXIT.NETWORK, 'upgrade', `VM image download failed: ${e instanceof Error ? e.message : e}`);
  }

  const downloadHash = crypto
    .createHash('sha256')
    .update(fs.readFileSync(tmpPath))
    .digest('hex');

  if (downloadHash !== remoteHash) {
    fs.unlinkSync(tmpPath);
    fail(EXIT.NETWORK, 'upgrade', 'VM image SHA-256 verification failed.');
  }

  info('upgrade', 'Stopping workspace for VM update...');
  const { handleDown } = await import('./down');
  await handleDown([]);

  fs.mkdirSync(localImageDir, { recursive: true });
  fs.copyFileSync(tmpPath, localImagePath);
  fs.unlinkSync(tmpPath);

  if (platform === 'lima') {
    const { limaDelete, limaStartSync } = await import('../vm/lima');
    limaDelete();
    info('upgrade', 'Recreating VM from new image...');
    limaStartSync();
  } else {
    const { wslUnregister, wslStart } = await import('../vm/wsl');
    wslUnregister();
    info('upgrade', 'Reimporting WSL2 distro...');
    wslStart();
  }

  status('✓', 'VM updated');
}
