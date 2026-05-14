// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * ellul-local downgrade — Repatriate project from VPS to local
 *
 * One-time, client-initiated, cryptographically secure state repatriation.
 * Local daemon generates ML-KEM keypair → VPS encapsulates to it →
 * only the local daemon can decrypt. CLI never touches plaintext.
 *
 * Two-phase archive: VPS stays active until local confirms success via finalize.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as readline from 'readline';

import type { DowngradeReceipt } from '../repatriation/types';

const CONFIG_DIR = path.join(process.env.HOME || '~', '.ellul');
const SOCKET_PATH = path.join(CONFIG_DIR, 'daemon.sock');

function daemonRequest(method: string, urlPath: string, body?: unknown): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (bodyStr) headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
    const req = http.request({ socketPath: SOCKET_PATH, method, path: urlPath, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode || 500, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode || 500, data: { raw: data } }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('Request timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
  });
}

export async function handleDowngrade(): Promise<void> {
  // ── Step 1: Verify daemon running ──
  if (!fs.existsSync(SOCKET_PATH)) {
    process.stderr.write('Error: Daemon not running. Start with: ellul-local\n');
    process.exit(1);
  }

  // ── Step 2: Verify project in VPS mode ──
  const configPath = path.join(process.cwd(), '.ellul', 'config.json');
  let config: Record<string, unknown> = {};
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}

  if (config.mode !== 'vps') {
    process.stderr.write('Error: Project is already in local mode.\n');
    process.stderr.write('Downgrade is only available for projects running on VPS.\n');
    process.exit(1);
  }

  const vpsEndpoint = config.vpsEndpoint as string;
  if (!vpsEndpoint) {
    process.stderr.write('Error: No VPS endpoint in config. Cannot downgrade.\n');
    process.exit(1);
  }

  const projectFile = path.join(process.cwd(), '.ellul', 'project.json');
  const projectConfig = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
  const slug = projectConfig.projectSlug;

  process.stderr.write(`\nPreparing to downgrade project "${projectConfig.projectName || slug}" from VPS...\n\n`);

  // ── Step 3: Authenticate ──
  const apiUrl = process.env.ELLUL_API_URL || 'https://api.ellul.ai';
  let authSession: string | null = null;

  try {
    const { CliHost } = await import('@ellul.ai/shield-proxy/cli-host');
    const host = new CliHost();
    const session = await host.getAuthSession();
    if (session?.sessionId) {
      authSession = session.sessionId;
      process.stderr.write('  Using existing session from keychain.\n');
    }
  } catch {}

  if (!authSession) {
    process.stderr.write('  Opening browser for passkey authentication...\n');
    const { exec } = await import('child_process');
    const openUrl = `${apiUrl}/auth/login?redirect=cli&project=${encodeURIComponent(slug)}`;
    if (process.platform === 'darwin') exec(`open "${openUrl}"`);
    else if (process.platform === 'linux') exec(`xdg-open "${openUrl}"`);

    const sessionInput = await prompt('Paste session token after login: ');
    authSession = sessionInput.trim();
    if (!authSession) {
      process.stderr.write('Error: Authentication required\n');
      process.exit(1);
    }
  }

  // ── Step 4: Obtain scoped downgrade token ──
  process.stderr.write('  Obtaining downgrade token...\n');

  const https = await import('https');
  const tokenResponse = await new Promise<{ status: number; data: unknown }>((resolve, reject) => {
    const bodyStr = JSON.stringify({ projectSlug: slug });
    const url = new URL('/api/downgrade/token', apiUrl);
    const req = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(bodyStr)),
        'Authorization': `Bearer ${authSession}`,
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode || 500, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode || 500, data: { error: data } }); }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });

  if (tokenResponse.status !== 200) {
    const err = tokenResponse.data as { error?: string };
    process.stderr.write(`Error: Failed to obtain downgrade token: ${err.error || 'Unknown'}\n`);
    process.exit(1);
  }

  const tokenData = tokenResponse.data as { downgradeToken: string; downgradeId: string };
  process.stderr.write(`  Token obtained (${tokenData.downgradeId.slice(0, 8)}..., 60s TTL)\n`);

  // ── Step 5: Confirmation ──
  process.stderr.write(`\nDowngrade project "${projectConfig.projectName || slug}" from VPS to local?\n\n`);
  process.stderr.write(`  This will:\n`);
  process.stderr.write(`    Transfer secrets from VPS (encrypted end-to-end)\n`);
  process.stderr.write(`    Transfer custom guardrail rules\n`);
  process.stderr.write(`    Transfer gate policies\n`);
  process.stderr.write(`    Archive VPS project (re-activatable with upgrade)\n\n`);
  process.stderr.write(`  Remote-only state will NOT be transferred:\n`);
  process.stderr.write(`    Database data, deployments, team settings, audit chain\n\n`);

  const answer = await prompt('Continue? [Y/n] ');
  if (answer && answer.toLowerCase() !== 'y') {
    process.stderr.write('Cancelled.\n');
    return;
  }

  // ── Step 6: Execute via daemon ──
  process.stderr.write('\nDowngrading...\n');

  const execResp = await daemonRequest('POST', '/_local/downgrade/execute', {
    downgradeToken: tokenData.downgradeToken,
    vpsEndpoint,
    operatorSignature: 'cli-initiated',
    operatorTimestamp: Date.now().toString(),
  });

  if (execResp.status !== 200) {
    const errData = execResp.data as { error?: string };
    process.stderr.write(`\nError: ${errData.error || 'Downgrade failed'}\n`);
    process.stderr.write('VPS project remains active. Safe to retry.\n');
    process.exit(1);
  }

  const result = execResp.data as { receipt: DowngradeReceipt };
  const receipt = result.receipt;

  // ── Step 7: Update config ──
  config.mode = 'local';
  config.downgradeId = receipt.downgradeId;
  config.downgradedAt = receipt.timestamp;
  config.previousVpsEndpoint = vpsEndpoint;
  config.previousProjectId = receipt.vpsProjectId;
  delete config.vpsEndpoint;
  delete config.projectId;

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

  // Save receipt
  const receiptPath = path.join(process.cwd(), '.ellul', 'downgrade-receipt.json');
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');

  // ── Step 8: Print success with honest notice ──
  process.stderr.write(`\n✓ Project downgraded successfully\n`);
  process.stderr.write(`✓ ${receipt.secretsExported} secret(s) transferred (encrypted end-to-end)\n`);
  process.stderr.write(`✓ ${receipt.rulesExported} custom rule(s) transferred\n`);
  process.stderr.write(`✓ ${receipt.gatePoliciesExported} gate policy(s) transferred\n`);
  process.stderr.write(`✓ VPS project archived\n`);

  if (receipt.remoteOnlyNotice) {
    const notice = receipt.remoteOnlyNotice;
    if (notice.hasDatabase || notice.hasDeployments || notice.hasTeamMembers) {
      process.stderr.write(`\n  Remote-only state NOT transferred:\n`);
      if (notice.hasDatabase) process.stderr.write(`    - Database data (remains on VPS)\n`);
      if (notice.hasDeployments) process.stderr.write(`    - Deployments (suspended)\n`);
      if (notice.hasTeamMembers) process.stderr.write(`    - Team settings\n`);
      if (notice.auditEntryCount > 0) process.stderr.write(`    - ${notice.auditEntryCount} audit entries (preserved on VPS)\n`);
    }
  }

  process.stderr.write(`\nNote: Your project is now running locally.\n`);
  process.stderr.write(`  Execution: local process (was: kernel-isolated VPS sandbox)\n`);
  process.stderr.write(`  Secrets: local encrypted SQLite (was: LUKS-encrypted volume)\n`);
  process.stderr.write(`  Audit: local JSON logs (was: cloud tamper-evident chain)\n`);
  process.stderr.write(`  Isolation: same-user boundary (was: separate user + namespace)\n`);
  process.stderr.write(`\nYour VPS project is archived and can be re-activated with: ellul-local upgrade\n`);
  process.stderr.write(`Receipt saved to .ellul/downgrade-receipt.json\n`);
  process.stderr.write(`\nRestart the daemon to switch to local mode.\n`);
}
