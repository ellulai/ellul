import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import { parseArgs } from '../../lib/flags';
import { info, fail, status, success, EXIT } from '../../lib/output';
import { registerCommand, showCommandHelp } from '../../lib/help';
import { readConfig, writeConfig } from '../../lib/byos-config';

const AUTH_URL = 'https://ellul.ai/cli/auth';

registerCommand({
  name: 'connect',
  summary: 'Link to ellul.ai cloud account',
  usage: 'ellul connect',
  examples: ['ellul connect'],
});

export async function handleConnect(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  if (parsed.has('help')) {
    showCommandHelp('connect');
    process.exit(0);
  }

  const existingConfig = readConfig();
  if (existingConfig.auth?.token) {
    try {
      const verify = await fetch('https://api.ellul.ai/api/byos/verify-token', {
        headers: { Authorization: `Bearer ${existingConfig.auth.token}` },
      });
      if (verify.ok) {
        status('✓', `Already authenticated as ${existingConfig.auth.email}`);
        success({ email: existingConfig.auth.email, authenticated: true });
        return;
      }
    } catch {}
  }

  const sessionId = crypto.randomBytes(16).toString('hex');
  const authUrlWithSession = `${AUTH_URL}?session=${sessionId}`;

  info('connect', 'Linking to ellul.ai cloud account...');
  info('connect', 'Opening browser for authentication...');

  try {
    if (process.platform === 'darwin') {
      execFileSync('open', [authUrlWithSession], { stdio: 'ignore' });
    } else if (process.platform === 'win32') {
      execFileSync('cmd', ['/c', 'start', authUrlWithSession], { stdio: 'ignore' });
    } else {
      execFileSync('xdg-open', [authUrlWithSession], { stdio: 'ignore' });
    }
  } catch {
    info('connect', `Open this URL in your browser: ${authUrlWithSession}`);
  }

  info('connect', 'Waiting for authentication...');

  const deadline = Date.now() + 300_000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));

    try {
      const res = await fetch(`${AUTH_URL}/poll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: sessionId }),
      });
      if (!res.ok) continue;

      const data = (await res.json()) as {
        status: string;
        token?: string;
        email?: string;
        expiresAt?: string;
      };

      if (data.status === 'authenticated' && data.token) {
        const config = readConfig();
        config.auth = {
          token: data.token,
          email: data.email || '',
          expiresAt: data.expiresAt || new Date(Date.now() + 86400000 * 30).toISOString(),
        };
        writeConfig(config);

        status('✓', `Authenticated as ${data.email}`);
        success({ email: data.email, authenticated: true });
        return;
      }
    } catch {}
  }

  fail(EXIT.AUTH, 'connect', 'Authentication timed out.', 'Try again with: ellul connect');
}
