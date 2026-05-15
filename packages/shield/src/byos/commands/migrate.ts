import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import { parseArgs } from '../../lib/flags';
import { info, fail, status, success, EXIT, isJsonMode } from '../../lib/output';
import { registerCommand, showCommandHelp } from '../../lib/help';
import { engineCallStreaming, isEngineReachable } from '../../lib/engine-client';
import { prompt } from '../../lib/context';
import {
  readConfig,
  writeConfig,
  readMigrationState,
  writeMigrationState,
  clearMigrationState,
  type MigrationState,
  type MigrationFileEntry,
} from '../../lib/byos-config';

const API_URL = process.env.ELLUL_API_URL || 'https://api.ellul.ai';

registerCommand({
  name: 'migrate',
  summary: 'Migrate workspace between cloud and local',
  usage:
    'ellul migrate --to cloud|local\n' +
    '       ellul migrate --export [--output FILE]\n' +
    '       ellul migrate --import FILE\n' +
    '       ellul migrate --resume',
  flags: [
    { name: 'to', description: 'Migration target', valueHint: 'cloud|local' },
    { name: 'export', description: 'Export vault to encrypted archive' },
    { name: 'import', description: 'Import vault from encrypted archive' },
    { name: 'output', description: 'Output file path for export', valueHint: 'path' },
    { name: 'resume', description: 'Resume a failed migration' },
  ],
  examples: [
    'ellul migrate --to cloud',
    'ellul migrate --to local',
    'ellul migrate --export --output ~/backup.tar.gz.enc',
    'ellul migrate --import ~/backup.tar.gz.enc',
    'ellul migrate --resume',
  ],
});

export async function handleMigrate(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  if (parsed.has('help')) {
    showCommandHelp('migrate');
    process.exit(0);
  }

  const to = parsed.get('to');
  const doExport = parsed.has('export');
  const doImport = parsed.has('import');
  const doResume = parsed.has('resume');

  if (doResume) {
    await resumeMigration();
    return;
  }

  if (doExport) {
    await exportVault(parsed.get('output'));
    return;
  }

  if (doImport) {
    const importFile = parsed.positional[0];
    if (!importFile) {
      fail(EXIT.USAGE, 'migrate', 'Specify the vault file to import.', 'Usage: ellul migrate --import <file>');
    }
    await importVault(importFile);
    return;
  }

  if (!to) {
    fail(
      EXIT.USAGE,
      'migrate',
      'Specify migration target.',
      'Usage: ellul migrate --to cloud|local\n       ellul migrate --export [--output FILE]\n       ellul migrate --import FILE\n       ellul migrate --resume',
    );
  }

  if (to === 'cloud') {
    await migrateToCloud();
  } else if (to === 'local') {
    await migrateToLocal();
  } else {
    fail(EXIT.USAGE, 'migrate', `Unknown target: ${to}`, 'Valid targets: cloud, local');
  }
}

// ── Local → Cloud (6 phases) ──

async function migrateToCloud(): Promise<void> {
  requireAuth();
  requireRunningEngine();

  const config = readConfig();
  const token = config.auth!.token;

  info('migrate', 'Starting local → cloud migration');

  const migrationId = crypto.randomBytes(16).toString('hex');
  const state: MigrationState = {
    migrationId,
    direction: 'to_cloud',
    phase: 0,
    startedAt: new Date().toISOString(),
    lastPhaseAt: new Date().toISOString(),
  };

  // ── Phase 1: Provision cloud VPS ──
  state.phase = 1;
  writeMigrationState(state);
  info('migrate', '[1/6] Provisioning cloud VPS...');

  const provision = await apiRequest<{ serverId: string; domain: string; status: string }>(
    '/api/byos/migration/provision',
    token,
    { source: 'byos-migration', plan: 'pro' },
  );

  state.serverId = provision.serverId;
  state.domain = provision.domain;
  writeMigrationState(state);

  status('·', `Server ${provision.serverId} — waiting for provisioning...`);
  await pollServerReady(provision.serverId, token, 600_000);
  status('✓', `Cloud VPS provisioned: ${provision.domain}`);

  // ── Phase 2: Key exchange ──
  state.phase = 2;
  state.lastPhaseAt = new Date().toISOString();
  writeMigrationState(state);
  info('migrate', '[2/6] ML-KEM-1024 key exchange...');

  const initResp = await apiRequest<{
    migrationId: string;
    mlkemEk: string | null;
  }>('/api/byos/migration/init', token, {
    serverId: provision.serverId,
    direction: 'to_cloud',
  });

  if (!initResp.mlkemEk) {
    fail(EXIT.NETWORK, 'migrate', 'Cloud VPS has not registered its encryption key yet.', 'Wait and retry: ellul migrate --resume');
  }

  status('✓', 'Key exchange initialized');

  // ── Phase 3: Gather + encrypt + upload ──
  state.phase = 3;
  state.lastPhaseAt = new Date().toISOString();
  writeMigrationState(state);
  info('migrate', '[3/6] Gathering state...');

  const gathered = (await engineCallStreaming('migration.gather', {}, progressPrinter)) as {
    done: boolean;
    files: Array<{ name: string; size: number; sha256: string }>;
  };

  const fileList = gathered.files;

  info('migrate', 'Requesting upload URLs...');
  const urlResp = await apiRequest<{ urls: Record<string, string>; r2Prefix: string }>(
    '/api/byos/migration/upload-urls',
    token,
    { serverId: provision.serverId, migrationId, files: fileList },
  );

  state.r2Prefix = urlResp.r2Prefix;
  writeMigrationState(state);

  info('migrate', 'Encrypting and uploading...');
  const encResult = (await engineCallStreaming('migration.encryptAndUpload', {
    mlkemEk: initResp.mlkemEk,
    migrationId,
    uploadUrls: urlResp.urls,
  }, progressPrinter)) as {
    done: boolean;
    mlkemCt: string;
    files: MigrationFileEntry[];
  };

  state.mlkemCt = encResult.mlkemCt;
  state.encryptedFiles = encResult.files;
  writeMigrationState(state);

  info('migrate', 'Resuming local services...');
  await engineCallStreaming('migration.resume', {}, progressPrinter);
  status('✓', 'State transferred and uploaded');

  // ── Phase 4: Cloud VPS restore ──
  state.phase = 4;
  state.lastPhaseAt = new Date().toISOString();
  writeMigrationState(state);
  info('migrate', '[4/6] Triggering cloud restore...');

  await apiRequest('/api/byos/migration/' + provision.serverId + '/restore', token, {
    serverId: provision.serverId,
    migrationId,
    mlkemCt: encResult.mlkemCt,
    files: encResult.files,
  });

  status('·', 'Restore queued — waiting for cloud VPS...');
  await pollRestoreComplete(provision.serverId, token, 600_000);
  status('✓', 'Cloud VPS restored');

  // ── Phase 5: Passkey re-registration (web_locked) ──
  state.phase = 5;
  state.lastPhaseAt = new Date().toISOString();
  writeMigrationState(state);
  info('migrate', '[5/6] Passkey enrollment...');

  const enrollUrl = `https://${provision.domain}/auth/migrate?migration=${migrationId}`;
  try {
    openBrowser(enrollUrl);
    status('·', `Opened browser for passkey enrollment on ${provision.domain}`);
  } catch {
    status('·', `Open this URL to enroll your passkey: ${enrollUrl}`);
  }

  status('·', 'Waiting for passkey enrollment (5 min timeout)...');
  const enrolled = await pollPasskeyEnrollment(provision.serverId, token, 300_000);

  if (!enrolled) {
    status('!', 'Passkey enrollment not confirmed — cloud VPS stays dark.');
    status('·', 'Retry with: ellul migrate --resume');
    return;
  }

  status('✓', 'Passkey enrolled on cloud origin');

  // ── Phase 6: Cutover ──
  state.phase = 6;
  state.lastPhaseAt = new Date().toISOString();
  writeMigrationState(state);
  info('migrate', '[6/6] Cutover...');

  if (config.tunnel?.subdomain) {
    try {
      await apiRequest('/api/byos/migration/tunnel/reroute', token, {
        subdomain: config.tunnel.subdomain,
        target: 'cloud',
        serverIp: provision.domain,
      });
      status('✓', `Tunnel rerouted: ${config.tunnel.subdomain}.ellul.app → cloud`);
    } catch {
      status('·', 'Tunnel reroute skipped (no active tunnel)');
    }
  }

  clearMigrationState();
  await cleanupR2(migrationId, token);

  if (!isJsonMode()) {
    console.log();
    console.log(`  Migration complete.`);
    console.log(`  Your workspace is now at https://${provision.domain}`);
    console.log();
    console.log(`  Local workspace entered read-only mode (7-day grace period).`);
    console.log(`  Run 'ellul migrate --to local' to bring it back.`);
    console.log();
  }

  success({
    direction: 'to_cloud',
    serverId: provision.serverId,
    domain: provision.domain,
  });
}

// ── Cloud → Local (5 phases) ──

async function migrateToLocal(): Promise<void> {
  requireAuth();
  requireRunningEngine();

  const config = readConfig();
  const token = config.auth!.token;

  info('migrate', 'Starting cloud → local migration');

  const migrationId = crypto.randomBytes(16).toString('hex');
  const state: MigrationState = {
    migrationId,
    direction: 'to_local',
    phase: 0,
    startedAt: new Date().toISOString(),
    lastPhaseAt: new Date().toISOString(),
  };

  // ── Phase 1: Authenticate + identify cloud server ──
  state.phase = 1;
  writeMigrationState(state);
  info('migrate', '[1/5] Authenticating...');

  const serversResp = await apiRequest<{ servers: Array<{ id: string; domain: string; status: string }> }>(
    '/api/servers', token, null, 'GET',
  );

  const cloudServers = (serversResp.servers || serversResp as any)
    .filter?.((s: any) => s.status === 'running') || [];

  if (cloudServers.length === 0) {
    fail(EXIT.NETWORK, 'migrate', 'No running cloud servers found.', 'Deploy with: ellul migrate --to cloud');
  }

  let serverId: string;
  let domain: string;

  if (cloudServers.length === 1) {
    serverId = cloudServers[0].id;
    domain = cloudServers[0].domain;
  } else {
    info('migrate', 'Multiple cloud servers found:');
    for (let i = 0; i < cloudServers.length; i++) {
      status(`${i + 1}`, `${cloudServers[i].domain} (${cloudServers[i].id})`);
    }
    const choice = await prompt('Select server number: ');
    const idx = parseInt(choice, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= cloudServers.length) {
      fail(EXIT.USAGE, 'migrate', 'Invalid selection.');
    }
    serverId = cloudServers[idx].id;
    domain = cloudServers[idx].domain;
  }

  state.serverId = serverId;
  state.domain = domain;
  writeMigrationState(state);
  status('✓', `Target: ${domain}`);

  // ── Phase 2: Key exchange (local generates keypair) ──
  state.phase = 2;
  state.lastPhaseAt = new Date().toISOString();
  writeMigrationState(state);
  info('migrate', '[2/5] ML-KEM-1024 key exchange (local keypair)...');

  const keypairResult = (await engineCallStreaming('migration.generateKeypair', {}, progressPrinter)) as {
    done: boolean;
    mlkemEk: string;
    migrationId: string;
  };

  const localMigrationId = keypairResult.migrationId;

  const initResp = await apiRequest<{ migrationId: string }>(
    '/api/byos/migration/init', token, {
      serverId,
      direction: 'to_local',
      localMlkemEk: keypairResult.mlkemEk,
    },
  );

  status('✓', 'Key exchange initialized');

  // ── Phase 3: Cloud VPS gathers + encrypts + uploads ──
  state.phase = 3;
  state.lastPhaseAt = new Date().toISOString();
  writeMigrationState(state);
  info('migrate', '[3/5] Cloud VPS gathering and encrypting state...');

  await apiRequest(`/api/byos/migration/${serverId}/export`, token, {
    serverId,
    migrationId,
    localMlkemEk: keypairResult.mlkemEk,
  });

  status('·', 'Waiting for cloud VPS to export state...');
  const exportResult = await pollExportComplete(serverId, token, 600_000);
  status('✓', 'Cloud state exported');

  const cloudMlkemCt = exportResult.mlkemCt || '';
  const encFiles: MigrationFileEntry[] = exportResult.files || [];

  state.mlkemCt = cloudMlkemCt;
  state.encryptedFiles = encFiles;
  writeMigrationState(state);

  // ── Phase 3b: Download + decrypt + restore locally ──
  info('migrate', 'Downloading and restoring locally...');

  const fileNames = encFiles.map(f => f.name);
  const downloadUrls = await apiRequest<{ urls: Record<string, string> }>(
    '/api/byos/migration/download-urls', token, {
      serverId,
      migrationId,
      files: fileNames.length > 0 ? fileNames : ['postgres.dump', 'vault.tar', 'projects.tar'],
    },
  );

  await engineCallStreaming('migration.downloadAndRestore', {
    migrationId: localMigrationId,
    mlkemCt: cloudMlkemCt,
    downloadUrls: downloadUrls.urls,
    encryptedFiles: encFiles,
  }, progressPrinter);

  status('✓', 'Local restore complete');

  // ── Phase 4: Passkey re-registration ──
  state.phase = 4;
  state.lastPhaseAt = new Date().toISOString();
  writeMigrationState(state);
  info('migrate', '[4/5] Passkey enrollment on localhost...');

  const localEnrollUrl = 'https://localhost/auth/migrate?migration=' + migrationId;
  try {
    openBrowser(localEnrollUrl);
    status('·', 'Opened browser for passkey enrollment');
  } catch {
    status('·', `Open this URL: ${localEnrollUrl}`);
  }

  status('·', 'Waiting for passkey enrollment (5 min timeout)...');
  const enrolled = await pollLocalPasskeyEnrollment(300_000);

  if (!enrolled) {
    status('!', 'Passkey enrollment not confirmed.');
    status('·', 'Retry with: ellul migrate --resume');
    return;
  }

  status('✓', 'Passkey enrolled on localhost');

  // ── Phase 5: Cutover ──
  state.phase = 5;
  state.lastPhaseAt = new Date().toISOString();
  writeMigrationState(state);
  info('migrate', '[5/5] Cutover...');

  if (config.tunnel?.subdomain) {
    try {
      await apiRequest('/api/byos/migration/tunnel/reroute', token, {
        subdomain: config.tunnel.subdomain,
        target: 'tunnel',
      });
      status('✓', `Tunnel rerouted back to local`);
    } catch {}
  }

  clearMigrationState();
  await cleanupR2(migrationId, token);

  if (!isJsonMode()) {
    console.log();
    console.log('  Migration complete. Your workspace is running locally.');
    console.log();
  }

  success({ direction: 'to_local', serverId });
}

// ── Export / Import ──

async function exportVault(outputFile?: string): Promise<void> {
  requireRunningEngine();

  const home = process.env.HOME || '';
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = outputFile || path.join(home, `.ellul/vault-export-${ts}.tar.gz.enc`);

  const passphrase = await prompt('Enter passphrase for vault encryption: ');
  if (!passphrase || passphrase.length < 8) {
    fail(EXIT.USAGE, 'migrate', 'Passphrase must be at least 8 characters.');
  }

  const confirm = await prompt('Confirm passphrase: ');
  if (confirm !== passphrase) {
    fail(EXIT.USAGE, 'migrate', 'Passphrases do not match.');
  }

  info('migrate', 'Exporting vault...');

  const result = (await engineCallStreaming('migration.exportPassphrase', {
    destPath: dest,
    passphrase,
  }, progressPrinter)) as { done: boolean; path: string; size: number; sha256: string };

  if (!isJsonMode()) {
    console.log();
    console.log(`  Export saved: ${result.path}`);
    console.log(`  Size: ${fmtBytes(result.size)}`);
    console.log(`  SHA-256: ${result.sha256}`);
    console.log();
  }

  success({ path: result.path, size: result.size, sha256: result.sha256 });
}

async function importVault(srcPath: string): Promise<void> {
  requireRunningEngine();

  const resolved = path.resolve(srcPath);
  if (!fs.existsSync(resolved)) {
    fail(EXIT.USAGE, 'migrate', `File not found: ${resolved}`);
  }

  const fileSha = sha256File(resolved);
  info('migrate', `Importing vault from ${resolved}`);
  status('·', `File SHA-256: ${fileSha.slice(0, 16)}...`);

  const passphrase = await prompt('Enter passphrase: ');
  if (!passphrase) {
    fail(EXIT.USAGE, 'migrate', 'Passphrase required.');
  }

  await engineCallStreaming('migration.importPassphrase', {
    srcPath: resolved,
    passphrase,
  }, progressPrinter);

  status('✓', 'Vault imported');
  success({ imported: true });
}

// ── Resume ──

async function resumeMigration(): Promise<void> {
  const state = readMigrationState();
  if (!state) {
    fail(EXIT.USAGE, 'migrate', 'No migration in progress.', 'Start with: ellul migrate --to cloud|local');
  }

  info('migrate', `Resuming ${state.direction} migration from phase ${state.phase}...`);
  info('migrate', `Migration ID: ${state.migrationId.slice(0, 12)}...`);
  info('migrate', `Started: ${state.startedAt}`);

  if (state.direction === 'to_cloud') {
    await resumeToCloud(state);
  } else {
    await resumeToLocal(state);
  }
}

async function resumeToCloud(state: MigrationState): Promise<void> {
  requireAuth();
  requireRunningEngine();

  const config = readConfig();
  const token = config.auth!.token;

  if (state.phase <= 3) {
    fail(EXIT.USAGE, 'migrate', `Migration failed at phase ${state.phase} (pre-upload). Cannot resume — restart with: ellul migrate --to cloud`);
  }

  if (state.phase === 4 && state.serverId) {
    info('migrate', 'Checking cloud VPS restore status...');
    try {
      const statusResp = await apiRequest<{ status: string }>(
        `/api/byos/migration/${state.serverId}/status`, token, null, 'GET',
      );
      if (statusResp.status === 'completed') {
        state.phase = 5;
        writeMigrationState(state);
      } else if (statusResp.status === 'failed') {
        fail(EXIT.NETWORK, 'migrate', 'Cloud VPS restore failed.', 'Check server logs and restart: ellul migrate --to cloud');
      } else {
        status('·', `Restore still ${statusResp.status} — waiting...`);
        await pollRestoreComplete(state.serverId, token, 600_000);
        state.phase = 5;
        writeMigrationState(state);
      }
    } catch (e: unknown) {
      if (e instanceof Error && e.message.includes('failed')) throw e;
      fail(EXIT.NETWORK, 'migrate', 'Could not check restore status.');
    }
  }

  if (state.phase === 5) {
    info('migrate', 'Retrying passkey enrollment...');
    const domain = state.domain || '';
    const enrollUrl = `https://${domain}/auth/migrate?migration=${state.migrationId}`;

    try { openBrowser(enrollUrl); } catch {}
    status('·', `Open ${enrollUrl} if browser did not open`);

    const enrolled = await pollPasskeyEnrollment(state.serverId!, token, 300_000);
    if (!enrolled) {
      status('!', 'Passkey enrollment still not confirmed.');
      return;
    }

    state.phase = 6;
    writeMigrationState(state);
  }

  if (state.phase >= 6) {
    clearMigrationState();
    await cleanupR2(state.migrationId, token);

    if (!isJsonMode()) {
      console.log();
      console.log(`  Migration complete. Workspace at https://${state.domain}`);
      console.log();
    }
    success({ direction: 'to_cloud', serverId: state.serverId, domain: state.domain });
  }
}

async function resumeToLocal(state: MigrationState): Promise<void> {
  requireAuth();
  requireRunningEngine();

  const config = readConfig();
  const token = config.auth!.token;

  if (state.phase <= 3) {
    fail(EXIT.USAGE, 'migrate', `Migration failed at phase ${state.phase} (pre-download). Cannot resume — restart with: ellul migrate --to local`);
  }

  if (state.phase === 4) {
    info('migrate', 'Retrying passkey enrollment on localhost...');
    const enrollUrl = 'https://localhost/auth/migrate?migration=' + state.migrationId;
    try { openBrowser(enrollUrl); } catch {}

    const enrolled = await pollLocalPasskeyEnrollment(300_000);
    if (!enrolled) {
      status('!', 'Passkey enrollment still not confirmed.');
      return;
    }

    state.phase = 5;
    writeMigrationState(state);
  }

  if (state.phase >= 5) {
    clearMigrationState();
    await cleanupR2(state.migrationId, token);

    if (!isJsonMode()) {
      console.log();
      console.log('  Migration complete. Workspace running locally.');
      console.log();
    }
    success({ direction: 'to_local', serverId: state.serverId });
  }
}

// ── Helpers ──

function requireAuth(): void {
  const config = readConfig();
  if (!config.auth?.token) {
    fail(EXIT.AUTH, 'migrate', 'Not authenticated.', 'Run: ellul connect');
  }
}

function requireRunningEngine(): void {
  if (!isEngineReachable()) {
    fail(EXIT.NETWORK, 'migrate', 'Engine not running.', 'Start with: ellul up');
  }
}

function progressPrinter(msg: string): void {
  if (!isJsonMode()) {
    status('·', msg);
  }
}

async function apiRequest<T = unknown>(
  urlPath: string,
  token: string,
  body?: unknown,
  method = 'POST',
): Promise<T> {
  const opts: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
  };
  if (body && method !== 'GET') {
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(`${API_URL}${urlPath}`, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

async function pollServerReady(serverId: string, token: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await apiRequest<{ status: string }>(
        `/api/servers/${serverId}`, token, null, 'GET',
      );
      if (resp.status === 'running' || resp.status === 'provisioned') return;
      if (resp.status === 'failed') {
        throw new Error('Cloud VPS provisioning failed');
      }
    } catch (e: unknown) {
      if (e instanceof Error && e.message.includes('provisioning failed')) throw e;
    }
    await sleep(5000);
  }
  throw new Error('Cloud VPS provisioning timed out (10 min)');
}

async function pollRestoreComplete(serverId: string, token: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await apiRequest<{ status: string; type?: string }>(
        `/api/byos/migration/${serverId}/status`, token, null, 'GET',
      );
      if (resp.status === 'completed') return;
      if (resp.status === 'failed') throw new Error('Restore failed on cloud VPS');
    } catch (e: unknown) {
      if (e instanceof Error && e.message.includes('failed')) throw e;
    }
    await sleep(10_000);
  }
  throw new Error('Restore timed out');
}

async function pollExportComplete(
  serverId: string,
  token: string,
  timeoutMs: number,
): Promise<{ mlkemCt?: string; files?: MigrationFileEntry[] }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await apiRequest<{
        status: string;
        type?: string;
        result?: { mlkemCt?: string; files?: MigrationFileEntry[] };
      }>(`/api/byos/migration/${serverId}/status`, token, null, 'GET');
      if (resp.status === 'completed' && resp.type === 'byos-migrate-export') {
        return resp.result || {};
      }
      if (resp.status === 'failed') throw new Error('Export failed on cloud VPS');
    } catch (e: unknown) {
      if (e instanceof Error && e.message.includes('failed')) throw e;
    }
    await sleep(10_000);
  }
  throw new Error('Cloud export timed out');
}

async function pollPasskeyEnrollment(serverId: string, token: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await apiRequest<{ enrolled?: boolean }>(
        `/api/byos/migration/${serverId}/status`, token, null, 'GET',
      );
      if ((resp as any).enrolled) return true;
    } catch {}
    await sleep(3000);
  }
  return false;
}

async function pollLocalPasskeyEnrollment(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch('https://localhost:3005/_auth/migration/status', {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const data = await res.json() as { enrolled?: boolean };
        if (data.enrolled) return true;
      }
    } catch {}
    await sleep(3000);
  }
  return false;
}

function openBrowser(url: string): void {
  if (process.platform === 'darwin') {
    execFileSync('open', [url], { stdio: 'ignore' });
  } else if (process.platform === 'win32') {
    execFileSync('cmd', ['/c', 'start', url], { stdio: 'ignore' });
  } else {
    execFileSync('xdg-open', [url], { stdio: 'ignore' });
  }
}

async function cleanupR2(migrationId: string, token: string): Promise<void> {
  try {
    await apiRequest(`/api/byos/migration/${migrationId}/cleanup`, token, {});
  } catch {}
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function sha256File(filePath: string): string {
  const hash = crypto.createHash('sha256');
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest('hex');
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(1)} GB`;
}
