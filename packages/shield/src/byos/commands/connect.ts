import { execFileSync } from 'child_process';
import { info, fail, status, success, EXIT, isJsonMode } from '../../lib/output';
import { readConfig, writeConfig } from '../../lib/byos-config';

const AUTH_URL = 'https://ellul.ai/cli/auth';

export async function handleConnect(_args: string[]): Promise<void> {
  info('connect', 'Linking to ellul.ai cloud account...');
  info('connect', 'Opening browser for authentication...');

  try {
    if (process.platform === 'darwin') {
      execFileSync('open', [AUTH_URL], { stdio: 'ignore' });
    } else if (process.platform === 'win32') {
      execFileSync('cmd', ['/c', 'start', AUTH_URL], { stdio: 'ignore' });
    } else {
      execFileSync('xdg-open', [AUTH_URL], { stdio: 'ignore' });
    }
  } catch {
    info('connect', `Open this URL in your browser: ${AUTH_URL}`);
  }

  info('connect', 'Waiting for authentication...');

  const deadline = Date.now() + 300000; // 5 min
  let token = '';
  let email = '';

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));

    try {
      const res = await fetch(`${AUTH_URL}/poll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) continue;
      const data = (await res.json()) as {
        status: string;
        token?: string;
        email?: string;
        expiresAt?: string;
      };

      if (data.status === 'authenticated' && data.token) {
        token = data.token;
        email = data.email || '';

        const config = readConfig();
        config.auth = {
          token,
          email,
          expiresAt: data.expiresAt || new Date(Date.now() + 86400000 * 30).toISOString(),
        };
        writeConfig(config);

        status('✓', `Authenticated as ${email}`);
        success({ email, authenticated: true });
        return;
      }
    } catch {}
  }

  fail(EXIT.AUTH, 'connect', 'Authentication timed out.', 'Try again with: ellul connect');
}
