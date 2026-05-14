// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Shield-side orchestrator for the L3 cross-project scope-confusion check.
 *
 * Two route handlers —
 *   - `gate-api.routes.ts` POST /_auth/gates/request
 *   - `workflow.routes.ts` POST /api/internal/gate/auto-grant
 * — share the same decision pipeline:
 *
 *   1. If the kill switch is off, skip the check (return allow).
 *   2. Run `detectCrossProjectScopeConfusion(project, reason)`.
 *   3. If a match fires, record the denial metric, log the audit event,
 *      and return a `denied` verdict carrying the structured response
 *      body and HTTP status for the route to send back.
 *
 * Keeping this logic in one place:
 *   - Eliminates drift between the two routes.
 *   - Gives us a single unit-testable seam that proves the full decision
 *     pipeline (match + record + audit + response shape) runs end-to-end,
 *     without having to spin up the full Hono app + DB stack.
 */

import type { SandboxId } from '@ellul.ai/types';
import {
  SCOPE_CHECK_ENABLED,
  recordScopeConfusionDenial,
  type DenialLayer,
} from '@vps/shared/cross-project-scope';
import {
  detectCrossProjectScopeConfusion,
  listCrossProjectAccess,
} from '../organization/CrossProject';
import { logAuditEvent } from '../audit/Audit';

/**
 * Gates that touch secret/data/deploy surfaces. When a sandbox with active
 * `.shared/<other>` grants requests one of these and the reason does not
 * explicitly reference the READER's own project, we emit a monitoring event
 * so operators can review. We do NOT auto-deny here (would be too
 * false-positive-heavy); the existing `detectCrossProjectScopeConfusion`
 * still denies on explicit shared-slug references.
 */
const SENSITIVE_GATE_PREFIXES = ['db_', 'secrets_', 'deploy_', 'git_push'];

function isSensitiveGate(gate: string): boolean {
  return SENSITIVE_GATE_PREFIXES.some((p) => gate === p.replace(/_$/, '') || gate.startsWith(p));
}

export interface ScopeCheckAllow {
  denied: false;
}

export interface ScopeCheckDeny {
  denied: true;
  status: 403;
  body: {
    status?: 'denied';       // `/_auth/gates/request` shape
    denied?: true;           // `/api/internal/gate/auto-grant` shape
    reason: 'cross_project_scope_confusion';
    sharedSandbox: SandboxId;
    matchedToken: string;
    message?: string;
  };
}

export type ScopeCheckResult = ScopeCheckAllow | ScopeCheckDeny;

export interface ScopeCheckInput {
  project: SandboxId;
  reason: string;
  gate: string;
  layer: DenialLayer;
  /** Audit fields to include on denial (ip for /_auth, threadId for /auto-grant). */
  auditExtras?: Record<string, unknown>;
  /** Shape of the denial body — the two routes use slightly different
   * field names (`status: 'denied'` vs `denied: true`). */
  shape: 'gate_request' | 'auto_grant';
}

export function runScopeCheck(input: ScopeCheckInput): ScopeCheckResult {
  if (!SCOPE_CHECK_ENABLED) return { denied: false };

  const confusion = detectCrossProjectScopeConfusion(input.project, input.reason);
  if (!confusion) {
    // Monitoring-only path: if THIS reader has any active shared grants and
    // the requested gate is sensitive, log an audit event so operators can
    // review the reason text for implicit cross-sandbox intent that the
    // slug-matching detector can't catch (e.g. "need DB access because of
    // the seed file"). No deny — false-positive rate would be too high.
    if (isSensitiveGate(input.gate)) {
      try {
        const grants = listCrossProjectAccess(input.project);
        if (grants.length > 0) {
          logAuditEvent({
            type: 'gate_sensitive_with_shared_grants',
            details: {
              gate: input.gate,
              project: input.project,
              reason: input.reason,
              sharedSandboxes: grants.map((g) => g.sharedSandboxId),
              ...(input.auditExtras ?? {}),
            },
          });
        }
      } catch { /* audit failures must not block the gate */ }
    }
    return { denied: false };
  }

  recordScopeConfusionDenial(input.layer);

  logAuditEvent({
    type: 'gate_denied_cross_project_scope',
    details: {
      layer: input.layer,
      gate: input.gate,
      project: input.project,
      reason: input.reason,
      sharedSandbox: confusion.sharedSandbox,
      matchedToken: confusion.matchedToken,
      ...(input.auditExtras ?? {}),
    },
  });

  const base = {
    reason: 'cross_project_scope_confusion' as const,
    sharedSandbox: confusion.sharedSandbox,
    matchedToken: confusion.matchedToken,
  };

  if (input.shape === 'gate_request') {
    return {
      denied: true,
      status: 403,
      body: {
        status: 'denied',
        ...base,
        message:
          `Gate "${input.gate}" cannot be granted for work referencing .shared/${confusion.sharedSandbox}/. ` +
          `That path is a read-only source snapshot of another sandbox; any gate granted applies only ` +
          `to THIS sandbox's own data/secrets/deploy, not ${confusion.sharedSandbox}'s. ` +
          `Do not request gates for cross-sandbox inspection — read the files under .shared/* directly, ` +
          `no gate is required.`,
      },
    };
  }

  return {
    denied: true,
    status: 403,
    body: { denied: true, ...base },
  };
}
