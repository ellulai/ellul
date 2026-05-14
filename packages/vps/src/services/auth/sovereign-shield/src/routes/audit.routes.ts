// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Audit Routes
 *
 * Audit log access and integrity verification.
 * Auth is enforced by tier-gate middleware (SESSION classification)
 * before any handler runs — no inline auth checks needed.
 *
 * Endpoints:
 * - GET /_auth/audit        - Get recent audit log entries
 * - GET /_auth/audit/verify - Verify audit log integrity (hash chain)
 */

import crypto from 'crypto';
import type { Hono } from 'hono';
import { db } from '../database';
import { getClientIp } from '../auth/fingerprint';
import { logAuditEvent } from '../application/audit/Audit';

interface AuditLogEntry {
  id: number;
  timestamp: number;
  event: string;
  ip: string | null;
  fingerprint: string | null;
  credential_id: string | null;
  session_id: string | null;
  details: string | null;
  prev_hash: string;
  hash: string;
}

/**
 * Register audit routes on Hono app
 */
export function registerAuditRoutes(app: Hono): void {
  /**
   * Get recent audit log entries
   */
  app.get('/_auth/audit', async (c) => {
    const logs = db.prepare(
      'SELECT timestamp, event, ip, details FROM audit_log ORDER BY timestamp DESC LIMIT 100'
    ).all() as Array<{
      timestamp: number;
      event: string;
      ip: string | null;
      details: string | null;
    }>;

    return c.json({ logs });
  });

  /**
   * Verify audit log integrity (hash chain)
   * This endpoint verifies that the audit log hasn't been tampered with.
   */
  app.get('/_auth/audit/verify', async (c) => {
    const ip = getClientIp(c);
    const auth = (c as any).get('tierGateAuth') as { sessionId?: string; credentialId?: string } | undefined;

    // Get all audit logs in order
    const logs = db.prepare(
      'SELECT id, timestamp, event, ip, fingerprint, credential_id, session_id, details, prev_hash, hash FROM audit_log ORDER BY id ASC'
    ).all() as AuditLogEntry[];

    let valid = true;
    let brokenAt: number | null = null;
    let brokenReason: string | null = null;
    let expectedPrevHash = '0';
    let verifiedCount = 0;

    for (const log of logs) {
      // Verify prev_hash chain
      if (log.prev_hash !== expectedPrevHash) {
        valid = false;
        brokenAt = log.id;
        brokenReason = 'prev_hash_mismatch';
        break;
      }

      // Verify hash
      const entry = {
        timestamp: log.timestamp,
        event: log.event,
        ip: log.ip,
        fingerprint: log.fingerprint,
        credential_id: log.credential_id,
        session_id: log.session_id,
        details: log.details,
        prev_hash: log.prev_hash,
      };
      const expectedHash = crypto.createHash('sha256')
        .update(JSON.stringify(entry))
        .digest('hex');

      if (log.hash !== expectedHash) {
        valid = false;
        brokenAt = log.id;
        brokenReason = 'hash_mismatch';
        break;
      }

      expectedPrevHash = log.hash;
      verifiedCount++;
    }

    // Log the verification attempt
    logAuditEvent({
      type: 'audit_log_verified',
      ip,
      credentialId: auth?.credentialId,
      sessionId: auth?.sessionId,
      details: {
        valid,
        totalEntries: logs.length,
        verifiedCount,
        brokenAt,
        brokenReason
      }
    });

    if (!valid) {
      return c.json({
        valid: false,
        totalEntries: logs.length,
        verifiedCount,
        brokenAt,
        brokenReason,
        lastVerified: Date.now(),
        warning: 'Audit log integrity compromised! Entry ' + brokenAt + ' has been tampered with.'
      });
    }

    return c.json({
      valid: true,
      totalEntries: logs.length,
      verifiedCount,
      brokenAt: null,
      lastVerified: Date.now(),
      message: 'All ' + logs.length + ' audit log entries verified successfully.'
    });
  });
}
