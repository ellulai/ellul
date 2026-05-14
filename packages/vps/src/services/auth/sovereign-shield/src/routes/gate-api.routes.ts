// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Gate API Routes — SSE-based gate management for VS Code extension + CLI
 *
 * Replaces WebSocket-based gate flow with HTTP SSE + REST endpoints.
 * Agents request gates via auth proxy, extension/REPL receives notifications
 * via SSE stream and responds via REST.
 *
 * Project Identity:
 *   Project identity is resolved exclusively from the cryptographically
 *   verified STS token (X-STS-Token header, validated by tier-gate middleware).
 *   All projects use immutable slugs (sbx-{7char}).
 *
 * Endpoints:
 * - POST /_auth/gates/request           - Agent requests a gate
 * - GET  /_auth/gates/stream?project=X  - SSE stream for gate events
 * - POST /_auth/gates/respond           - Extension/REPL approves/denies (operator sig required)
 * - POST /_auth/gates/bind-operator     - Atomic CAS bind of operator + intent
 *                                         (ML-DSA-44, SLH-DSA-128s) pubkeys, nonce-gated
 * - GET  /_auth/gates/operator-status   - Report bind state of the three signing keys
 * - GET  /_auth/gates/bind-nonce        - Fetch the one-time bind nonce
 * - POST /_auth/gates/permissions       - Set gate permission policy (operator sig required)
 * - POST /_auth/gates/revoke            - Revoke a gate (operator sig required)
 * - GET  /_auth/gates/active?project=X  - List active gates
 * - GET  /_auth/gates/request/:id/status - Poll gate request status
 */

import crypto from 'crypto';
import type { Hono } from 'hono';

import { parseSandboxId, type SandboxId } from '@ellul.ai/types';
import { db } from '../database';
import { getClientIp } from '../auth/fingerprint';
import { checkApiRateLimit } from '../application/platform/RateLimiter';
import { logAuditEvent } from '../application/audit/Audit';
import { grantGateForApp, revokeGateForApp, isGateOpenForApp } from '../application/gates/Gate';
import { shouldAutoGrant, shouldAutoDeny, getPermission, setPermission, setSessionPermission, VALID_GATE_TYPES } from '../application/gates/GatePermissions';
import type { GateType, GatePermission } from '../application/gates/GatePermissions';
import {
  GATE_PENDING_TTL_MS,
  GATE_GRANT_TIMED_DEFAULT_MS,
  GATE_GRANT_SESSION_MS,
  GATE_GRANT_ALWAYS_MS,

} from '../config';
import { getRequiredSignatureType } from '@ellul.ai/pqc-types';
import { runScopeCheck } from '../application/gates/GateScopeCheck';
import { verifyOperatorSignature } from '../application/platform/OperatorSignature';
import { getCurrentTier } from '../application/gates/Tier';

// ── Pending gate requests (5-min TTL) ──

interface PendingRequest {
  requestId: string;
  gate: GateType;
  reason: string;
  project: string;
  createdAt: number;
  status: 'pending' | 'granted' | 'denied';
  grantScope?: 'timed' | 'session' | 'always';
  expiresAt?: number;
}

const pendingRequests = new Map<string, PendingRequest>();

// Cleanup expired pending requests every 30s
setInterval(() => {
  const now = Date.now();
  for (const [id, req] of pendingRequests) {
    if (now - req.createdAt > GATE_PENDING_TTL_MS) {
      pendingRequests.delete(id);
    }
  }
}, 30_000);

/**
 * Resolve the sandbox identity from the STS token. The STS token is
 * cryptographically verified upstream by tier-gate middleware; we brand
 * the slug here via `parseSandboxId` so every downstream call receives
 * a validated `SandboxId`. Returns null if no STS token is present — the
 * caller must reject the request (there is no client-supplied fallback).
 */
function resolveProject(c: { get: (key: string) => unknown }): { project: SandboxId } | null {
  const stsSlug = c.get('stsProject') as string | undefined;
  if (!stsSlug) return null;
  try {
    return { project: parseSandboxId(stsSlug) };
  } catch {
    return null;
  }
}

async function notifyBridgeGateResolved(params: {
  threadId: string; gate: string; sandboxId: string;
  requestId: string; action: string; expiresAt?: number;
}): Promise<void> {
  const body = JSON.stringify(params);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch('http://127.0.0.1:7700/api/internal/gate-resolved', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
  }
  console.error(`[Shield] gate-resolved notification failed after 5 attempts (${params.requestId})`);
}

// ── Operator + Intent Signature Verification (PQC: SLH-DSA-SHA2-128s / ML-DSA-44) ──
// Gate control operations (respond, permissions, revoke) require a signature
// from the operator key bound to the session; classified actions additionally
// require an intent signature. The operator private key exists ONLY in the
// browser's volatile RAM — MCP subprocesses cannot access it. This makes agent
// self-approval mathematically impossible.
//
// The operator verifier itself lives in services/operator-signature.service.ts
// (shared with context.routes.ts and any other operator-signed surface).

/**
 * Verify intent signature for classified (high-risk) actions.
 * Dispatches to ML-DSA-44 or SLH-DSA-SHA2-128s based on action classification.
 *
 * Intent signatures bind a user's explicit intent to a specific action,
 * preventing agents from performing high-risk operations without consent.
 *
 * FAIL-CLOSED: Unknown actions, missing keys, mismatched types all reject.
 * There is no default algorithm. Every classified action has an explicit required type.
 */
async function verifyIntentSignature(
  sessionId: string,
  action: string,
  resource: string | null,
  intentSignature: string,
  intentNonce: string,
  intentType: string | null,
  ip: string,
): Promise<string | null> {
  // Determine required signature type for this action
  const requiredType = getRequiredSignatureType(action);
  if (!requiredType) {
    // Action is in CLASSIFIED_ACTIONS but has no entry in REQUIRES_INTENT_SIGNATURE — config bug
    logAuditEvent({ type: 'intent_config_error', ip, details: { action, error: 'no_required_type_mapping' } });
    return `Internal error: action '${action}' is classified but has no required signature type mapping`;
  }

  // Reject unsupported X-Intent-Type values
  if (intentType && intentType !== 'mldsa44' && intentType !== 'slhdsa128s') {
    return `Unsupported intent signature type: '${intentType}'. Must be 'mldsa44' or 'slhdsa128s'`;
  }

  // Reject mismatched signature type — client must send the correct algorithm
  if (intentType && intentType !== requiredType) {
    logAuditEvent({ type: 'intent_type_mismatch', ip, details: { action, required: requiredType, provided: intentType } });
    return `Action '${action}' requires ${requiredType} intent signature, but client sent ${intentType}`;
  }

  // Look up the appropriate intent public key from session
  const row = db.prepare('SELECT intent_public_key, intent_slhdsa_public_key FROM sessions WHERE id = ?')
    .get(sessionId) as { intent_public_key: string | null; intent_slhdsa_public_key: string | null } | undefined;

  if (!row) {
    return 'Session not found';
  }

  const publicKeyBase64 = requiredType === 'slhdsa128s'
    ? row.intent_slhdsa_public_key
    : row.intent_public_key;

  if (!publicKeyBase64) {
    return `${requiredType} intent key not bound to session — complete ML-KEM bind with intent keys first`;
  }

  // Verify and consume nonce (atomic: prevents replay)
  // Nonce scoping: (session_id, nonce, action) — a nonce for wallet_spend cannot replay for db_write
  const nonceRow = db.prepare(
    'DELETE FROM intent_nonces WHERE nonce = ? AND session_id = ? AND action = ? AND expires_at > ? RETURNING nonce'
  ).get(intentNonce, sessionId, action, Date.now()) as { nonce: string } | undefined;

  if (!nonceRow) {
    logAuditEvent({ type: 'intent_nonce_invalid', ip, details: { action, nonce: intentNonce } });
    return 'Invalid or expired intent nonce';
  }

  // Build canonical intent payload
  const intentPayload = `intent|${action}|${resource || ''}|${intentNonce}`;

  try {
    const publicKeyBytes = Buffer.from(publicKeyBase64, 'base64');
    const signatureBytes = Buffer.from(intentSignature, 'base64');
    const messageBytes = Buffer.from(intentPayload);

    let valid: boolean;

    // noble API: verify(signature, message, publicKey)
    if (requiredType === 'slhdsa128s') {
      const { slh_dsa_sha2_128s } = await import('@noble/post-quantum/slh-dsa.js');
      valid = slh_dsa_sha2_128s.verify(signatureBytes, messageBytes, publicKeyBytes);
    } else {
      const { ml_dsa44 } = await import('@noble/post-quantum/ml-dsa.js');
      valid = ml_dsa44.verify(signatureBytes, messageBytes, publicKeyBytes);
    }

    if (!valid) {
      logAuditEvent({ type: 'intent_sig_invalid', ip, details: { action, resource, sigType: requiredType } });
      return `Invalid intent signature (${requiredType})`;
    }
    return null;
  } catch (e) {
    logAuditEvent({ type: 'intent_sig_error', ip, details: { error: (e as Error).message, sigType: requiredType } });
    return `Intent signature verification error (${requiredType})`;
  }
}

/** Actions that require intent signatures (classified actions).
 * INVARIANT: Every entry here MUST have a corresponding entry in REQUIRES_INTENT_SIGNATURE (pqc-types).
 * Validated at module load time by the assertion below. */
const CLASSIFIED_ACTIONS: Set<string> = new Set([
  'wallet_spend',
  'deploy',
  'db_migrate',
  'db_write',
  'git_push_external',
  'exec',
]);

// Startup assertion: verify CLASSIFIED_ACTIONS and REQUIRES_INTENT_SIGNATURE are in sync
for (const action of CLASSIFIED_ACTIONS) {
  if (!getRequiredSignatureType(action)) {
    throw new Error(
      `FATAL: CLASSIFIED_ACTIONS contains '${action}' but REQUIRES_INTENT_SIGNATURE has no mapping for it. ` +
      `This is a configuration bug — every classified action must have an explicit required signature type.`
    );
  }
}

/**
 * Register gate API routes on Hono app
 */
export function registerGateApiRoutes(app: Hono): void {

  // ── Bind Browser Signing Keys ──

  /**
   * Bind the full set of browser-held signing pubkeys to the current session:
   *
   *   operatorPublicKey          — SLH-DSA-SHA2-128s (32 B), signs gate control
   *   intentMldsa44PublicKey     — ML-DSA-44 (1312 B), signs intent for
   *                                db_write / git_push_external / exec
   *   intentSlhdsa128sPublicKey  — SLH-DSA-SHA2-128s (32 B), signs intent for
   *                                wallet_spend / deploy / db_migrate
   *
   * All three bind atomically under the one-time operatorBindNonce — there is
   * no lazy follow-up intent-key rebind path. Sessions either have all three
   * keys bound or none.
   */
  app.post('/_auth/gates/bind-operator', async (c) => {
    const ip = getClientIp(c);
    const body = await c.req.json().catch(() => null) as {
      operatorPublicKey?: string;
      operatorBindNonce?: string;
      intentMldsa44PublicKey?: string;
      intentSlhdsa128sPublicKey?: string;
    } | null;

    if (!body?.operatorPublicKey || !body?.operatorBindNonce ||
        !body?.intentMldsa44PublicKey || !body?.intentSlhdsa128sPublicKey) {
      return c.json({
        error: 'Missing one of: operatorPublicKey, operatorBindNonce, intentMldsa44PublicKey, intentSlhdsa128sPublicKey',
      }, 400);
    }

    const auth = c.get('tierGateAuth') as { sessionId?: string } | undefined;
    const sessionId = auth?.sessionId;
    if (!sessionId) {
      return c.json({ error: 'Session required' }, 401);
    }

    const session = db.prepare('SELECT operator_bind_nonce, operator_public_key FROM sessions WHERE id = ?')
      .get(sessionId) as { operator_bind_nonce: string | null; operator_public_key: string | null } | undefined;

    if (!session) {
      return c.json({ error: 'Session not found' }, 401);
    }

    if (!session.operator_bind_nonce) {
      return c.json({ error: 'Bind nonce expired or already consumed' }, 403);
    }

    const nonceBuffer = Buffer.from(session.operator_bind_nonce, 'utf8');
    const providedBuffer = Buffer.from(body.operatorBindNonce, 'utf8');
    if (nonceBuffer.length !== providedBuffer.length ||
        !crypto.timingSafeEqual(nonceBuffer, providedBuffer)) {
      logAuditEvent({ type: 'operator_bind_nonce_mismatch', ip, sessionId });
      return c.json({ error: 'Invalid bind nonce' }, 403);
    }

    const operatorBytes = Buffer.from(body.operatorPublicKey, 'base64');
    if (operatorBytes.length !== 32) {
      logAuditEvent({ type: 'operator_bind_invalid_key_size', ip, sessionId, details: { size: operatorBytes.length, key: 'operator' } });
      return c.json({ error: `Invalid SLH-DSA-SHA2-128s operator public key size: expected 32 bytes, got ${operatorBytes.length}` }, 400);
    }
    const mldsaBytes = Buffer.from(body.intentMldsa44PublicKey, 'base64');
    if (mldsaBytes.length !== 1312) {
      logAuditEvent({ type: 'operator_bind_invalid_key_size', ip, sessionId, details: { size: mldsaBytes.length, key: 'intentMldsa44' } });
      return c.json({ error: `Invalid ML-DSA-44 intent public key size: expected 1312 bytes, got ${mldsaBytes.length}` }, 400);
    }
    const slhdsaBytes = Buffer.from(body.intentSlhdsa128sPublicKey, 'base64');
    if (slhdsaBytes.length !== 32) {
      logAuditEvent({ type: 'operator_bind_invalid_key_size', ip, sessionId, details: { size: slhdsaBytes.length, key: 'intentSlhdsa128s' } });
      return c.json({ error: `Invalid SLH-DSA-SHA2-128s intent public key size: expected 32 bytes, got ${slhdsaBytes.length}` }, 400);
    }

    const bindResult = db.prepare(`
      UPDATE sessions SET
        operator_public_key = ?,
        intent_public_key = ?,
        intent_slhdsa_public_key = ?,
        operator_bind_nonce = NULL
      WHERE id = ? AND operator_bind_nonce IS NOT NULL
    `).run(
      body.operatorPublicKey,
      body.intentMldsa44PublicKey,
      body.intentSlhdsa128sPublicKey,
      sessionId,
    );
    if (bindResult.changes === 0) {
      logAuditEvent({ type: 'operator_bind_race_rejected', ip, sessionId });
      return c.json({ error: 'Bind nonce already consumed (concurrent bind rejected)' }, 409);
    }

    logAuditEvent({
      type: 'operator_key_bound',
      ip,
      sessionId,
      details: {
        operatorPrefix: body.operatorPublicKey.substring(0, 20) + '...',
        mldsa44Prefix: body.intentMldsa44PublicKey.substring(0, 20) + '...',
        slhdsa128sPrefix: body.intentSlhdsa128sPublicKey.substring(0, 20) + '...',
      },
    });

    return c.json({ status: 'bound' });
  });

  /**
   * Report whether this session has the full browser signing-key set bound.
   * `bound` reflects operator + both intent keys as one unit — partial binds
   * are unreachable given the atomic bind path above.
   */
  app.get('/_auth/gates/operator-status', (c) => {
    const auth = c.get('tierGateAuth') as { sessionId?: string } | undefined;
    const sessionId = auth?.sessionId;
    if (!sessionId) return c.json({ error: 'Session required' }, 401);
    const row = db.prepare('SELECT operator_public_key, intent_public_key, intent_slhdsa_public_key FROM sessions WHERE id = ?')
      .get(sessionId) as {
        operator_public_key: string | null;
        intent_public_key: string | null;
        intent_slhdsa_public_key: string | null;
      } | undefined;
    if (!row) return c.json({ bound: false });
    const bound = row.operator_public_key !== null &&
                  row.intent_public_key !== null &&
                  row.intent_slhdsa_public_key !== null;
    return c.json({
      bound,
      ...(row.operator_public_key ? { publicKey: row.operator_public_key } : {}),
      ...(row.intent_public_key ? { intentMldsa44PublicKey: row.intent_public_key } : {}),
      ...(row.intent_slhdsa_public_key ? { intentSlhdsa128sPublicKey: row.intent_slhdsa_public_key } : {}),
    });
  });

  /** Return the unconsumed bind nonce for this session, if any. Browser fetches on-demand instead of threading through every auth-response codepath. Same auth (session cookie via tier-gate), same single-consumption — fetching doesn't consume; only bind-operator consumes. */
  app.get('/_auth/gates/bind-nonce', (c) => {
    const auth = c.get('tierGateAuth') as { sessionId?: string } | undefined;
    const sessionId = auth?.sessionId;
    if (!sessionId) return c.json({ error: 'Session required' }, 401);
    const row = db.prepare('SELECT operator_bind_nonce, operator_public_key FROM sessions WHERE id = ?')
      .get(sessionId) as { operator_bind_nonce: string | null; operator_public_key: string | null } | undefined;
    if (!row) return c.json({ error: 'Session not found' }, 401);
    if (row.operator_public_key !== null) return c.json({ nonce: null, alreadyBound: true });
    if (row.operator_bind_nonce === null) {
      const nonce = crypto.randomBytes(32).toString('hex');
      const healed = db.prepare(
        'UPDATE sessions SET operator_bind_nonce = ? WHERE id = ? AND operator_bind_nonce IS NULL AND operator_public_key IS NULL'
      ).run(nonce, sessionId);
      if (healed.changes > 0) {
        return c.json({ nonce, alreadyBound: false });
      }
      return c.json({ nonce: null, alreadyBound: false });
    }
    return c.json({ nonce: row.operator_bind_nonce, alreadyBound: false });
  });

  /**
   * Agent requests a gate (via auth proxy).
   * If auto-granted by permissions, returns immediately.
   * Otherwise stores pending and pushes to SSE stream.
   */
  app.post('/_auth/gates/request', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.gate !== 'string') {
      return c.json({ error: 'Missing gate' }, 400);
    }

    const gateRaw = body.gate as string;
    const reason = (body.reason as string) || '';

    // Resolve project identity from STS token (mandatory)
    const resolved = resolveProject(c);
    if (!resolved) {
      return c.json({ error: 'Missing project. Provide X-STS-Token header.' }, 400);
    }
    const { project } = resolved;

    // Validate gate type before any operations
    if (!VALID_GATE_TYPES.has(gateRaw as GateType)) {
      return c.json({ error: 'Invalid gate type' }, 400);
    }
    const gate = gateRaw as GateType;

    // L3 cross-project scope-confusion denial (see services/gate-scope-check.ts).
    // Authoritative server-side check — runs before any SSE push / bridge
    // relay. Gated by `ELLUL_CROSS_PROJECT_SCOPE_CHECK` kill switch.
    const scopeResult = runScopeCheck({
      project,
      reason,
      gate,
      layer: 'shield_gate_request',
      auditExtras: { ip },
      shape: 'gate_request',
    });
    if (scopeResult.denied) {
      return c.json(scopeResult.body, scopeResult.status);
    }

    // Check if gate already open
    if (isGateOpenForApp(gate, project)) {
      return c.json({ status: 'already_granted' });
    }

    // Check auto-grant permissions
    if (shouldAutoGrant(gate, project)) {
      const result = grantGateForApp(gate, project, undefined, { autoGranted: true });
      logAuditEvent({ type: 'gate_auto_granted', ip, details: { gate, project } });

      return c.json({ status: 'granted', expiresAt: result.expiresAt });
    }

    // Check auto-deny permissions (policy = 'never')
    if (shouldAutoDeny(gate, project)) {
      logAuditEvent({ type: 'gate_auto_denied', ip, details: { gate, project } });

      return c.json({ status: 'denied', reason: 'policy' });
    }

    // Store as pending, push to SSE for extension/REPL notification
    const requestId = crypto.randomBytes(16).toString('hex');
    const pending: PendingRequest = {
      requestId,
      gate,
      reason,
      project,
      createdAt: Date.now(),
      status: 'pending',
    };
    pendingRequests.set(requestId, pending);

    logAuditEvent({ type: 'gate_requested', ip, details: { gate, project, requestId } });
    return c.json({ status: 'pending', requestId });
  });

  /**
   * Extension/REPL approves/denies a gate request.
   *
   * The respond endpoint uses the requestId to look up the pending request,
   * which already has the STS-verified project stored. The responder does
   * NOT supply a project — it's already bound to the request.
   */
  app.post('/_auth/gates/respond', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.requestId !== 'string' || typeof body.action !== 'string') {
      return c.json({ error: 'Missing requestId or action' }, 400);
    }

    let pending = pendingRequests.get(body.requestId);
    let permissionRequestId: string | null = null;
    let threadId: string | null = null;

    const { getRequest } = await import('../application/gates/Permission');
    const permReq = getRequest(body.requestId);
    if (permReq) {
      permissionRequestId = permReq.id;
      threadId = permReq.threadId || null;
    }

    if (!pending) {
      if (!permReq || permReq.status !== 'pending') {
        return c.json({ error: 'Request not found or expired' }, 404);
      }
      pending = {
        requestId: permReq.id,
        gate: permReq.gate,
        reason: permReq.reason || '',
        project: permReq.sandboxId || '',
        createdAt: permReq.createdAt,
        status: 'pending',
      };
      pendingRequests.set(body.requestId, pending);
    }

    if (pending.status !== 'pending') {
      return c.json({ error: 'Request already resolved' }, 409);
    }

    const stsSlug = c.get('stsProject') as string | undefined;
    if (stsSlug && stsSlug !== pending.project) {
      return c.json({ error: 'STS token project does not match gate request project' }, 403);
    }

    const auth = c.get('tierGateAuth') as { sessionId?: string; userId?: string; jwtId?: string } | undefined;
    if (!auth || (!auth.sessionId && !auth.userId)) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const gateMetadata = body.metadata as Record<string, unknown> | undefined;
    const metadataJson = JSON.stringify(gateMetadata ?? {});
    const sigPayload = `gate-respond|${body.requestId}|${body.action}|${metadataJson}`;

    const tier = getCurrentTier();
    const isLockedTier = tier === 'web_locked' || tier === 'private_locked';

    if (isLockedTier) {
      const opErr = await verifyOperatorSignature(
        auth.sessionId!,
        sigPayload,
        body,
        ip,
      );
      if (opErr) {
        return c.json({ error: opErr }, 403);
      }
    }

    const isClassified = CLASSIFIED_ACTIONS.has(pending.gate);
    const needsIntent = isLockedTier && isClassified && body.action !== 'deny';
    if (needsIntent) {
      if (!body.intentSignature || !body.intentNonce) {
        const requiredType = getRequiredSignatureType(pending.gate) || 'unknown';
        return c.json({
          error: `Gate '${pending.gate}' is classified — requires ${requiredType} intent signature with nonce`,
          classified: true,
          requiredSignatureType: requiredType,
        }, 403);
      }
      const intentErr = await verifyIntentSignature(
        auth.sessionId,
        pending.gate,
        pending.project,
        body.intentSignature as string,
        body.intentNonce as string,
        (body.intentType as string) || null,
        ip,
      );
      if (intentErr) {
        return c.json({ error: intentErr, classified: true }, 403);
      }
      const sigType = getRequiredSignatureType(pending.gate) || 'unknown';
      logAuditEvent({
        type: 'pqc_intent_signature_verify',
        ip,
        sessionId: auth.sessionId,
        details: { metric: 'pqc.intent_signature_verify', action: pending.gate, sigType, valid: true },
      });
    }

    if (pending.gate === 'wallet_spend') {
      if (!gateMetadata) {
        return c.json({ error: 'wallet_spend gate requires metadata with maxAmountLamports and authorizedRecipients' }, 400);
      }
      const { maxAmountLamports, authorizedRecipients } = gateMetadata as {
        maxAmountLamports?: unknown;
        authorizedRecipients?: unknown;
      };
      if (typeof maxAmountLamports !== 'number' || !Number.isInteger(maxAmountLamports) || maxAmountLamports <= 0) {
        return c.json({ error: 'metadata.maxAmountLamports must be a positive integer' }, 400);
      }
      const { WALLET_MAX_LAMPORTS_PER_GRANT } = await import('../config');
      if (maxAmountLamports > WALLET_MAX_LAMPORTS_PER_GRANT) {
        return c.json({ error: `metadata.maxAmountLamports exceeds hard cap of ${WALLET_MAX_LAMPORTS_PER_GRANT} lamports` }, 400);
      }
      if (!Array.isArray(authorizedRecipients) || authorizedRecipients.length === 0 ||
          !authorizedRecipients.every((r: unknown) => typeof r === 'string' && r.length >= 32 && r.length <= 44)) {
        return c.json({ error: 'metadata.authorizedRecipients must be a non-empty array of base58 Solana addresses' }, 400);
      }
    }

    const action = body.action as string;

    if (action === 'deny') {
      pending.status = 'denied';
      logAuditEvent({ type: 'gate_denied', ip, details: { gate: pending.gate, project: pending.project, requestId: pending.requestId } });

      if (permissionRequestId) {
        try {
          const { resolveRequest } = await import('../application/gates/Permission');
          resolveRequest({ id: permissionRequestId, action: 'deny', sessionId: auth.sessionId ?? auth.jwtId });
        } catch {}
      }

      if (threadId) {
        notifyBridgeGateResolved({ threadId, gate: pending.gate, sandboxId: pending.project, requestId: pending.requestId, action: 'deny' });
      }

      return c.json({ status: 'denied' });
    }

    let ttl: number | undefined;
    let scope: 'timed' | 'session' | 'always' = 'timed';

    switch (action) {
      case 'grant_timed':
        ttl = typeof body.ttl === 'number' ? body.ttl : GATE_GRANT_TIMED_DEFAULT_MS;
        scope = 'timed';
        break;
      case 'grant_session':
        ttl = GATE_GRANT_SESSION_MS;
        scope = 'session';
        break;
      case 'grant_always':
        ttl = GATE_GRANT_ALWAYS_MS;
        scope = 'always';
        break;
      default:
        return c.json({ error: 'Invalid action' }, 400);
    }

    const result = grantGateForApp(pending.gate, pending.project, ttl, { metadata: gateMetadata });
    pending.status = 'granted';
    pending.grantScope = scope;
    pending.expiresAt = result.expiresAt;

    logAuditEvent({ type: 'gate_granted', ip, details: { gate: pending.gate, project: pending.project, scope, requestId: pending.requestId } });

    if (permissionRequestId) {
      try {
        const { resolveRequest } = await import('../application/gates/Permission');
        resolveRequest({
          id: permissionRequestId,
          action: action as 'grant_timed' | 'grant_session' | 'grant_always',
          ttlMs: ttl,
          expiresAt: result.expiresAt,
          sessionId: auth.sessionId ?? auth.jwtId,
        });
      } catch {}
    }

    if (threadId) {
      notifyBridgeGateResolved({ threadId, gate: pending.gate, sandboxId: pending.project, requestId: pending.requestId, action, expiresAt: result.expiresAt });
    }

    return c.json({ status: 'granted', expiresAt: result.expiresAt });
  });

  /**
   * List all gates for a project with status + policy.
   * Returns all 8 gate types (not just open ones) for dashboard view.
   */
  app.get('/_auth/gates/active', async (c) => {
    const resolved = resolveProject(c);
    if (!resolved) {
      return c.json({ error: 'Missing project. Provide X-STS-Token header.' }, 400);
    }

    return c.json({ gates: getAllGatesForProject(resolved.project) });
  });

  /**
   * Poll a gate request status (agent long-poll).
   */
  app.get('/_auth/gates/request/:id/status', async (c) => {
    const id = c.req.param('id');
    const pending = pendingRequests.get(id);

    if (pending) {
      return c.json({
        status: pending.status,
        gate: pending.gate,
        expiresAt: pending.expiresAt,
      });
    }

    const { getRequest } = await import('../application/gates/Permission');
    const permReq = getRequest(id);
    if (permReq) {
      return c.json({
        status: permReq.status,
        gate: permReq.gate,
        expiresAt: permReq.resolution?.expiresAt ?? null,
      });
    }

    return c.json({ status: 'not_found' }, 404);
  });

  // ── Gate Permissions (operator signature required) ──

  /**
   * Set gate permission policy.
   * Requires operator signature — agents cannot modify permissions.
   */
  app.post('/_auth/gates/permissions', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const body = await c.req.json().catch(() => null) as {
      gate?: string;
      project?: string;
      policy?: string;
      operatorSignature?: string;
      operatorTimestamp?: string;
    } | null;

    if (!body?.gate || !body?.project || !body?.policy) {
      return c.json({ error: 'Missing gate, project, or policy' }, 400);
    }

    if (!VALID_GATE_TYPES.has(body.gate as GateType)) {
      return c.json({ error: 'Invalid gate type' }, 400);
    }

    let sandboxId: SandboxId;
    try {
      sandboxId = parseSandboxId(body.project);
    } catch {
      return c.json({ error: 'Invalid sandboxId', code: 'INVALID_SANDBOX_ID' }, 400);
    }

    const validPolicies = ['ask', 'allow_session', 'allow_always', 'never'];
    if (!validPolicies.includes(body.policy)) {
      return c.json({ error: `Invalid policy. Must be one of: ${validPolicies.join(', ')}` }, 400);
    }

    const permAuth = c.get('tierGateAuth') as { sessionId?: string; userId?: string; jwtId?: string } | undefined;
    if (!permAuth || (!permAuth.sessionId && !permAuth.userId)) return c.json({ error: 'Authentication required' }, 401);

    const permTier = getCurrentTier();
    if (permTier === 'web_locked' || permTier === 'private_locked') {
      const permErr = await verifyOperatorSignature(
        permAuth.sessionId!,
        `gate-permission|${body.gate}|${sandboxId}|${body.policy}`,
        body,
        ip,
      );
      if (permErr) return c.json({ error: permErr }, 403);
    }

    const gate = body.gate as GateType;
    const policy = body.policy as GatePermission;

    if (policy === 'allow_session') {
      setSessionPermission(gate, sandboxId);
    } else {
      await setPermission(gate, sandboxId, policy, 'dashboard');
    }

    logAuditEvent({
      type: 'gate_permission.set',
      ip,
      sandboxId,
      details: { gate, policy },
    });

    return c.json({ status: 'ok', gate, project: sandboxId, policy });
  });

  // ── Gate Revocation (operator signature required) ──

  /**
   * Revoke an active gate.
   * Requires operator signature — agents cannot revoke gates (DoS prevention).
   */
  app.post('/_auth/gates/revoke', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const body = await c.req.json().catch(() => null) as {
      gate?: string;
      project?: string;
      operatorSignature?: string;
      operatorTimestamp?: string;
    } | null;

    if (!body?.gate || !body?.project) {
      return c.json({ error: 'Missing gate or project' }, 400);
    }

    if (!VALID_GATE_TYPES.has(body.gate as GateType)) {
      return c.json({ error: 'Invalid gate type' }, 400);
    }

    const revokeAuth = c.get('tierGateAuth') as { sessionId?: string; userId?: string; jwtId?: string } | undefined;
    if (!revokeAuth || (!revokeAuth.sessionId && !revokeAuth.userId)) return c.json({ error: 'Authentication required' }, 401);

    const revokeTier = getCurrentTier();
    if (revokeTier === 'web_locked' || revokeTier === 'private_locked') {
      const revokeErr = await verifyOperatorSignature(
        revokeAuth.sessionId!,
        `gate-revoke|${body.gate}|${body.project}`,
        body,
        ip,
      );
      if (revokeErr) return c.json({ error: revokeErr }, 403);
    }

    revokeGateForApp(body.gate as GateType, body.project);

    logAuditEvent({
      type: 'gate_revoked_by_operator',
      ip,
      details: { gate: body.gate, project: body.project },
    });

    return c.json({ status: 'revoked' });
  });
}

/**
 * Get active gates for a project (for SSE status updates).
 * Returns only open gates (used by SSE push events).
 */
function getActiveGatesForProject(project: string): Array<{ gate: string; expiresAt: number; scope: string }> {
  const gates: Array<{ gate: string; expiresAt: number; scope: string }> = [];

  for (const gate of VALID_GATE_TYPES) {
    if (isGateOpenForApp(gate, project)) {
      gates.push({ gate, expiresAt: Date.now() + 300_000, scope: 'timed' });
    }
  }

  return gates;
}

/**
 * Get ALL gates for a sandbox with status + policy (for dashboard view).
 */
function getAllGatesForProject(project: SandboxId): Array<{ gate: string; status: string; policy: string; expiresAt: number | null }> {
  const gates: Array<{ gate: string; status: string; policy: string; expiresAt: number | null }> = [];

  for (const gate of VALID_GATE_TYPES) {
    const isOpen = isGateOpenForApp(gate, project);
    const policy = getPermission(gate, project);
    gates.push({
      gate,
      status: isOpen ? 'open' : 'closed',
      policy,
      expiresAt: isOpen ? Date.now() + 300_000 : null,
    });
  }

  return gates;
}
