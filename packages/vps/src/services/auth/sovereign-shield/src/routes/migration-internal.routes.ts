// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import type { Hono } from 'hono';
import crypto from 'crypto';
import fs from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { execSync, execFileSync } from 'child_process';
import { getServiceUser } from '../config';
import { logAuditEvent } from '../application/audit/Audit';

const NODE_KEY_PATH = '/etc/ellul-bootstrap/node.key';
const MIGRATION_HKDF_INFO = 'ellul:migration-encrypt:v1';

const SERVICES_TO_QUIESCE = [
  'caddy',
  'ellul-file-api',
  'ellul-agent-bridge',
  'ellul-term-proxy',
];

const PROJECT_TAR_EXCLUDES = [
  'node_modules',
  '.git/objects',
  '.env',
  '.env.*',
  '.envrc',
  '.openclaw',
  '__pycache__',
  '.venv',
  'venv',
  'dist',
  'build',
  '.next',
  '.cache',
  'coverage',
  '.turbo',
];

function svcHome(): string {
  return `/home/${getServiceUser()}`;
}

function vaultRoot(): string {
  return `${svcHome()}/.ellul-vault`;
}

function projectsDir(): string {
  return `${svcHome()}/projects`;
}

function stopServices(includePostgres = false): void {
  if (includePostgres) {
    try { execSync("sudo -u postgres psql -c 'CHECKPOINT;' 2>/dev/null", { timeout: 10_000 }); } catch {}
  }
  for (const svc of SERVICES_TO_QUIESCE) {
    try { execSync(`systemctl stop ${svc}`, { timeout: 60_000 }); } catch {}
  }
  if (includePostgres) {
    try { execSync('systemctl stop postgresql', { timeout: 60_000 }); } catch {}
  }
}

function startServices(includePostgres = false): void {
  if (includePostgres) {
    try { execSync('systemctl start postgresql', { timeout: 60_000 }); } catch {}
  }
  for (const svc of SERVICES_TO_QUIESCE) {
    try { execSync(`systemctl start ${svc}`, { timeout: 60_000 }); } catch {}
  }
}

function readMlkemDk(): Uint8Array {
  const raw = fs.readFileSync(NODE_KEY_PATH, 'utf8');
  const priv = JSON.parse(raw);
  return new Uint8Array(Buffer.from(priv.mlkem_dk, 'base64'));
}

async function deriveAesKey(sharedSecret: Uint8Array): Promise<Buffer> {
  const key = Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(sharedSecret), Buffer.alloc(0), MIGRATION_HKDF_INFO, 32),
  );
  return key;
}

async function streamDownload(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(dest));
}

async function streamDecrypt(
  src: string,
  dest: string,
  key: Buffer,
  iv: Buffer,
  authTag: Buffer,
): Promise<void> {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  await pipeline(fs.createReadStream(src), decipher, fs.createWriteStream(dest));
}

async function streamEncrypt(
  src: string,
  dest: string,
  key: Buffer,
): Promise<{ iv: string; authTag: string }> {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  await pipeline(fs.createReadStream(src), cipher, fs.createWriteStream(dest));
  return {
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

async function streamUpload(src: string, url: string): Promise<void> {
  const stat = fs.statSync(src);
  const body = Readable.toWeb(fs.createReadStream(src)) as ReadableStream;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Length': String(stat.size) },
    body,
    duplex: 'half',
  } as RequestInit);
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}

function backupCurrentVault(backupPath: string): void {
  const vault = vaultRoot();
  if (fs.existsSync(vault)) {
    execSync(`tar -cf ${backupPath} -C ${vault} .`, { timeout: 300_000 });
  }
}

function rollbackFromBackup(backupPath: string): void {
  const vault = vaultRoot();
  if (!fs.existsSync(backupPath)) return;
  try {
    execSync(`tar -xf ${backupPath} -C ${vault}`, { timeout: 300_000 });
    startServices();
  } catch {}
}

function cleanDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

export function registerMigrationInternalRoutes(app: Hono): void {
  app.post('/api/internal/migration/restore', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (
      !body?.migrationId ||
      !body?.mlkemCt ||
      !body?.downloadUrls ||
      !Array.isArray(body?.files)
    ) {
      return c.json({ error: 'Missing required fields' }, 400);
    }

    const { migrationId, mlkemCt, downloadUrls, files } = body as {
      migrationId: string;
      mlkemCt: string;
      downloadUrls: Record<string, string>;
      files: Array<{ name: string; iv: string; authTag: string }>;
    };

    const tmpDir = `/tmp/ellul-migration-restore-${migrationId}`;
    const rollbackPath = '/tmp/ellul-migration-rollback.tar';
    let aesKey: Buffer | null = null;

    try {
      fs.mkdirSync(tmpDir, { recursive: true });

      logAuditEvent({
        type: 'migration_restore_start',
        details: { migrationId, fileCount: files.length },
      });

      for (const [name, url] of Object.entries(downloadUrls)) {
        await streamDownload(url as string, `${tmpDir}/${name}.enc`);
      }

      const dk = readMlkemDk();
      const { ml_kem1024 } = await import('@noble/post-quantum/ml-kem.js');
      const ctBytes = new Uint8Array(Buffer.from(mlkemCt, 'base64'));
      const sharedSecret = ml_kem1024.decapsulate(ctBytes, dk);
      dk.fill(0);

      aesKey = await deriveAesKey(sharedSecret);
      (sharedSecret as Uint8Array).fill(0);

      for (const file of files) {
        const encPath = `${tmpDir}/${file.name}.enc`;
        const decPath = `${tmpDir}/${file.name}`;
        await streamDecrypt(
          encPath,
          decPath,
          aesKey,
          Buffer.from(file.iv, 'base64'),
          Buffer.from(file.authTag, 'base64'),
        );
        fs.unlinkSync(encPath);
      }

      backupCurrentVault(rollbackPath);

      try {
        stopServices(true);

        const vault = vaultRoot();
        const projects = projectsDir();

        if (downloadUrls['vault.tar']) {
          execSync(`tar -xf ${tmpDir}/vault.tar -C ${vault}`, { timeout: 300_000 });
        }

        if (downloadUrls['postgres.dump']) {
          try { execSync('systemctl start postgresql', { timeout: 60_000 }); } catch {}
          for (let i = 0; i < 30; i++) {
            try { execFileSync('runuser', ['-l', 'postgres', '-c', 'pg_isready -q'], { timeout: 5000 }); break; } catch {}
            execSync('sleep 1');
          }
          try {
            execFileSync('runuser', [
              '-l', 'postgres', '-c',
              `pg_restore --clean --if-exists --dbname=postgres ${tmpDir}/postgres.dump`,
            ], { timeout: 600_000 });
          } catch {}
        }

        if (downloadUrls['projects.tar']) {
          fs.mkdirSync(projects, { recursive: true });
          execSync(`tar -xf ${tmpDir}/projects.tar -C ${projects}`, { timeout: 300_000 });
          try { execSync(`chown -R ${getServiceUser()}:${getServiceUser()} ${projects}`, { timeout: 60_000 }); } catch {}
        }

        startServices(true);
      } catch (restoreErr) {
        rollbackFromBackup(rollbackPath);
        throw restoreErr;
      }

      aesKey.fill(0);
      aesKey = null;

      cleanDir(tmpDir);
      try { fs.unlinkSync(rollbackPath); } catch {}

      logAuditEvent({
        type: 'migration_restore_complete',
        details: { migrationId },
      });

      return c.json({ success: true });
    } catch (err) {
      if (aesKey) { aesKey.fill(0); aesKey = null; }
      cleanDir(tmpDir);

      logAuditEvent({
        type: 'migration_restore_failed',
        details: { migrationId, error: (err as Error).message },
      });

      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post('/api/internal/migration/export', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body?.migrationId || !body?.localMlkemEk || !body?.uploadUrls) {
      return c.json({ error: 'Missing required fields' }, 400);
    }

    const { migrationId, localMlkemEk, uploadUrls } = body as {
      migrationId: string;
      localMlkemEk: string;
      uploadUrls: Record<string, string>;
    };

    const stagingDir = `/tmp/ellul-migration-staging-${migrationId}`;
    let aesKey: Buffer | null = null;

    try {
      fs.mkdirSync(stagingDir, { recursive: true });

      logAuditEvent({
        type: 'migration_export_start',
        details: { migrationId },
      });

      stopServices(false);

      try {
        const vault = vaultRoot();
        const projects = projectsDir();

        execFileSync('runuser', [
          '-l', 'postgres', '-c',
          `pg_dump --format=custom --compress=6 --file=${stagingDir}/postgres.dump --dbname=postgres`,
        ], { timeout: 600_000 });

        if (fs.existsSync(vault)) {
          execSync(`tar -cf ${stagingDir}/vault.tar -C ${vault} .`, { timeout: 300_000 });
        } else {
          fs.writeFileSync(`${stagingDir}/vault.tar`, '');
        }

        if (fs.existsSync(projects)) {
          const excludeFlags = PROJECT_TAR_EXCLUDES.map((e) => `--exclude='${e}'`).join(' ');
          execSync(
            `tar -cf ${stagingDir}/projects.tar ${excludeFlags} -C ${projects} .`,
            { timeout: 600_000, shell: '/bin/bash' },
          );
        } else {
          fs.writeFileSync(`${stagingDir}/projects.tar`, '');
        }
      } finally {
        startServices(false);
      }

      const { ml_kem1024 } = await import('@noble/post-quantum/ml-kem.js');
      const ekBytes = new Uint8Array(Buffer.from(localMlkemEk, 'base64'));
      const { sharedSecret, cipherText } = ml_kem1024.encapsulate(ekBytes);

      const ssBuf = Buffer.from(
        (sharedSecret as Uint8Array).buffer,
        (sharedSecret as Uint8Array).byteOffset,
        (sharedSecret as Uint8Array).byteLength,
      );
      aesKey = await deriveAesKey(ssBuf);
      ssBuf.fill(0);
      (sharedSecret as Uint8Array).fill(0);

      const fileResults: Array<{
        name: string;
        iv: string;
        authTag: string;
        sha256: string;
        size: number;
      }> = [];

      for (const [name, url] of Object.entries(uploadUrls)) {
        const plainPath = `${stagingDir}/${name}`;
        const encPath = `${stagingDir}/${name}.enc`;

        const { iv, authTag } = await streamEncrypt(plainPath, encPath, aesKey);
        const sha256 = await sha256File(encPath);
        const size = fs.statSync(encPath).size;

        await streamUpload(encPath, url as string);

        fs.unlinkSync(plainPath);
        fs.unlinkSync(encPath);

        fileResults.push({ name, iv, authTag, sha256, size });
      }

      const mlkemCt = Buffer.from(cipherText).toString('base64');

      aesKey.fill(0);
      aesKey = null;

      cleanDir(stagingDir);

      logAuditEvent({
        type: 'migration_export_complete',
        details: { migrationId, fileCount: fileResults.length },
      });

      return c.json({
        success: true,
        mlkemCt,
        files: fileResults,
      });
    } catch (err) {
      if (aesKey) { aesKey.fill(0); aesKey = null; }
      cleanDir(stagingDir);

      logAuditEvent({
        type: 'migration_export_failed',
        details: { migrationId, error: (err as Error).message },
      });

      return c.json({ error: (err as Error).message }, 500);
    }
  });
}
