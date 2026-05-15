import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { parseArgs } from '../../lib/flags';
import { info, fail, status, success, EXIT, isJsonMode } from '../../lib/output';
import { registerCommand, showCommandHelp } from '../../lib/help';
import { engineCall } from '../../lib/engine-client';
import { readConfig, setConfigValue, getConfigValue } from '../../lib/byos-config';
import { detectPlatform } from '../vm/platform';

registerCommand({
  name: 'config',
  summary: 'Get or set configuration',
  usage: 'ellul config [key] [value] [--trust-cert]',
  flags: [
    { name: 'trust-cert', description: 'Install Caddy root certificate in host keychain' },
  ],
  examples: [
    'ellul config',
    'ellul config vm.cpus 8',
    'ellul config ai.provider openai',
    'ellul config --trust-cert',
  ],
});

export async function handleConfig(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  if (parsed.has('help')) {
    showCommandHelp('config');
    process.exit(0);
  }

  if (parsed.has('trust-cert')) {
    await trustCert();
    return;
  }

  const key = parsed.positional[0];
  const value = parsed.positional[1];

  if (!key) {
    const config = readConfig();
    if (isJsonMode()) {
      success(config as Record<string, unknown>);
    } else {
      process.stderr.write(JSON.stringify(config, null, 2) + '\n');
    }
    return;
  }

  if (value !== undefined) {
    try {
      await engineCall('config.set', { key, value });
      status('✓', `${key} = ${key.includes('key') ? '***' : value}`);
      success({ key, set: true });
    } catch {
      setConfigValue(key, value);
      status('✓', `${key} = ${key.includes('key') ? '***' : value} (local)`);
      success({ key, set: true, local: true });
    }
    return;
  }

  try {
    const result = (await engineCall('config.get', { key })) as { value: string };
    const v = result.value || '';
    if (isJsonMode()) {
      success({ key, value: v });
    } else {
      process.stdout.write(v + '\n');
    }
  } catch {
    const v = getConfigValue(key) || '';
    if (isJsonMode()) {
      success({ key, value: v, local: true });
    } else {
      process.stdout.write(v + '\n');
    }
  }
}

async function trustCert(): Promise<void> {
  const platform = detectPlatform();
  let certContent: string;

  try {
    if (platform === 'lima') {
      const { limaShell } = await import('../vm/lima');
      certContent = limaShell('cat /etc/caddy/pki/authorities/local/root.crt');
    } else if (platform === 'wsl2') {
      const { wslShell } = await import('../vm/wsl');
      certContent = wslShell('cat /etc/caddy/pki/authorities/local/root.crt');
    } else {
      certContent = fs.readFileSync('/etc/caddy/pki/authorities/local/root.crt', 'utf8');
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('EACCES') || msg.includes('Permission denied')) {
      fail(EXIT.NETWORK, 'config', 'Permission denied reading certificate.', 'Try running with sudo.');
    }
    fail(
      EXIT.NETWORK,
      'config',
      'Could not read Caddy root certificate.',
      'Is the workspace running? Start with: ellul up',
    );
  }

  const tmpCert = path.join(os.tmpdir(), 'ellul-caddy-root.crt');
  fs.writeFileSync(tmpCert, certContent);

  try {
    if (process.platform === 'darwin') {
      info('config', 'Installing certificate into macOS keychain (requires admin)...');
      execFileSync(
        'sudo',
        [
          'security',
          'add-trusted-cert',
          '-d',
          '-r',
          'trustRoot',
          '-k',
          '/Library/Keychains/System.keychain',
          tmpCert,
        ],
        { stdio: 'inherit' },
      );
    } else if (process.platform === 'linux') {
      info('config', 'Installing certificate into system CA store...');
      execFileSync(
        'sudo',
        ['cp', tmpCert, '/usr/local/share/ca-certificates/ellul-caddy.crt'],
        { stdio: 'inherit' },
      );
      execFileSync('sudo', ['update-ca-certificates'], { stdio: 'inherit' });
    } else if (process.platform === 'win32') {
      info('config', 'Installing certificate into Windows certificate store...');
      execFileSync('certutil', ['-addstore', '-f', 'Root', tmpCert], {
        stdio: 'inherit',
      });
    }

    status('✓', 'Certificate trusted');
    success({ trusted: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('ENOENT') || msg.includes('not found')) {
      fail(EXIT.USAGE, 'config', 'Required tool not found.', 'Install security tools for your platform.');
    }
    fail(EXIT.NETWORK, 'config', `Failed to install certificate: ${msg}`, 'You may need to run with elevated privileges.');
  } finally {
    try {
      fs.unlinkSync(tmpCert);
    } catch {}
  }
}
