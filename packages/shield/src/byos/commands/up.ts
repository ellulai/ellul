import { parseArgs } from '../../lib/flags';
import { info, fail, status, success, EXIT } from '../../lib/output';
import { registerCommand, showCommandHelp } from '../../lib/help';
import { isEngineReachable, engineCall, streamEngineOutput } from '../../lib/engine-client';
import { readConfig, writeConfig, ensureConfigDir } from '../../lib/byos-config';
import { detectPlatform } from '../vm/platform';

registerCommand({
  name: 'up',
  summary: 'Start workspace (VM + engine)',
  usage: 'ellul up [--detach]',
  flags: [
    { name: 'detach', description: 'Run in background (no log streaming)' },
  ],
  examples: ['ellul up', 'ellul up --detach'],
});

export async function handleUp(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  if (parsed.has('help')) {
    showCommandHelp('up');
    process.exit(0);
  }
  const detach = parsed.has('detach');
  const platform = detectPlatform();

  info('up', `Platform: ${platform}`);

  ensureConfigDir();
  const config = readConfig();
  if (!config.vm) {
    config.vm = { platform, cpus: 4, memory: '8GiB', disk: '50GiB' };
    writeConfig(config);
    status('✓', 'Created default configuration');
  }

  if (platform === 'lima') {
    const { limaStatus, limaStartSync } = await import('../vm/lima');
    if (limaStatus() === 'running') {
      status('✓', 'VM already running');
    } else {
      limaStartSync();
    }
  } else if (platform === 'wsl2') {
    const { wslStatus, wslStart } = await import('../vm/wsl');
    if (wslStatus() === 'running') {
      status('✓', 'WSL2 distro already running');
    } else {
      wslStart();
    }
  } else {
    const { execFileSync } = await import('child_process');
    try {
      execFileSync('systemctl', ['is-active', '--quiet', 'ellul-engine'], {
        timeout: 5000,
        stdio: 'pipe',
      });
      status('✓', 'Engine already running');
    } catch {
      info('up', 'Starting engine service...');
      try {
        execFileSync('systemctl', ['start', 'ellul-engine'], {
          stdio: 'inherit',
          timeout: 30000,
        });
        status('✓', 'Engine service started');
      } catch {
        fail(
          EXIT.NETWORK,
          'up',
          'Failed to start engine service.',
          'Run the installer: curl -fsSL https://ellul.ai/install | sh',
        );
      }
    }
  }

  info('up', 'Waiting for engine...');
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (isEngineReachable()) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (!isEngineReachable()) {
    fail(EXIT.NETWORK, 'up', 'Engine did not start within 60 seconds.', 'Check logs with: ellul logs engine');
  }

  let result: { uptime: number; services?: Record<string, { active: boolean }> };
  try {
    result = (await engineCall('status')) as typeof result;
  } catch (e: unknown) {
    fail(EXIT.NETWORK, 'up', `Engine reachable but status call failed: ${e instanceof Error ? e.message : e}`);
  }
  status('✓', `Engine running (uptime: ${result.uptime}s)`);

  if (result.services) {
    for (const [name, svc] of Object.entries(result.services)) {
      status(svc.active ? '✓' : '✗', `${name}: ${svc.active ? 'active' : 'inactive'}`);
    }
  }

  if (detach) {
    success({ status: 'running', uptime: result.uptime });
    info('up', 'Workspace running in background. Stop with: ellul down');
    return;
  }

  info('up', 'Workspace ready. Streaming logs (Ctrl+C to stop)...');

  const stop = streamEngineOutput(
    'logs',
    { follow: true },
    (line) => process.stderr.write(line + '\n'),
    () => process.exit(0),
  );

  process.on('SIGINT', () => {
    stop();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    stop();
    process.exit(0);
  });
}
