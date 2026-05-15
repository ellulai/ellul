import { parseArgs } from '../../lib/flags';
import { fail, success, EXIT, isJsonMode } from '../../lib/output';
import { engineCall, streamEngineOutput } from '../../lib/engine-client';

export async function handleLogs(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
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
