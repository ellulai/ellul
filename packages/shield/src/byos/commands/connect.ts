import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import { parseArgs } from '../../lib/flags';
import { info, fail, status, success, EXIT } from '../../lib/output';
import { registerCommand, showCommandHelp } from '../../lib/help';
import { readConfig, writeConfig } from '../../lib/byos-config';

const API_URL = process.env.ELLUL_API_URL || 'https://api.ellul.ai';
const AUTH_URL = 'https://ellul.ai/cli/auth';

registerCommand({
  name: 'connect',
  summary: 'Link to ellul.ai cloud account',
  usage: 'ellul connect [--managed] [--interval=monthly|annual]',
  flags: [
    { name: 'managed', description: 'Upgrade to BYOS Managed tier ($10/mo)' },
    { name: 'interval', description: 'Billing interval (monthly or annual)', valueHint: 'monthly' },
  ],
  examples: ['ellul connect', 'ellul connect --managed', 'ellul connect --managed --interval=annual'],
});

export async function handleConnect(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  if (parsed.has('help')) {
    showCommandHelp('connect');
    process.exit(0);
  }

  const config = readConfig();
  let token = config.auth?.token;
  let email = config.auth?.email;

  if (token) {
    try {
      const verify = await fetch(`${API_URL}/api/byos/verify-token`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!verify.ok) {
        token = undefined;
        email = undefined;
      }
    } catch {
      token = undefined;
      email = undefined;
    }
  }

  if (!token) {
    const result = await runAuthFlow();
    token = result.token;
    email = result.email;
  } else {
    status('✓', `Authenticated as ${email}`);
  }

  if (parsed.has('managed')) {
    await handleManagedUpgrade(token!, parsed.get('interval') || 'monthly');
    return;
  }

  success({ email, authenticated: true });
}

async function runAuthFlow(): Promise<{ token: string; email: string }> {
  const sessionId = crypto.randomBytes(16).toString('hex');
  const authUrlWithSession = `${AUTH_URL}?session=${sessionId}`;

  info('connect', 'Linking to ellul.ai cloud account...');
  info('connect', 'Opening browser for authentication...');

  openBrowser(authUrlWithSession);

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
        return { token: data.token, email: data.email || '' };
      }
    } catch {}
  }

  fail(EXIT.AUTH, 'connect', 'Authentication timed out.', 'Try again with: ellul connect');
}

function openBrowser(url: string): void {
  try {
    if (process.platform === 'darwin') {
      execFileSync('open', [url], { stdio: 'ignore' });
    } else if (process.platform === 'win32') {
      execFileSync('cmd', ['/c', 'start', url], { stdio: 'ignore' });
    } else {
      execFileSync('xdg-open', [url], { stdio: 'ignore' });
    }
  } catch {
    info('connect', `Open this URL in your browser: ${url}`);
  }
}

async function handleManagedUpgrade(token: string, interval: string): Promise<void> {
  if (interval !== 'monthly' && interval !== 'annual') {
    fail(EXIT.USAGE, 'connect', `Invalid interval: ${interval}`, 'Use --interval=monthly or --interval=annual');
  }

  info('connect', 'Checking server status...');

  const verifyRes = await fetch(`${API_URL}/api/byos/verify-token`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!verifyRes.ok) {
    fail(EXIT.AUTH, 'connect', 'Failed to verify server token.', 'Try reconnecting with: ellul connect');
  }

  const verify = (await verifyRes.json()) as {
    valid: boolean;
    serverId?: string;
    product?: string;
  };

  if (!verify.valid || !verify.serverId) {
    fail(EXIT.AUTH, 'connect', 'Invalid server token.', 'Try reconnecting with: ellul connect');
  }

  if (verify.product === 'byos_managed') {
    status('✓', 'Server is already on BYOS Managed tier');
    success({ managed: true, serverId: verify.serverId });
    return;
  }

  info('connect', `Creating checkout for BYOS Managed ($${interval === 'annual' ? '100/yr' : '10/mo'})...`);

  const checkoutRes = await fetch(`${API_URL}/api/byos/managed/cli-checkout`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ interval }),
  });

  if (!checkoutRes.ok) {
    const err = (await checkoutRes.json().catch(() => ({ error: 'Unknown error' }))) as { error: string };
    fail(EXIT.NETWORK, 'connect', `Checkout failed: ${err.error}`);
  }

  const { checkoutUrl } = (await checkoutRes.json()) as { checkoutUrl: string };

  info('connect', 'Opening Stripe checkout in browser...');
  openBrowser(checkoutUrl);
  info('connect', 'Complete payment in browser. Waiting for activation... (Ctrl+C to cancel)');

  const deadline = Date.now() + 300_000;
  let polls = 0;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    polls++;

    if (polls % 10 === 0) {
      const elapsed = Math.round((Date.now() - (deadline - 300_000)) / 1000);
      info('connect', `Still waiting for payment confirmation (${elapsed}s)...`);
    }

    try {
      const pollRes = await fetch(`${API_URL}/api/byos/verify-token`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!pollRes.ok) continue;

      const poll = (await pollRes.json()) as { product?: string };
      if (poll.product === 'byos_managed') {
        status('✓', 'BYOS Managed tier activated');
        info('connect', 'Your server is now accessible at your ellul.ai subdomain');
        success({ managed: true, serverId: verify.serverId, activated: true });
        return;
      }
    } catch {}
  }

  info('connect', 'Activation is still processing. Check your dashboard for status.');
  success({ managed: true, serverId: verify.serverId, pending: true });
}
