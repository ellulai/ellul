// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// Operator signature verification (SLH-DSA-SHA2-128s).
// The operator private key exists only in the browser's module-scoped RAM;
// MCP subprocesses cannot access it, so agent self-approval is mathematically
// impossible for any route gated by this verification.
//
// Callers build a pipe-separated `signedPayload` that uniquely identifies the
// operation (e.g. `gate-respond|${requestId}|${action}|${metadataJson}` or
// `context-mode|${project}|${mode}`). The client signs that payload plus a
// timestamp separator; this verifier reconstructs `signedPayload|timestamp`
// before asking SLH-DSA to verify.

import { db } from '../../database';
import { logAuditEvent } from '../audit/Audit';
import { OPERATOR_TIMESTAMP_TOLERANCE_MS } from '../../config';

export interface OperatorSignatureBody {
  readonly operatorSignature?: string;
  readonly operatorTimestamp?: string;
}

export async function verifyOperatorSignature(
  sessionId: string,
  signedPayload: string,
  body: OperatorSignatureBody,
  ip: string,
): Promise<string | null> {
  const row = db
    .prepare('SELECT operator_public_key FROM sessions WHERE id = ?')
    .get(sessionId) as { operator_public_key: string | null } | undefined;

  if (!row?.operator_public_key) {
    return 'No operator key bound to session';
  }

  if (!body.operatorSignature || !body.operatorTimestamp) {
    return 'Missing operator signature';
  }

  const ts = parseInt(body.operatorTimestamp, 10);
  if (isNaN(ts) || Math.abs(Date.now() - ts) > OPERATOR_TIMESTAMP_TOLERANCE_MS) {
    return 'Operator timestamp expired';
  }

  const fullPayload = signedPayload + '|' + body.operatorTimestamp;

  try {
    const { slh_dsa_sha2_128s } = await import('@noble/post-quantum/slh-dsa.js');
    const publicKeyBytes = Buffer.from(row.operator_public_key, 'base64');
    const signatureBytes = Buffer.from(body.operatorSignature, 'base64');
    const messageBytes = Buffer.from(fullPayload);

    const valid = slh_dsa_sha2_128s.verify(signatureBytes, messageBytes, publicKeyBytes);
    if (!valid) {
      logAuditEvent({ type: 'operator_sig_invalid', ip, details: { payload: signedPayload } });
      return 'Invalid operator signature (SLH-DSA)';
    }
    return null;
  } catch (e) {
    logAuditEvent({ type: 'operator_sig_error', ip, details: { error: (e as Error).message } });
    return 'Operator signature verification error';
  }
}
