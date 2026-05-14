// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Secrets Routes
 *
 * Environment secrets management — decrypt and write to /etc/ellul/secrets/{sandboxId}[.dev].env.
 * Secrets arrive encrypted (RSA-OAEP + AES-256-GCM) from the browser
 * and are decrypted locally using the VPS private key.
 *
 * All endpoints accept an optional `env` parameter ('production' | 'development').
 * Defaults to 'production' for backward compatibility.
 *
 * Auth enforced by tier-gate middleware (SESSION routes).
 *
 * Endpoints:
 * - GET    /_auth/secrets              - List secret names (no values)
 * - POST   /_auth/secrets              - Set a single secret
 * - POST   /_auth/secrets/bulk         - Set multiple secrets atomically
 * - DELETE /_auth/secrets/:name        - Delete a secret
 * - GET    /_auth/secrets/environments - List which environments have secrets
 * - GET    /_auth/secrets/exposures    - Get exposure tracking status
 * - PUT    /_auth/secrets/classify     - Classify a secret as 'secret' or 'plain'
 * - POST   /_auth/secrets/acknowledge  - Acknowledge an exposure warning
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import type { Hono } from 'hono';
import { z } from 'zod';
import { SandboxIdSchema, type SandboxId } from '@ellul.ai/types';
import { getClientIp } from '../auth/fingerprint';
import { logAuditEvent } from '../application/audit/Audit';
import { checkApiRateLimit } from '../application/platform/RateLimiter';
import {
  setSecret,
  setSecretsBulk,
  deleteSecret,
  listSecrets,
  listEnvironments,
  readSecrets,
  isValidEnvironment,
  type SecretEnvironment,
  type HybridKemEncryptedEnvelope,
} from '../application/vault/Secrets';
import {
  getExposures,
  getClassifications,
  classifySecret,
  acknowledgeExposure,
} from '../application/audit/Exposure';
import {
  grantCrossProjectAccess,
  revokeCrossProjectAccess,
  listAllCrossProjectAccess,
} from '../application/organization/CrossProject';

const SECRET_NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function validateEnvelope(body: any): boolean {
  return (
    body?._pqc === 3 &&
    typeof body?.x25519_eph_pub === 'string' &&
    typeof body?.mlkem_ct === 'string' &&
    typeof body?.iv === 'string' &&
    typeof body?.encryptedData === 'string'
  );
}

/** Parse and validate the env query/body param. Defaults to 'production'. */
function parseEnv(value: string | undefined | null): SecretEnvironment {
  if (!value) return 'production';
  if (isValidEnvironment(value)) return value;
  return 'production';
}

/**
 * Register secrets routes on Hono app
 */
export function registerSecretsRoutes(app: Hono): void {

  /**
   * Return the VPS public key in PEM format.
   * Derived from the RSA private key at /etc/ellul-bootstrap/node.key.
   * Used by clients to encrypt secrets before sending to the VPS.
   */
  app.get('/_auth/secrets/public-key', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    try {
      const privatePem = fs.readFileSync('/etc/ellul-bootstrap/node.key', 'utf8');
      const privateKey = crypto.createPrivateKey(privatePem);
      const publicKey = crypto.createPublicKey(privateKey);
      const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
      return c.json({ publicKey: publicKeyPem });
    } catch (err) {
      return c.json({ error: 'Failed to read public key' }, 500);
    }
  });

  /**
   * List secret names with classifications (no values exposed).
   *   ?sandboxId=sbx-xxxxxxx&env=development — names for that sandbox+env.
   *   (no sandboxId)                          — every sandbox grouped by slug.
   *
   * When `sandboxId` is specified the response also includes classifications:
   *   { names: string[], classifications: Record<string, 'secret' | 'plain'> }
   */
  app.get('/_auth/secrets', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const rawSandbox = c.req.query('sandboxId');
    const env = parseEnv(c.req.query('env'));

    let sandboxId: SandboxId | undefined;
    if (rawSandbox !== undefined) {
      const parsed = SandboxIdSchema.safeParse(rawSandbox);
      if (!parsed.success) {
        return c.json({ error: 'Invalid sandboxId', code: 'INVALID_SANDBOX_ID' }, 400);
      }
      sandboxId = parsed.data;
    }

    const names = listSecrets(sandboxId, env);
    if (sandboxId && Array.isArray(names)) {
      const classifications = getClassifications(sandboxId);
      return c.json({ names, classifications });
    }
    return c.json({ names });
  });

  /**
   * Read decrypted secret values for a sandbox.
   *   ?sandboxId=sbx-xxxxxxx&env=development → { values: Record<string, string> }
   * Requires authenticated session (enforced by tier-gate middleware).
   */
  app.get('/_auth/secrets/values', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const parsed = SandboxIdSchema.safeParse(c.req.query('sandboxId'));
    if (!parsed.success) {
      return c.json({ error: 'Invalid or missing sandboxId', code: 'INVALID_SANDBOX_ID' }, 400);
    }
    const sandboxId = parsed.data;

    const env = parseEnv(c.req.query('env'));
    const secrets = readSecrets(sandboxId, env);
    const values: Record<string, string> = {};
    for (const [k, v] of secrets) values[k] = v;

    logAuditEvent({
      type: 'secrets_read_values',
      ip,
      sandboxId,
      details: { env, count: secrets.size },
    });
    return c.json({ values });
  });

  /**
   * List which environments have secrets for a sandbox.
   *   ?sandboxId=sbx-xxxxxxx → { production: true, development: false }
   */
  app.get('/_auth/secrets/environments', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const parsed = SandboxIdSchema.safeParse(c.req.query('sandboxId'));
    if (!parsed.success) {
      return c.json({ error: 'Invalid or missing sandboxId', code: 'INVALID_SANDBOX_ID' }, 400);
    }
    const environments = listEnvironments(parsed.data);
    return c.json({ environments });
  });

  /**
   * Set a single secret
   */
  app.post('/_auth/secrets', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.name !== 'string') {
      return c.json({ error: 'Missing name' }, 400);
    }

    if (!SECRET_NAME_REGEX.test(body.name)) {
      return c.json({ error: 'Invalid name. Must start with a letter or underscore, and contain only letters, digits, or underscores.' }, 400);
    }

    if (!validateEnvelope(body)) {
      return c.json({ error: 'Missing PQC envelope fields (_pqc, x25519_eph_pub, mlkem_ct, iv, encryptedData)' }, 400);
    }

    const sandboxParsed = SandboxIdSchema.safeParse(body.sandboxId);
    if (!sandboxParsed.success) {
      return c.json({ error: 'Invalid or missing sandboxId', code: 'INVALID_SANDBOX_ID' }, 400);
    }
    const sandboxId = sandboxParsed.data;
    const env = parseEnv(body.env);
    const kind = body.kind === 'plain' ? 'plain' : 'secret';

    try {
      setSecret(body.name, body, sandboxId, env);
      // Classify atomically on creation so the UI reflects the correct type immediately
      if (kind === 'plain') {
        classifySecret(sandboxId, body.name, 'plain');
      }
      logAuditEvent({
        type: 'secret.set',
        ip,
        sandboxId,
        details: { name: body.name, env, kind },
      });
      return c.json({ success: true });
    } catch (err) {
      console.error('[shield] Failed to set secret:', (err as Error).message);
      logAuditEvent({
        type: 'secret.set_failed',
        ip,
        sandboxId,
        details: { name: body.name, env, error: (err as Error).message },
      });
      return c.json({ error: 'Failed to set secret' }, 500);
    }
  });

  /**
   * Set multiple secrets atomically
   */
  app.post('/_auth/secrets/bulk', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.secrets)) {
      return c.json({ error: 'Missing secrets array' }, 400);
    }

    const items: Array<{ name: string; envelope: HybridKemEncryptedEnvelope }> = [];
    for (const secret of body.secrets) {
      if (typeof secret.name !== 'string' || !SECRET_NAME_REGEX.test(secret.name)) {
        return c.json({ error: 'Invalid secret name' }, 400);
      }
      if (!validateEnvelope(secret)) {
        return c.json({ error: 'Missing secret envelope' }, 400);
      }
      items.push({ name: secret.name, envelope: secret });
    }

    const sandboxParsed = SandboxIdSchema.safeParse(body.sandboxId);
    if (!sandboxParsed.success) {
      return c.json({ error: 'Invalid or missing sandboxId', code: 'INVALID_SANDBOX_ID' }, 400);
    }
    const sandboxId = sandboxParsed.data;
    const env = parseEnv(body.env);

    try {
      setSecretsBulk(items, sandboxId, env);
      logAuditEvent({
        type: 'secrets_bulk_set',
        ip,
        sandboxId,
        details: { count: items.length, names: items.map((i) => i.name), env },
      });
      return c.json({ success: true, count: items.length });
    } catch (err) {
      console.error('[shield] Failed to set secrets (bulk):', (err as Error).message);
      logAuditEvent({
        type: 'secrets_bulk_set_failed',
        ip,
        sandboxId,
        details: { env, error: (err as Error).message },
      });
      return c.json({ error: 'Failed to set secrets' }, 500);
    }
  });

  /**
   * Delete a secret
   */
  app.delete('/_auth/secrets/:name', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const name = c.req.param('name');
    const sandboxParsed = SandboxIdSchema.safeParse(c.req.query('sandboxId'));
    if (!sandboxParsed.success) {
      return c.json({ error: 'Invalid or missing sandboxId', code: 'INVALID_SANDBOX_ID' }, 400);
    }
    const sandboxId = sandboxParsed.data;
    const env = parseEnv(c.req.query('env'));
    const existed = deleteSecret(name, sandboxId, env);

    logAuditEvent({
      type: 'secret.delete',
      ip,
      sandboxId,
      details: { name, env, existed },
    });
    return c.json({ success: true, existed });
  });

  // =========================================================================
  // Phase 4: Secret Exposure Tracking
  //
  // Track which secrets the agent has seen through env gate operations.
  // Informational — helps users decide when to rotate secrets.
  // =========================================================================

  /**
   * Get exposure status for an app's secrets.
   * Returns which keys were seen by the agent and whether the value has changed since.
   * Never returns the actual hash — only whether it matches the current value.
   */
  app.get('/_auth/secrets/exposures', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const parsed = SandboxIdSchema.safeParse(c.req.query('sandboxId'));
    if (!parsed.success) {
      return c.json({ error: 'Invalid or missing sandboxId', code: 'INVALID_SANDBOX_ID' }, 400);
    }
    const exposures = getExposures(parsed.data);
    return c.json({ exposures });
  });

  /**
   * Classify an env var as 'secret' or 'plain'.
   * 'plain' vars don't show rotation indicators.
   */
  app.put('/_auth/secrets/classify', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const body = await c.req.json().catch(() => null);
    const bodySchema = z.object({
      sandboxId: SandboxIdSchema,
      keyName: z.string().min(1),
      kind: z.enum(['secret', 'plain']),
    });
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' }, 400);
    }
    const { sandboxId, keyName, kind } = parsed.data;

    classifySecret(sandboxId, keyName, kind);
    logAuditEvent({
      type: 'secret.classify',
      ip,
      sandboxId,
      details: { keyName, kind },
    });
    return c.json({ success: true });
  });

  /**
   * Acknowledge an exposure warning without rotating.
   * Suppresses the rotation indicator until the value changes again.
   */
  app.post('/_auth/secrets/acknowledge', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const body = await c.req.json().catch(() => null);
    const bodySchema = z.object({
      sandboxId: SandboxIdSchema,
      keyName: z.string().min(1),
    });
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' }, 400);
    }
    const { sandboxId, keyName } = parsed.data;

    const acknowledged = acknowledgeExposure(sandboxId, keyName);
    if (!acknowledged) {
      return c.json({ error: 'No exposure record found' }, 404);
    }

    logAuditEvent({
      type: 'secret.acknowledge_exposure',
      ip,
      sandboxId,
      details: { keyName },
    });
    return c.json({ success: true });
  });

  // =========================================================================
  // Phase 5: Cross-Project Read Access (browser-authenticated)
  //
  // Browser-side management of cross-project access rules.
  // These mirror the internal routes but use browser session auth.
  // =========================================================================

  /**
   * Get all cross-project access rules.
   */
  app.get('/_auth/cross-project-access', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    const rules = listAllCrossProjectAccess();
    return c.json({
      rules: rules.map((r) => ({
        sandboxId: r.sandboxId,
        sharedSandboxId: r.sharedSandboxId,
        grantedAt: r.grantedAt,
        sharePreview: r.sharePreview,
      })),
    });
  });

  /**
   * Grant cross-project read access (with optional preview sharing).
   */
  const xprojectGrantSchema = z.object({
    sandboxId: SandboxIdSchema,
    sharedSandboxId: SandboxIdSchema,
    sharePreview: z.boolean().optional().default(false),
  });

  app.post('/_auth/cross-project-access', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    const raw = await c.req.json().catch(() => null);
    const parsed = xprojectGrantSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' }, 400);
    }
    const { sandboxId, sharedSandboxId, sharePreview } = parsed.data;

    try {
      grantCrossProjectAccess(sandboxId, sharedSandboxId, sharePreview);
      logAuditEvent({
        type: 'xproject.grant',
        ip,
        sandboxId,
        details: { sharedSandboxId, sharePreview },
      });
      return c.json({ success: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  /**
   * Revoke cross-project read access.
   */
  const xprojectRevokeSchema = z.object({
    sandboxId: SandboxIdSchema,
    sharedSandboxId: SandboxIdSchema,
  });

  app.delete('/_auth/cross-project-access', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) return c.json({ error: 'Rate limit exceeded' }, 429);

    const raw = await c.req.json().catch(() => null);
    const parsed = xprojectRevokeSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' }, 400);
    }
    const { sandboxId, sharedSandboxId } = parsed.data;

    try {
      const revoked = revokeCrossProjectAccess(sandboxId, sharedSandboxId);
      if (!revoked) return c.json({ error: 'No such access rule' }, 404);
      logAuditEvent({
        type: 'xproject.revoke',
        ip,
        sandboxId,
        details: { sharedSandboxId },
      });
      return c.json({ success: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });
}
