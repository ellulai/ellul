import { parseArgs } from '../../lib/flags';
import { info, fail, status, success, EXIT, isJsonMode } from '../../lib/output';
import { registerCommand, showCommandHelp } from '../../lib/help';
import { isEngineReachable } from '../../lib/engine-client';
import { readConfig, setConfigValue } from '../../lib/byos-config';
import { TunnelClient } from '../../tunnel/client';

registerCommand({
  name: 'expose',
  summary: 'Open relay tunnel to public URL',
  usage: 'ellul expose [--subdomain=NAME]',
  flags: [
    { name: 'subdomain', description: 'Requested tunnel subdomain', valueHint: 'name' },
  ],
  examples: ['ellul expose', 'ellul expose --subdomain=myapp'],
});

const RELAY_URL = process.env.ELLUL_RELAY_URL || 'wss://relay.ellul.ai';

export async function handleExpose(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  if (parsed.has('help')) {
    showCommandHelp('expose');
    process.exit(0);
  }

  if (!isEngineReachable()) {
    fail(EXIT.NETWORK, 'expose', 'Engine not running.', 'Start with: ellul up');
  }

  const config = readConfig();
  const token = config?.auth?.token;
  if (!token) {
    fail(EXIT.AUTH, 'expose', 'Not connected.', 'Run: ellul connect');
  }

  const subdomain = parsed.get('subdomain') || config?.tunnel?.subdomain || undefined;

  info('expose', 'Connecting to relay...');

  const client = new TunnelClient(
    RELAY_URL,
    token!,
    443,
    subdomain,
    (msg) => { if (!isJsonMode()) status('·', msg); },
  );

  try {
    const assignedSub = await client.connect();
    const url = `https://${assignedSub}.ellul.app`;

    if (assignedSub !== config?.tunnel?.subdomain) {
      setConfigValue('tunnel.subdomain', assignedSub);
    }

    if (isJsonMode()) {
      success({ url, subdomain: assignedSub });
    } else {
      status('✓', 'Connected');
      console.log();
      console.log(`  ${url}`);
      console.log();
    }

    let statsInterval: NodeJS.Timeout | undefined;
    if (!isJsonMode()) {
      statsInterval = setInterval(() => {
        const s = client.getStats();
        process.stderr.write(
          `\r  Requests ${s.requests}  ` +
          `Bytes ↑ ${fmtBytes(s.bytesUp)}  ↓ ${fmtBytes(s.bytesDown)}  ` +
          `Uptime ${fmtDuration(s.uptime)}   `,
        );
      }, 30_000);
    }

    const cleanup = () => {
      if (statsInterval) clearInterval(statsInterval);
      client.close();
      if (!isJsonMode()) {
        process.stderr.write('\n');
        info('expose', 'Tunnel closed');
      }
      process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    await new Promise<void>(() => {});
  } catch (err) {
    client.close();
    fail(EXIT.NETWORK, 'expose', `Failed to connect: ${err instanceof Error ? err.message : err}`);
  }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(1)} GB`;
}

function fmtDuration(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
