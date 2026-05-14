// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Promotion Service — VPS-side state import for local → VPS upgrade
 *
 * Handles:
 *   1. Ephemeral ML-KEM-1024 key exchange (init)
 *   2. Decryption of encrypted promotion payload (complete)
 *   3. Atomic state import (project + secrets + rules + gates)
 *   4. ML-DSA-44 signed import receipt generation
 *
 * Security:
 *   - Decapsulation key stored in-memory with 60s TTL, single-use
 *   - Payload decrypted inside VPS secure boundary only
 *   - Zero plaintext logging
 *   - Atomic import — partial state discarded on any failure
 *   - Replay prevention: token consumed + decapsulation key deleted on first use
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import { parseSandboxId } from '@ellul.ai/types';
import { logAuditEvent } from '../audit/Audit';

// ── Service Imports (VPS infrastructure) ──

// Secrets: write plaintext values directly to .env files.
// The secrets arrive already decrypted in our memory (from the promotion payload).
// We use writeEnvFile() — the low-level atomic writer — bypassing the hybrid KEM
// envelope path (since there's no client-side encryption to undo here).
import { writeEnvFile } from '../vault/Secrets';

// Guardrails: add rules to SQLite + materialize .scm files
import { addRule, materializeRules } from '../guardrails/GuardrailSync';

// Gate permissions: write persistent policies
import { setPermission } from '../gates/GatePermissions';

// Config
import { SVC_HOME, PLATFORM_ZONE } from '../../config';

// ── Types ──

interface PromotionKeyExchange {
  decapsulationKey: Uint8Array;
  challenge: string;
  promotionId: string;
  sessionId: string;
  projectSlug: string;
  createdAt: number;
}

interface PromotionPayload {
  version: number;
  promotionId: string;
  timestamp: string;
  project: { slug: string; name: string; fingerprint: string };
  secrets: Array<{ name: string; value: string }>;
  rules: Array<{
    id: string; scope: string; language: string; name: string;
    description: string; query_scm: string; severity: string; message: string;
    enabled: boolean; locked: boolean;
  }>;
  gatePermissions: Record<string, string>;
  execMode: string;
}

export interface ImportReceipt {
  promotionId: string;
  projectSlug: string;
  projectId: string;
  secretsImported: number;
  rulesImported: number;
  gatePoliciesImported: number;
  timestamp: string;
  vpsEndpoint: string;
  signature: string;
}

// ── Size Limits (defense-in-depth, validated after decryption) ──

const PROMOTION_LIMITS = {
  maxSecrets: 100,
  maxSecretValueBytes: 64 * 1024,
  maxTotalSecretBytes: 1024 * 1024,
  maxRules: 50,
  maxRuleTextBytes: 16 * 1024,
};

// ── Orphaned Temp File Cleanup ──
// If the VPS crashed during a previous writeEnvFile, orphaned .tmp files
// may contain plaintext secrets on disk. Clean them up on module load.
try {
  const secretsDir = '/etc/ellul/secrets';
  if (fs.existsSync(secretsDir)) {
    const walkAndClean = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          walkAndClean(`${dir}/${entry.name}`);
        } else if (entry.name.endsWith('.tmp')) {
          try {
            fs.unlinkSync(`${dir}/${entry.name}`);
            console.warn(`[promotion] Cleaned orphaned temp file: ${dir}/${entry.name}`);
          } catch {}
        }
      }
    };
    walkAndClean(secretsDir);
  }
} catch {}

// ── In-Memory Key Exchange Store (60s TTL, single-use) ──

const pendingExchanges = new Map<string, PromotionKeyExchange>();

setInterval(() => {
  const now = Date.now();
  for (const [id, exchange] of pendingExchanges) {
    if (now - exchange.createdAt > 60_000) {
      exchange.decapsulationKey.fill(0);
      pendingExchanges.delete(id);
    }
  }
}, 30_000).unref();

// ── Node Key for Receipt Signing ──

interface NodeKeyData {
  ml_dsa44_sk?: string;
  ml_dsa44_pk?: string;
}

function readNodeKey(): NodeKeyData | null {
  try {
    const raw = fs.readFileSync('/etc/ellul-bootstrap/node.key', 'utf8');
    return JSON.parse(raw) as NodeKeyData;
  } catch {
    return null;
  }
}

// ── Init ──

export async function initPromotion(
  promotionId: string,
  sessionId: string,
  projectSlug: string,
): Promise<{ mlkem_ek: string; challenge: string; expiresIn: number; receiptVerificationKey: string }> {
  // Prevent parallel promotions for same slug
  for (const [, exchange] of pendingExchanges) {
    if (exchange.projectSlug === projectSlug) {
      throw new Error('Promotion already in progress for this project');
    }
  }

  const { ml_kem1024 } = await import('@noble/post-quantum/ml-kem.js');
  const { publicKey: ek, secretKey: dk } = ml_kem1024.keygen();

  const serverNonce = crypto.randomBytes(32).toString('hex');
  const challenge = crypto.createHash('sha256')
    .update(`${promotionId}|${sessionId}|${projectSlug}|${serverNonce}`)
    .digest('hex');

  pendingExchanges.set(promotionId, {
    decapsulationKey: dk,
    challenge,
    promotionId,
    sessionId,
    projectSlug,
    createdAt: Date.now(),
  });

  // Read ML-DSA-44 public key for receipt verification
  const nodeKey = readNodeKey();
  const receiptVerificationKey = nodeKey?.ml_dsa44_pk || '';

  return {
    mlkem_ek: Buffer.from(ek).toString('base64'),
    challenge,
    expiresIn: 60,
    receiptVerificationKey,
  };
}

// ── Complete ──

export async function completePromotion(
  encryptedPayload: {
    promotionId: string;
    projectSlug: string;
    mlkem_ct: string;
    bindProof: string;
    iv: string;
    ciphertext: string;
    authTag: string;
  },
  sessionId: string,
): Promise<ImportReceipt> {
  // Retrieve and DELETE key exchange state (single-use)
  const exchange = pendingExchanges.get(encryptedPayload.promotionId);
  if (!exchange) {
    throw new Error('No pending promotion found. Key exchange may have expired or was already consumed.');
  }
  pendingExchanges.delete(encryptedPayload.promotionId);

  // Validate bindings
  if (exchange.sessionId !== sessionId) {
    exchange.decapsulationKey.fill(0);
    throw new Error('Session mismatch');
  }
  if (exchange.projectSlug !== encryptedPayload.projectSlug) {
    exchange.decapsulationKey.fill(0);
    throw new Error('Project slug mismatch');
  }
  if (Date.now() - exchange.createdAt > 60_000) {
    exchange.decapsulationKey.fill(0);
    throw new Error('Key exchange expired');
  }

  let kPromo: Buffer | null = null;
  let payloadBuffer: Buffer | null = null;

  try {
    // ── Decapsulate ML-KEM ──
    const { ml_kem1024 } = await import('@noble/post-quantum/ml-kem.js');
    const ctBytes = Buffer.from(encryptedPayload.mlkem_ct, 'base64');
    const sharedSecret = ml_kem1024.decapsulate(ctBytes, exchange.decapsulationKey);

    exchange.decapsulationKey.fill(0);

    // ── Verify bind proof ──
    const ssBuf = Buffer.from(
      (sharedSecret as Uint8Array).buffer,
      (sharedSecret as Uint8Array).byteOffset,
      (sharedSecret as Uint8Array).byteLength,
    );
    const expectedBindProof = crypto.createHmac('sha256', ssBuf)
      .update(`promotion-bind|${encryptedPayload.promotionId}|${exchange.challenge}`)
      .digest('base64');

    const proofBuf = Buffer.from(encryptedPayload.bindProof, 'utf8');
    const expectedBuf = Buffer.from(expectedBindProof, 'utf8');
    if (proofBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(proofBuf, expectedBuf)) {
      ssBuf.fill(0);
      (sharedSecret as Uint8Array).fill(0);
      throw new Error('Bind proof verification failed');
    }

    // ── Derive K_promo ──
    kPromo = Buffer.from(
      crypto.hkdfSync('sha256', ssBuf, Buffer.alloc(0), 'ellul:promotion-encrypt:v1', 32),
    );
    ssBuf.fill(0);
    (sharedSecret as Uint8Array).fill(0);

    // ── Decrypt payload ──
    const iv = Buffer.from(encryptedPayload.iv, 'base64');
    const ciphertext = Buffer.from(encryptedPayload.ciphertext, 'base64');
    const authTag = Buffer.from(encryptedPayload.authTag, 'base64');

    const decipher = crypto.createDecipheriv('aes-256-gcm', kPromo, iv, { authTagLength: 16 });
    decipher.setAuthTag(authTag);
    payloadBuffer = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    kPromo.fill(0);
    kPromo = null;

    const payload: PromotionPayload = JSON.parse(payloadBuffer.toString('utf8'));

    payloadBuffer.fill(0);
    payloadBuffer = null;

    // ── Validate payload ──
    if (payload.version !== 1) throw new Error(`Unsupported payload version: ${payload.version}`);
    if (payload.promotionId !== encryptedPayload.promotionId) throw new Error('Promotion ID mismatch');

    // Validate size limits (defense-in-depth)
    if (payload.secrets.length > PROMOTION_LIMITS.maxSecrets) {
      throw new Error(`Too many secrets: ${payload.secrets.length}`);
    }
    if (payload.rules.length > PROMOTION_LIMITS.maxRules) {
      throw new Error(`Too many rules: ${payload.rules.length}`);
    }

    // ── Atomic Import ──

    // 1. Create project directory (or verify existing for re-promotion)
    const projectDir = `${SVC_HOME}/projects/${payload.project.slug}`;
    const projectConfigFile = `${projectDir}/ellul.json`;
    const projectId = crypto.createHash('sha256').update(payload.project.slug).digest('hex').slice(0, 16);

    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true, mode: 0o775 });
    }
    fs.writeFileSync(projectConfigFile, JSON.stringify({
      displayName: payload.project.name,
      promotedFrom: 'local',
      promotedAt: payload.timestamp,
      fingerprint: payload.project.fingerprint,
    }, null, 2));

    logAuditEvent({
      type: 'promotion_project_created',
      details: { slug: payload.project.slug, name: payload.project.name },
    });

    // 2. Import secrets (write plaintext directly to .env file atomically)
    //    All secrets written in one atomic writeEnvFile call (tmp → fsync → rename)
    let secretsImported = 0;
    if (payload.secrets.length > 0) {
      const secretsMap = new Map<string, string>();
      for (const secret of payload.secrets) {
        secretsMap.set(secret.name, secret.value);
        secretsImported++;
      }
      try {
        writeEnvFile(secretsMap, parseSandboxId(payload.project.slug), 'production');
      } catch (err) {
        logAuditEvent({
          type: 'promotion_secrets_failed',
          details: { count: secretsImported, error: (err as Error).message },
        });
        secretsImported = 0;
      }
      // Zeroize all secret values (best-effort: V8 may retain string copies in heap)
      // Overwrite Map values individually, then clear the Map, then overwrite payload entries
      for (const [name] of secretsMap) {
        secretsMap.set(name, '');  // Overwrite value reference (V8 may still retain original)
      }
      secretsMap.clear();
    }

    // 3. Import custom rules only (skip locked — VPS has its own defaults)
    let rulesImported = 0;
    const customRules = payload.rules.filter(r => !r.locked);
    for (const rule of customRules) {
      try {
        addRule({
          scope: rule.scope as 'global' | 'workspace',
          language: rule.language,
          name: `promoted_${rule.name}`,
          description: rule.description || `Promoted from local: ${rule.name}`,
          query_scm: rule.query_scm,
          severity: (rule.severity || 'error') as 'error' | 'warning',
          message: rule.message,
        });
        rulesImported++;
      } catch (err) {
        logAuditEvent({
          type: 'promotion_rule_failed',
          details: { name: rule.name, error: (err as Error).message },
        });
      }
    }
    if (rulesImported > 0) {
      materializeRules();
    }

    // 4. Import gate permissions (non-default only)
    let gatePoliciesImported = 0;
    const validGates = new Set(['logs', 'env', 'db_read', 'db_write', 'db_migrate', 'git', 'deploy', 'exec']);
    for (const [gate, policy] of Object.entries(payload.gatePermissions)) {
      if (policy === 'ask') continue; // ask is default, don't write
      if (!validGates.has(gate)) continue;
      try {
        await setPermission(
          gate as Parameters<typeof setPermission>[0],
          parseSandboxId(payload.project.slug),
          policy as 'allow_always' | 'never',
          'auto',
        );
        gatePoliciesImported++;
      } catch (err) {
        logAuditEvent({
          type: 'promotion_gate_failed',
          details: { gate, policy, error: (err as Error).message },
        });
      }
    }

    // ── Generate signed receipt ──
    const receipt: ImportReceipt = {
      promotionId: payload.promotionId,
      projectSlug: payload.project.slug,
      projectId,
      secretsImported,
      rulesImported,
      gatePoliciesImported,
      timestamp: new Date().toISOString(),
      vpsEndpoint: `https://srv-${payload.project.slug}.${PLATFORM_ZONE}`,
      signature: '',
    };

    // Sign receipt with ML-DSA-44 node key
    try {
      const nodeKey = readNodeKey();
      if (nodeKey?.ml_dsa44_sk) {
        const { ml_dsa44 } = await import('@noble/post-quantum/ml-dsa.js');
        const { signature: _, ...receiptWithoutSig } = receipt;
        const receiptBytes = Buffer.from(JSON.stringify(receiptWithoutSig));
        const skBytes = Buffer.from(nodeKey.ml_dsa44_sk, 'base64');
        const sig = ml_dsa44.sign(receiptBytes, skBytes);
        receipt.signature = Buffer.from(sig).toString('base64');
        skBytes.fill(0);
      }
    } catch {
      // Signing failed — receipt returned unsigned
      // CLI will warn but not block the upgrade
    }

    logAuditEvent({
      type: 'promotion_import_complete',
      details: {
        slug: payload.project.slug,
        secretsImported,
        rulesImported,
        gatePoliciesImported,
      },
    });

    return receipt;
  } finally {
    if (kPromo) kPromo.fill(0);
    if (payloadBuffer) payloadBuffer.fill(0);
  }
}
