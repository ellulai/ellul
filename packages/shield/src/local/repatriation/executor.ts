// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

// VPS→local downgrade. Local generates ML-KEM-1024 keypair; VPS encapsulates TO local.
// Pipeline: lock → ek POST init → decapsulate → validate → staged import → swap → finalize → zeroize.
// Pre-finalize failure: VPS stays active, retry safe. Only receipt crosses daemon→CLI.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type { LocalDaemonState } from '../daemon/state';
import { LocalSecretStore } from '../secrets/index';
import { LocalRuleStore } from '../guardrails/rule-store';
import type {
  DowngradePayload,
  DowngradeReceipt,
  DowngradeInitResponse,
  DowngradeExportResponse,
} from './types';
import { validateDowngradePayloadLimits, DowngradeValidationError } from './types';

// ── Local Downgrade Lock ──

const activeDowngrades = new Set<string>();

export function isDowngradeInProgress(slug: string): boolean {
  return activeDowngrades.has(slug);
}

function acquireLock(slug: string): boolean {
  if (activeDowngrades.has(slug)) return false;
  activeDowngrades.add(slug);
  return true;
}

function releaseLock(slug: string): void {
  activeDowngrades.delete(slug);
}

// ── Ephemeral KEM Keypair Store (local daemon generates, holds dk) ──

interface LocalKemState {
  dk: Uint8Array;     // Decapsulation key (secret, LOCAL holds this)
  downgradeId: string;
  createdAt: number;
}

const pendingKem = new Map<string, LocalKemState>();

// Cleanup expired keypairs
setInterval(() => {
  const now = Date.now();
  for (const [id, state] of pendingKem) {
    if (now - state.createdAt > 60_000) {
      state.dk.fill(0);
      pendingKem.delete(id);
    }
  }
}, 30_000).unref();

// ── HTTP Helper ──

function vpsRequest(
  vpsEndpoint: string,
  urlPath: string,
  body: unknown,
  downgradeToken: string,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, vpsEndpoint);
    const bodyStr = JSON.stringify(body);
    const transport = url.protocol === 'https:'
      ? require('https') as typeof import('https')
      : require('http') as typeof import('http');

    const req = transport.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(bodyStr)),
        'Authorization': `Bearer ${downgradeToken}`,
        'X-Ellul-Downgrade': 'v1',
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode || 500, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode || 500, data: { error: data } }); }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('VPS request timeout')); });
    req.write(bodyStr);
    req.end();
  });
}

// ── Staged Import ──

function stageSecrets(stagingDir: string, secrets: Array<{ name: string; value: string }>, encKey: Buffer): void {
  const dbPath = path.join(stagingDir, 'secrets.db');
  const store = new LocalSecretStore(dbPath, encKey);
  for (const s of secrets) {
    store.set(s.name, s.value);
  }
  store.close();
}

function stageRules(stagingDir: string, rules: DowngradePayload['rules']): void {
  const rulesDir = path.join(stagingDir, 'guardrails');
  const ruleStore = new LocalRuleStore(rulesDir);
  // Import custom rules only (skip locked — local has its own defaults)
  for (const rule of rules.filter(r => !r.locked)) {
    try {
      ruleStore.addRule({
        scope: rule.scope,
        language: rule.language,
        name: rule.name,
        description: rule.description,
        query_scm: rule.query_scm,
        severity: rule.severity,
        message: rule.message,
      });
    } catch {
      // Skip rules that fail to import (e.g., duplicate names from defaults)
    }
  }
  ruleStore.close();
}

function stageGatePolicies(stagingDir: string, policies: Record<string, string>): void {
  const policiesPath = path.join(stagingDir, 'gate-policies.json');
  fs.writeFileSync(policiesPath, JSON.stringify(policies, null, 2), { mode: 0o600 });
}

function swapStagedToActive(stagingDir: string, projectDir: string, configDir: string): void {
  // Swap secrets.db
  const stagedSecrets = path.join(stagingDir, 'secrets.db');
  const activeSecrets = path.join(projectDir, '.ellul', 'secrets.db');
  if (fs.existsSync(stagedSecrets)) {
    if (fs.existsSync(activeSecrets)) {
      fs.renameSync(activeSecrets, activeSecrets + '.backup');
    }
    fs.renameSync(stagedSecrets, activeSecrets);
  }

  // Swap guardrails
  const stagedRules = path.join(stagingDir, 'guardrails', 'rules.db');
  const activeRules = path.join(configDir, 'guardrails', 'rules.db');
  if (fs.existsSync(stagedRules)) {
    if (fs.existsSync(activeRules)) {
      fs.renameSync(activeRules, activeRules + '.backup');
    }
    fs.renameSync(stagedRules, activeRules);
  }

  // Copy gate policies (not rename — different directory structure)
  const stagedPolicies = path.join(stagingDir, 'gate-policies.json');
  if (fs.existsSync(stagedPolicies)) {
    const policiesData = fs.readFileSync(stagedPolicies, 'utf8');
    // Gate policies are in-memory on local daemon — they'll be loaded on restart
    // Store as a file for restart recovery
    fs.writeFileSync(path.join(projectDir, '.ellul', 'gate-policies.json'), policiesData, { mode: 0o600 });
  }
}

function cleanupStaging(stagingDir: string): void {
  try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
}

// ── Main Executor ──

export async function executeDowngrade(
  state: LocalDaemonState,
  downgradeToken: string,
  vpsEndpoint: string,
): Promise<DowngradeReceipt> {
  const slug = state.registry.getDefaultProject();
  if (!slug) throw new DowngradeValidationError('No project registered');

  const project = state.registry.getProject(slug);
  if (!project) throw new DowngradeValidationError('Project not found in registry');

  if (!acquireLock(slug)) {
    throw new DowngradeValidationError(`Downgrade already in progress for ${slug}`);
  }

  const configDir = path.join(process.env.HOME || '~', '.ellul');
  const stagingDir = path.join(project.directory, '.ellul', 'downgrade-staged');

  let dk: Uint8Array | null = null;
  let sharedSecret: Uint8Array | null = null;
  let kDown: Buffer | null = null;
  let payloadBuffer: Buffer | null = null;

  try {
    const downgradeId = crypto.randomBytes(16).toString('hex');

    // ── Step 1: Generate ML-KEM-1024 keypair (LOCAL holds dk) ──
    state.logger.info('downgrade_keygen', 'Generating ML-KEM-1024 keypair', { project: slug });

    const { ml_kem1024 } = await import('@noble/post-quantum/ml-kem.js');
    const { publicKey: ek, secretKey: generatedDk } = ml_kem1024.keygen();
    dk = generatedDk;

    // Store dk with TTL for cleanup
    pendingKem.set(downgradeId, { dk: dk!, downgradeId, createdAt: Date.now() });

    // ── Step 2: Init key exchange with VPS (send our ek) ──
    state.logger.info('downgrade_init', 'Initiating key exchange with VPS', { project: slug });

    const initResp = await vpsRequest(vpsEndpoint, '/_auth/downgrade/init', {
      projectSlug: slug,
      downgradeId,
      mlkem_ek: Buffer.from(ek).toString('base64'),
    }, downgradeToken);

    if (initResp.status !== 200) {
      const err = initResp.data as { error?: string };
      throw new DowngradeValidationError(`VPS downgrade init failed: ${err.error || 'Unknown'}`);
    }

    const initData = initResp.data as DowngradeInitResponse;

    // ── Step 3: Request VPS export (VPS encapsulates to our ek) ──
    state.logger.info('downgrade_export', 'Requesting encrypted export from VPS', { project: slug });

    const exportResp = await vpsRequest(vpsEndpoint, '/_auth/downgrade/export', {
      downgradeId,
    }, downgradeToken);

    if (exportResp.status !== 200) {
      const err = exportResp.data as { error?: string };
      throw new DowngradeValidationError(`VPS downgrade export failed: ${err.error || 'Unknown'}`);
    }

    const exportData = exportResp.data as DowngradeExportResponse;
    const encrypted = exportData.encryptedPayload;
    const receipt = exportData.receipt;

    // ── Step 4: Decapsulate (LOCAL's dk) ──
    state.logger.info('downgrade_decrypt', 'Decapsulating and decrypting payload', { project: slug });

    // Remove dk from pending store (single-use)
    pendingKem.delete(downgradeId);

    const ctBytes = Buffer.from(encrypted.mlkem_ct, 'base64');
    if (!dk) throw new DowngradeValidationError('Decapsulation key missing');
    sharedSecret = ml_kem1024.decapsulate(ctBytes, dk) as Uint8Array;

    // Zeroize dk immediately
    dk.fill(0);
    dk = null;

    // Verify bind proof
    const ssBuf = Buffer.from(sharedSecret.buffer, sharedSecret.byteOffset, sharedSecret.byteLength);
    const expectedProof = crypto.createHmac('sha256', ssBuf)
      .update(`downgrade-bind|${downgradeId}|${initData.challenge}`)
      .digest('base64');

    const proofBuf = Buffer.from(encrypted.bindProof, 'utf8');
    const expectedBuf = Buffer.from(expectedProof, 'utf8');
    if (proofBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(proofBuf, expectedBuf)) {
      ssBuf.fill(0);
      sharedSecret.fill(0);
      throw new DowngradeValidationError('Bind proof verification failed');
    }

    // Derive K_down
    kDown = Buffer.from(
      crypto.hkdfSync('sha256', ssBuf, Buffer.alloc(0), 'ellul:downgrade-encrypt:v1', 32),
    );
    ssBuf.fill(0);
    sharedSecret.fill(0);
    sharedSecret = null;

    // Decrypt payload
    const iv = Buffer.from(encrypted.iv, 'base64');
    const ciphertext = Buffer.from(encrypted.ciphertext, 'base64');
    const authTag = Buffer.from(encrypted.authTag, 'base64');

    const decipher = crypto.createDecipheriv('aes-256-gcm', kDown, iv, { authTagLength: 16 });
    decipher.setAuthTag(authTag);
    payloadBuffer = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    kDown.fill(0);
    kDown = null;

    const payload: DowngradePayload = JSON.parse(payloadBuffer.toString('utf8'));
    payloadBuffer.fill(0);
    payloadBuffer = null;

    // ── Step 5: Validate payload ──
    if (payload.version !== 1) throw new DowngradeValidationError(`Unsupported version: ${payload.version}`);
    if (payload.downgradeId !== downgradeId) throw new DowngradeValidationError('Downgrade ID mismatch');
    validateDowngradePayloadLimits(payload);

    // ── Step 6: Staged import ──
    state.logger.info('downgrade_stage', 'Staging imported state', { project: slug });

    fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });

    try {
      stageSecrets(stagingDir, payload.secrets, state.derivedKeys.secretsEncKey);
      stageRules(stagingDir, payload.rules);
      stageGatePolicies(stagingDir, payload.gatePermissions);
    } catch (err) {
      cleanupStaging(stagingDir);
      throw new DowngradeValidationError(`Staged import failed: ${(err as Error).message}`);
    }

    // Zeroize secrets from payload
    for (const secret of payload.secrets) {
      (secret as { value: string }).value = '';
    }

    // ── Step 7: Swap staged → active ──
    state.logger.info('downgrade_swap', 'Swapping staged state to active', { project: slug });
    swapStagedToActive(stagingDir, project.directory, configDir);
    cleanupStaging(stagingDir);

    // ── Step 8: Finalize (tell VPS to archive) ──
    state.logger.info('downgrade_finalize', 'Finalizing with VPS (archive)', { project: slug });

    try {
      await vpsRequest(vpsEndpoint, '/_auth/downgrade/finalize', {
        downgradeId,
        projectSlug: slug,
      }, downgradeToken);
    } catch (err) {
      // Finalize failure is non-fatal — local state is already imported
      // VPS project stays active (user can retry or re-promote)
      state.logger.warn('downgrade_finalize_failed', `VPS finalize failed: ${(err as Error).message}`, { project: slug });
    }

    // ── Step 9: Audit ──
    state.audit.record('downgrade_completed', 'operator', {
      project: slug,
      details: {
        downgradeId,
        secretsExported: receipt.secretsExported,
        rulesExported: receipt.rulesExported,
        gatePoliciesExported: receipt.gatePoliciesExported,
        remoteOnlyNotice: receipt.remoteOnlyNotice,
      },
    });

    state.logger.info('downgrade_complete', `Downgrade successful for ${slug}`, { project: slug });
    return receipt;
  } catch (err) {
    state.audit.record('downgrade_failed', 'daemon', {
      project: slug,
      details: { error: (err as Error).message },
    });
    cleanupStaging(stagingDir);
    throw err;
  } finally {
    releaseLock(slug);
    if (dk) dk.fill(0);
    if (sharedSecret) sharedSecret.fill(0);
    if (kDown) kDown.fill(0);
    if (payloadBuffer) payloadBuffer.fill(0);
  }
}
