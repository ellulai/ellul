import * as fs from 'fs';
import * as path from 'path';
import { parseArgs } from '../../lib/flags';
import { info, fail, status, success, EXIT, isJsonMode } from '../../lib/output';
import { engineCall, isEngineReachable } from '../../lib/engine-client';
import { readConfig } from '../../lib/byos-config';

export async function handleMigrate(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  const to = parsed.get('to');
  const doExport = parsed.has('export');
  const doImport = parsed.has('import');
  const outputFile = parsed.get('output');

  if (doExport) {
    await exportVault(outputFile);
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
      'Usage: ellul migrate --to cloud|local\n       ellul migrate --export [--output FILE]\n       ellul migrate --import FILE',
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

async function exportVault(outputFile?: string): Promise<void> {
  if (!isEngineReachable()) {
    fail(EXIT.NETWORK, 'migrate', 'Engine not running.', 'Start with: ellul up');
  }

  const home = process.env.HOME || '';
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = outputFile || path.join(home, `.ellul/vault-export-${ts}.tar.gz.enc`);

  info('migrate', 'Exporting vault...');

  let result: { path: string; size: number };
  try {
    result = (await engineCall('vault.export', {
      destPath: dest,
      encrypt: true,
    }, 300000)) as typeof result;
  } catch (e: unknown) {
    fail(EXIT.NETWORK, 'migrate', `Export failed: ${e instanceof Error ? e.message : e}`);
  }

  status('✓', `Vault exported: ${result.path} (${(result.size / 1024 / 1024).toFixed(1)} MB)`);
  success({ path: result.path, size: result.size });
}

async function importVault(srcPath: string): Promise<void> {
  if (!isEngineReachable()) {
    fail(EXIT.NETWORK, 'migrate', 'Engine not running.', 'Start with: ellul up');
  }

  const resolved = path.resolve(srcPath);
  if (!fs.existsSync(resolved)) {
    fail(EXIT.USAGE, 'migrate', `File not found: ${resolved}`);
  }

  info('migrate', `Importing vault from ${resolved}...`);

  try {
    await engineCall('vault.import', {
      srcPath: resolved,
      encrypted: resolved.endsWith('.enc'),
    }, 300000);
  } catch (e: unknown) {
    fail(EXIT.NETWORK, 'migrate', `Import failed: ${e instanceof Error ? e.message : e}`);
  }

  status('✓', 'Vault imported');
  success({ imported: true });
}

async function migrateToCloud(): Promise<void> {
  const config = readConfig();
  if (!config.auth?.token) {
    fail(EXIT.AUTH, 'migrate', 'Not authenticated.', 'Run: ellul connect');
  }

  if (!isEngineReachable()) {
    fail(EXIT.NETWORK, 'migrate', 'Engine not running.', 'Start with: ellul up');
  }

  info('migrate', 'Migrating workspace to cloud...');

  let result: { serverId: string; domain: string };
  try {
    const res = await fetch('https://api.ellul.ai/api/servers/migrate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.auth.token}`,
      },
      body: JSON.stringify({ direction: 'to_cloud' }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`API ${res.status}: ${body.slice(0, 200)}`);
    }
    result = (await res.json()) as typeof result;
  } catch (e: unknown) {
    fail(EXIT.NETWORK, 'migrate', `Migration failed: ${e instanceof Error ? e.message : e}`);
  }

  info('migrate', 'Exporting vault for transfer...');
  const home = process.env.HOME || '';
  const exportPath = path.join(home, '.ellul/migrate-export.tar.gz.enc');

  try {
    await engineCall('vault.export', { destPath: exportPath, encrypt: true }, 300000);
  } catch (e: unknown) {
    fail(EXIT.NETWORK, 'migrate', `Vault export failed: ${e instanceof Error ? e.message : e}`);
  }

  info('migrate', 'Uploading vault to cloud VPS...');
  try {
    const buf = fs.readFileSync(exportPath);
    const uploadRes = await fetch(`https://api.ellul.ai/api/servers/${result.serverId}/vault-import`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.auth.token}`,
        'Content-Type': 'application/octet-stream',
      },
      body: buf,
    });
    if (!uploadRes.ok) throw new Error(`Upload failed: HTTP ${uploadRes.status}`);
  } catch (e: unknown) {
    fail(EXIT.NETWORK, 'migrate', `Vault upload failed: ${e instanceof Error ? e.message : e}`);
  } finally {
    try { fs.unlinkSync(exportPath); } catch {}
  }

  status('✓', `Migrated to cloud: ${result.domain}`);
  success({ serverId: result.serverId, domain: result.domain });
}

async function migrateToLocal(): Promise<void> {
  const config = readConfig();
  if (!config.auth?.token) {
    fail(EXIT.AUTH, 'migrate', 'Not authenticated.', 'Run: ellul connect');
  }

  if (!isEngineReachable()) {
    fail(EXIT.NETWORK, 'migrate', 'Engine not running.', 'Start with: ellul up');
  }

  info('migrate', 'Migrating workspace from cloud to local...');

  let vaultData: ArrayBuffer;
  try {
    const res = await fetch('https://api.ellul.ai/api/servers/migrate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.auth.token}`,
      },
      body: JSON.stringify({ direction: 'to_local' }),
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    vaultData = await res.arrayBuffer();
  } catch (e: unknown) {
    fail(EXIT.NETWORK, 'migrate', `Migration failed: ${e instanceof Error ? e.message : e}`);
  }

  const home = process.env.HOME || '';
  const importPath = path.join(home, '.ellul/migrate-import.tar.gz.enc');
  fs.writeFileSync(importPath, Buffer.from(vaultData));

  info('migrate', 'Importing vault...');
  try {
    await engineCall('vault.import', { srcPath: importPath, encrypted: true }, 300000);
  } catch (e: unknown) {
    fail(EXIT.NETWORK, 'migrate', `Vault import failed: ${e instanceof Error ? e.message : e}`);
  } finally {
    try { fs.unlinkSync(importPath); } catch {}
  }

  status('✓', 'Migrated to local');
  success({ migrated: true });
}
