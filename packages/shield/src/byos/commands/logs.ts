import { parseArgs } from '../../lib/flags';
import { fail, success, EXIT, isJsonMode } from '../../lib/output';
import { registerCommand, showCommandHelp } from '../../lib/help';
import { engineCall, streamEngineOutput } from '../../lib/engine-client';

registerCommand({
  name: 'logs',
  summary: 'Stream service logs',
  usage: 'ellul logs [service] [--follow] [--lines=N]',
  flags: [
    { name: 'follow', description: 'Stream logs continuously' },
    { name: 'lines', description: 'Number of lines to show', valueHint: 'count' },
  ],
  examples: ['ellul logs', 'ellul logs engine --follow', 'ellul logs caddy --lines=100'],
});

export async function handleLogs(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  if (parsed.has('help')) {
    showCommandHelp('logs');
    process.exit(0);
  }
  const follow = parsed.has('follow');
  const service = parsed.positional[0] || '';
  const lines = parsed.get('lines') ? parseInt(parsed.get('lines')!, 10) : 50;

  if (follow) {
    const stop = streamEngineOutput(
      'logs',
      { service, follow: true },
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
    return;
  }

  let result: { lines?: string[] };
  try {
    result = (await engineCall('logs', { service, lines })) as typeof result;
  } catch (e: unknown) {
    fail(EXIT.NETWORK, 'logs', `Failed to fetch logs: ${e instanceof Error ? e.message : e}`);
  }

  if (isJsonMode()) {
    success({ lines: result.lines });
    return;
  }

  for (const line of result.lines || []) {
    process.stderr.write(line + '\n');
  }
}
