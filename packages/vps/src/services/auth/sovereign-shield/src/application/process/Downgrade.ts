// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Downgrade Service — VPS-side state export for VPS → local repatriation
 *
 * KEY EXCHANGE REVERSED from promotion:
 *   Promotion: VPS generates keypair, local encapsulates TO VPS
 *   Downgrade: LOCAL generates keypair, VPS encapsulates TO LOCAL
 *
 * The local daemon sends its ephemeral ML-KEM public key (ek).
 * VPS encapsulates to ek → derives K_down → encrypts portable state.
 * Only the local daemon (holding dk) can decrypt.
 *
 * Two-phase archive: VPS stays active until local finalizes.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import { parseSandboxId } from '@ellul.ai/types';
import { logAuditEvent } from '../audit/Audit';
import { readSecrets } from '../vault/Secrets';
import { listRules } from '../guardrails/GuardrailSync';
import { SVC_HOME, PLATFORM_ZONE } from '../../config';

// ── Types ──

interface DowngradeKeyExchange {
  mlkem_ek: Buffer;          // LOCAL's public key (we encapsulate to this)
  challenge: string;
  downgradeId: string;
  sessionId: string;
  projectSlug: string;
  createdAt: number;
}

interface DowngradePayload {
  version: 1;
  downgradeId: string;
  timestamp: string;
  project: { slug: string; name: string; fingerprint: string; vpsProjectId: string; previousVpsEndpoint: string };
  secrets: Array<{ name: string; value: string }>;
  rules: Array<{
    id: string; scope: string; language: string; name: string;
    description: string; query_scm: string; severity: string; message: string;
    enabled: boolean; locked: boolean;
  }>;
  gatePermissions: Record<string, string>;
  execMode: string;
  remoteOnlyNotice: {
    hasDatabase: boolean;
    hasDeployments: boolean;
    hasTeamMembers: boolean;
    auditEntryCount: number;
  };
}

export interface DowngradeReceipt {
  downgradeId: string;
  projectSlug: string;
  vpsProjectId: string;
  secretsExported: number;
  rulesExported: number;
  gatePoliciesExported: number;
  remoteOnlyNotice: { hasDatabase: boolean; hasDeployments: boolean; hasTeamMembers: boolean; auditEntryCount: number };
  timestamp: string;
  signature: string;
}

// ── In-Memory Key Exchange Store (60s TTL, single-use) ──

const pendingExchanges = new Map<string, DowngradeKeyExchange>();

setInterval(() => {
  const now = Date.now();
  for (const [id, exchange] of pendingExchanges) {
    if (now - exchange.createdAt > 60_000) {
      pendingExchanges.delete(id);
    }
  }
}, 30_000).unref();

// ── Archived projects tracking ──

const archivedProjects = new Set<string>();

export function isProjectArchived(slug: string): boolean {
  return archivedProjects.has(slug);
}

// ── Node Key ──

function readNodeKey(): { ml_dsa44_sk?: string; ml_dsa44_pk?: string } | null {
  try {
    return JSON.parse(fs.readFileSync('/etc/ellul-bootstrap/node.key', 'utf8'));
  } catch { return null; }
}

// ── Init ──

export async function initDowngrade(
  downgradeId: string,
  sessionId: string,
  projectSlug: string,
  mlkem_ek_base64: string,
): Promise<{ challenge: string; expiresIn: number; receiptVerificationKey: string }> {
  // Prevent parallel downgrades for same slug
  for (const [, exchange] of pendingExchanges) {
    if (exchange.projectSlug === projectSlug) {
      throw new Error('Downgrade already in progress for this project');
    }
  }

  if (archivedProjects.has(projectSlug)) {
    throw new Error('Project is already archived');
  }

  const serverNonce = crypto.randomBytes(32).toString('hex');
  const challenge = crypto.createHash('sha256')
    .update(`${downgradeId}|${sessionId}|${projectSlug}|${serverNonce}`)
    .digest('hex');

  pendingExchanges.set(downgradeId, {
    mlkem_ek: Buffer.from(mlkem_ek_base64, 'base64'),
    challenge,
    downgradeId,
    sessionId,
    projectSlug,
    createdAt: Date.now(),
  });

  const nodeKey = readNodeKey();
  return {
    challenge,
    expiresIn: 60,
    receiptVerificationKey: nodeKey?.ml_dsa44_pk || '',
  };
}

// ── Export ──

export async function exportDowngrade(
  downgradeId: string,
  sessionId: string,
): Promise<{ encryptedPayload: unknown; receipt: DowngradeReceipt }> {
  // Retrieve and DELETE key exchange state (single-use)
  const exchange = pendingExchanges.get(downgradeId);
  if (!exchange) {
    throw new Error('No pending downgrade. Key exchange may have expired.');
  }
  pendingExchanges.delete(downgradeId);

  if (exchange.sessionId !== sessionId) throw new Error('Session mismatch');
  if (Date.now() - exchange.createdAt > 60_000) throw new Error('Key exchange expired');

  const slug = exchange.projectSlug;
  const projectId = crypto.createHash('sha256').update(slug).digest('hex').slice(0, 16);

  let kDown: Buffer | null = null;

  try {
    // ── Gather portable state ──
    const secrets = readSecrets(parseSandboxId(slug), 'production');
    const secretsArray = Array.from(secrets.entries()).map(([name, value]) => ({ name, value }));

    const rules = listRules();
    const rulesArray = rules.map(r => ({
      id: r.id, scope: r.scope, language: r.language, name: r.name,
      description: r.description, query_scm: r.query_scm, severity: r.severity,
      message: r.message, enabled: !!r.enabled, locked: !!r.locked,
    }));

    // Gate permissions — read from file
    let gatePermissions: Record<string, string> = {};
    try {
      const gpPath = '/etc/ellul/shield-data/gate-permissions.json';
      if (fs.existsSync(gpPath)) {
        const gpData = JSON.parse(fs.readFileSync(gpPath, 'utf8'));
        if (gpData.apps?.[slug]) {
          for (const [gate, entry] of Object.entries(gpData.apps[slug] as Record<string, { permission: string }>)) {
            gatePermissions[gate] = entry.permission;
          }
        }
      }
    } catch {}

    // Remote-only notice
    const remoteOnlyNotice = {
      hasDatabase: fs.existsSync(`/var/lib/postgresql/16/main/base`),
      hasDeployments: fs.existsSync(`/etc/caddy/app-routes.d/${slug}.caddy`),
      hasTeamMembers: false, // TODO: check org config
      auditEntryCount: 0,   // TODO: count audit entries
    };

    // Build payload
    const payload: DowngradePayload = {
      version: 1,
      downgradeId,
      timestamp: new Date().toISOString(),
      project: {
        slug,
        name: slug, // TODO: read display name from project config
        fingerprint: '', // Will be set by local daemon
        vpsProjectId: projectId,
        previousVpsEndpoint: `https://srv-${slug}.${PLATFORM_ZONE}`,
      },
      secrets: secretsArray,
      rules: rulesArray,
      gatePermissions,
      execMode: 'capability', // TODO: read from project config
      remoteOnlyNotice,
    };

    // ── Encapsulate to LOCAL's ek ──
    const { ml_kem1024 } = await import('@noble/post-quantum/ml-kem.js');
    const { sharedSecret, cipherText } = ml_kem1024.encapsulate(exchange.mlkem_ek);

    const ssBuf = Buffer.from(
      (sharedSecret as Uint8Array).buffer,
      (sharedSecret as Uint8Array).byteOffset,
      (sharedSecret as Uint8Array).byteLength,
    );

    // Bind proof
    const bindProof = crypto.createHmac('sha256', ssBuf)
      .update(`downgrade-bind|${downgradeId}|${exchange.challenge}`)
      .digest('base64');

    // Derive K_down
    kDown = Buffer.from(
      crypto.hkdfSync('sha256', ssBuf, Buffer.alloc(0), 'ellul:downgrade-encrypt:v1', 32),
    );
    ssBuf.fill(0);
    (sharedSecret as Uint8Array).fill(0);

    // Encrypt payload
    const payloadBuffer = Buffer.from(JSON.stringify(payload));

    // Zeroize secrets from payload object
    for (const s of payload.secrets) { (s as { value: string }).value = ''; }
    // Zeroize from gathered map
    for (const [name] of secrets) { secrets.set(name, ''); }
    secrets.clear();

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', kDown, iv, { authTagLength: 16 });
    const encrypted = Buffer.concat([cipher.update(payloadBuffer), cipher.final()]);
    const authTag = cipher.getAuthTag();

    payloadBuffer.fill(0);
    kDown.fill(0);
    kDown = null;

    const encryptedPayload = {
      _downgrade: true,
      _version: 1,
      downgradeId,
      projectSlug: slug,
      mlkem_ct: Buffer.from(cipherText).toString('base64'),
      bindProof,
      iv: iv.toString('base64'),
      ciphertext: encrypted.toString('base64'),
      authTag: authTag.toString('base64'),
    };

    // ── Sign receipt ──
    const receipt: DowngradeReceipt = {
      downgradeId,
      projectSlug: slug,
      vpsProjectId: projectId,
      secretsExported: secretsArray.length,
      rulesExported: rulesArray.filter(r => !r.locked).length,
      gatePoliciesExported: Object.entries(gatePermissions).filter(([, p]) => p !== 'ask').length,
      remoteOnlyNotice,
      timestamp: new Date().toISOString(),
      signature: '',
    };

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
    } catch {}

    logAuditEvent({
      type: 'downgrade_export_complete',
      details: {
        slug, downgradeId,
        secretsExported: receipt.secretsExported,
        rulesExported: receipt.rulesExported,
      },
    });

    return { encryptedPayload, receipt };
  } finally {
    if (kDown) kDown.fill(0);
  }
}

// ── Finalize (archive project) ──

export async function finalizeDowngrade(
  downgradeId: string,
  projectSlug: string,
): Promise<{ archived: boolean }> {
  // Mark project as archived
  archivedProjects.add(projectSlug);

  logAuditEvent({
    type: 'downgrade_finalized',
    details: { slug: projectSlug, downgradeId },
  });

  return { archived: true };
}
