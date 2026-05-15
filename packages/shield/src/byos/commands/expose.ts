import { parseArgs } from '../../lib/flags';
import { info, fail, status, success, EXIT, isJsonMode } from '../../lib/output';
import { engineCall, isEngineReachable } from '../../lib/engine-client';
import { readConfig, setConfigValue } from '../../lib/byos-config';

export async function handleExpose(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  const subdomain = parsed.get('subdomain') || '';

  if (!isEngineReachable()) {
    fail(EXIT.NETWORK, 'expose', 'Engine not running.', 'Start with: ellul up');
  }

  const config = readConfig();
  const requestedSubdomain = subdomain || config.tunnel?.subdomain || '';

  info('expose', 'Opening relay tunnel...');

  let result: { url: string; subdomain: string };
  try {
    result = (await engineCall('tunnel.open', {
      subdomain: requestedSubdomain,
    })) as typeof result;
  } catch (e: unknown) {
    fail(
      EXIT.NETWORK,
      'expose',
      `Failed to open tunnel: ${e instanceof Error ? e.message : e}`,
      'Check that the relay service is configured.',
    );
  }

  if (result.subdomain && result.subdomain !== config.tunnel?.subdomain) {
    setConfigValue('tunnel.subdomain', result.subdomain);
  }

  if (isJsonMode()) {
    success({ url: result.url, subdomain: result.subdomain });
    return;
  }

  status('✓', `Tunnel open: ${result.url}`);
  info('expose', 'Press Ctrl+C to close the tunnel.');

  process.on('SIGINT', async () => {
    info('expose', 'Closing tunnel...');
    try {
      await engineCall('tunnel.close', {}, 5000);
    } catch {}
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    try {
      await engineCall('tunnel.close', {}, 5000);
    } catch {}
    process.exit(0);
  });

  // Keep alive — engine manages the WebSocket tunnel
  await new Promise<void>(() => {});
}
