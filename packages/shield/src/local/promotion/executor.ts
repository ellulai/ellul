// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Local→VPS promotion. Gathers state, ML-KEM key exchange, encrypts, sends — all in daemon.
// Plaintext never leaves stack frame as IPC data. Buffer-first; AES-GCM; zeroize after use
// (V8 string zeroization best-effort). Returns only signed ImportReceipt.

import * as crypto from 'crypto';
import * as http from 'http';

import type { LocalDaemonState } from '../daemon/state';
import { getSecretStore } from '../daemon/state';
import type {
  PromotionPayload,
  EncryptedPromotionPayload,
  ImportReceipt,
  PromotionInitResponse,
  PromotionInventory,
} from './types';
import { validatePayloadLimits, PromotionValidationError, PROMOTION_LIMITS } from './types';

// ── Local Promotion Lock ──

const activePromotions = new Set<string>();

export function isPromotionInProgress(slug: string): boolean {
  return activePromotions.has(slug);
}

function acquireLock(slug: string): boolean {
  if (activePromotions.has(slug)) return false;
  activePromotions.add(slug);
  return true;
}

function releaseLock(slug: string): void {
  activePromotions.delete(slug);
}

// ── HTTP Helper (for daemon → VPS calls) ──

function vpsRequest(
  vpsEndpoint: string,
  path: string,
  body: unknown,
  promotionToken: string,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, vpsEndpoint);
    const bodyStr = JSON.stringify(body);

    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(bodyStr)),
        'Authorization': `Bearer ${promotionToken}`,
        'X-Ellul-Promotion': 'v1',
      },
    };

    // Use https for production, http for local dev
    const transport = url.protocol === 'https:'
      ? require('https') as typeof import('https')
      : require('http') as typeof import('http');

    const req = transport.request(options, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
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

// ── Inventory (safe to return to CLI) ──

export function getPromotionInventory(state: LocalDaemonState): PromotionInventory | null {
  const slug = state.registry.getDefaultProject();
  if (!slug) return null;

  const project = state.registry.getProject(slug);
  if (!project) return null;

  const store = getSecretStore(state, slug);
  const secretCount = store?.count() ?? 0;

  const rules = state.ruleStore?.listRules() ?? [];
  const customRules = rules.filter(r => !r.locked);
  const lockedRules = rules.filter(r => r.locked);

  const gateStates = state.gateManager.getGateStates(slug);
  const gatePolicies: Record<string, string> = {};
  for (const g of gateStates) {
    if (g.policy !== 'ask') {
      gatePolicies[g.gate] = g.policy;
    }
  }

  return {
    slug: project.projectSlug,
    name: project.projectName,
    secretCount,
    ruleCount: rules.filter(r => r.enabled).length,
    customRuleCount: customRules.length,
    lockedRuleCount: lockedRules.length,
    gatePolicies,
    execMode: state.execMode,
  };
}

// ── Main Executor ──

export async function executePromotion(
  state: LocalDaemonState,
  promotionToken: string,
  vpsEndpoint: string,
): Promise<ImportReceipt> {
  const slug = state.registry.getDefaultProject();
  if (!slug) throw new PromotionValidationError('No project registered');

  const project = state.registry.getProject(slug);
  if (!project) throw new PromotionValidationError('Project not found in registry');

  // ── Step 1: Acquire lock ──
  if (!acquireLock(slug)) {
    throw new PromotionValidationError(`Promotion already in progress for ${slug}`);
  }

  // All subsequent code must release the lock on exit (success or failure)
  let payloadBuffer: Buffer | null = null;
  let sharedSecret: Uint8Array | null = null;
  let kPromo: Buffer | null = null;

  try {
    const promotionId = crypto.randomBytes(16).toString('hex');

    // ── Step 2: Gather state (all in daemon memory) ──
    const store = getSecretStore(state, slug);
    const secretEntries = store ? store.getAllForRedaction() : [];

    const rules = state.ruleStore?.listRules() ?? [];
    const gateStates = state.gateManager.getGateStates(slug);
    const gatePolicies: Record<string, string> = {};
    for (const g of gateStates) {
      gatePolicies[g.gate] = g.policy;
    }

    // Build payload (plaintext — ONLY in this function's memory)
    const payload: PromotionPayload = {
      version: 1,
      promotionId,
      timestamp: new Date().toISOString(),
      project: {
        slug: project.projectSlug,
        name: project.projectName,
        fingerprint: project.fingerprint,
      },
      secrets: secretEntries.map(s => ({ name: s.name, value: s.value })),
      rules: rules.map(r => ({
        id: r.id,
        scope: r.scope as 'global' | 'workspace',
        language: r.language,
        name: r.name,
        description: r.description,
        query_scm: r.query_scm,
        severity: r.severity as 'error' | 'warning',
        message: r.message,
        enabled: !!r.enabled,
        locked: !!r.locked,
      })),
      gatePermissions: gatePolicies as Record<string, 'ask' | 'allow_always' | 'deny_always'>,
      execMode: state.execMode,
    };

    // ── Step 3: Validate size limits ──
    validatePayloadLimits(payload);

    // ── Step 4: Init ML-KEM key exchange with VPS ──
    state.logger.info('promotion_init', `Initiating key exchange with VPS for ${slug}`, { project: slug });

    const initResponse = await vpsRequest(vpsEndpoint, '/_auth/promotion/init', {
      projectSlug: slug,
      promotionId,
    }, promotionToken);

    if (initResponse.status !== 200) {
      const errData = initResponse.data as { error?: string };
      throw new PromotionValidationError(
        `VPS promotion init failed (${initResponse.status}): ${errData.error || 'Unknown error'}`,
      );
    }

    const initData = initResponse.data as PromotionInitResponse;
    if (!initData.mlkem_ek || !initData.challenge) {
      throw new PromotionValidationError('VPS returned incomplete init response');
    }

    // ── Step 5: Encapsulate + encrypt ──
    state.logger.info('promotion_encrypt', `Encrypting promotion payload`, { project: slug });

    const { ml_kem1024 } = await import('@noble/post-quantum/ml-kem.js');

    const ekBytes = Buffer.from(initData.mlkem_ek, 'base64');
    const { sharedSecret: ss, cipherText } = ml_kem1024.encapsulate(ekBytes);
    sharedSecret = ss;

    // Bind proof: HMAC-SHA256(K, "promotion-bind|" + promotionId + "|" + challenge)
    if (!sharedSecret) throw new PromotionValidationError('ML-KEM encapsulation failed');
    const ssBuf = Buffer.from(sharedSecret.buffer, sharedSecret.byteOffset, sharedSecret.byteLength);
    const bindProof = crypto.createHmac('sha256', ssBuf)
      .update(`promotion-bind|${promotionId}|${initData.challenge}`)
      .digest('base64');

    // Derive promotion key: HKDF-SHA256(K, info="ellul:promotion-encrypt:v1")
    kPromo = Buffer.from(
      crypto.hkdfSync('sha256', ssBuf, Buffer.alloc(0), 'ellul:promotion-encrypt:v1', 32),
    );

    // Zeroize shared secret immediately after derivation
    (sharedSecret as Uint8Array).fill(0);
    sharedSecret = null;

    // Serialize payload to Buffer (JSON string is transient)
    payloadBuffer = Buffer.from(JSON.stringify(payload));

    // Zeroize individual secret values (best-effort for strings)
    for (const secret of payload.secrets) {
      (secret as { value: string }).value = '';
    }

    // Encrypt with AES-256-GCM
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', kPromo, iv, { authTagLength: 16 });
    const encrypted = Buffer.concat([cipher.update(payloadBuffer), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Zeroize payload buffer and K_promo
    payloadBuffer.fill(0);
    payloadBuffer = null;
    kPromo.fill(0);
    kPromo = null;

    // Validate encrypted size
    if (encrypted.length > PROMOTION_LIMITS.maxEncryptedPayloadBytes) {
      throw new PromotionValidationError(
        `Encrypted payload too large: ${encrypted.length} bytes (max ${PROMOTION_LIMITS.maxEncryptedPayloadBytes})`,
      );
    }

    // Build encrypted payload
    const encryptedPayload: EncryptedPromotionPayload = {
      _promotion: true,
      _version: 1,
      promotionId,
      projectSlug: slug,
      mlkem_ct: Buffer.from(cipherText).toString('base64'),
      bindProof,
      iv: iv.toString('base64'),
      ciphertext: encrypted.toString('base64'),
      authTag: authTag.toString('base64'),
    };

    // ── Step 6: Send encrypted payload to VPS ──
    state.logger.info('promotion_send', `Sending encrypted payload to VPS`, { project: slug });

    const completeResponse = await vpsRequest(vpsEndpoint, '/_auth/promotion/complete', encryptedPayload, promotionToken);

    if (completeResponse.status !== 200) {
      const errData = completeResponse.data as { error?: string };
      throw new PromotionValidationError(
        `VPS promotion complete failed (${completeResponse.status}): ${errData.error || 'Unknown error'}`,
      );
    }

    const receipt = completeResponse.data as ImportReceipt;
    if (!receipt.promotionId || !receipt.projectSlug || !receipt.signature) {
      throw new PromotionValidationError('VPS returned invalid import receipt');
    }

    // ── Step 7: Audit + return receipt ──
    state.audit.record('promotion_completed', 'operator', {
      project: slug,
      details: {
        promotionId,
        secretsImported: receipt.secretsImported,
        rulesImported: receipt.rulesImported,
        gatePoliciesImported: receipt.gatePoliciesImported,
        vpsEndpoint: receipt.vpsEndpoint,
      },
    });

    state.logger.info('promotion_complete', `Promotion successful for ${slug}`, {
      project: slug,
      details: {
        secrets: receipt.secretsImported,
        rules: receipt.rulesImported,
        gates: receipt.gatePoliciesImported,
      },
    });

    return receipt;
  } catch (err) {
    // Audit failure
    state.audit.record('promotion_failed', 'daemon', {
      project: slug,
      details: { error: (err as Error).message },
    });
    throw err;
  } finally {
    // ── Always: release lock + zeroize ──
    releaseLock(slug);

    // Zeroize any remaining material
    if (payloadBuffer) { payloadBuffer.fill(0); }
    if (sharedSecret) { (sharedSecret as Uint8Array).fill(0); }
    if (kPromo) { kPromo.fill(0); }
  }
}
