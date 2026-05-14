// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Typed security audit writer.
 *
 * Enterprise-grade discriminated union for every sandbox-scoped security
 * mutation: secrets, gate permissions, cross-project grants, vault scopes,
 * policies, database role operations, and session-scope violations.
 *
 * Every caller below is responsible for one thing and one thing only —
 * emitting a machine-readable, hash-chained audit record the moment a
 * security-relevant change is requested, permitted, or refused. Reviewers
 * auditing "every scope-crossing action in the product" can grep this file
 * and find the complete set in one discriminated union.
 *
 * Storage delegates to `logAuditEvent` so the append-only hash chain from
 * `audit.service.ts` is preserved; the `sandbox_id` column (added in the
 * schema migration) is populated from the typed event's `sandboxId` field
 * so reviewers can filter the audit trail by sandbox without parsing JSON.
 */

import type { SandboxId } from '@ellul.ai/types';
import type { GateType, GatePermission } from '../gates/GatePermissions';
import { logAuditEvent, type AuditEntry } from './Audit';

// ── Actor & context ──────────────────────────────────────────────────────────

/**
 * Who is performing the action. Audit entries must always attribute the
 * request — "unknown" is not a valid actor.
 */
export type Actor =
  | { kind: 'dashboard'; credentialId: string; sessionId: string }
  | { kind: 'popup'; credentialId: string; sessionId: string }
  | { kind: 'cli'; deviceId: string; credentialId: string }
  | { kind: 'system'; reason: string };

/**
 * Request context collected by the route handler. Passed alongside the
 * typed event so the writer can populate audit_log columns consistently.
 */
export interface AuditContext {
  ip: string | null;
  fingerprint?: string | null;
  actor: Actor;
}

// ── Event union ──────────────────────────────────────────────────────────────

interface BaseEvent {
  /** The sandbox whose state is being mutated. */
  sandboxId: SandboxId;
}

export type SecurityAuditEvent =
  // Secrets
  | (BaseEvent & { type: 'secret.set';      key: string; env: 'production' | 'development' })
  | (BaseEvent & { type: 'secret.delete';   key: string; env: 'production' | 'development' })
  | (BaseEvent & { type: 'secret.classify'; key: string; kind: 'secret' | 'plain' })
  | (BaseEvent & { type: 'secret.acknowledge_exposure'; key: string })

  // Gate permissions (persistent user-configured policy)
  | (BaseEvent & { type: 'gate_permission.set';    gate: GateType; permission: GatePermission })
  | (BaseEvent & { type: 'gate_permission.clear';  gate: GateType })

  // Gate requests (runtime access grants)
  | (BaseEvent & { type: 'gate.request';  gate: GateType; ttlMs: number })
  | (BaseEvent & { type: 'gate.grant';    gate: GateType; ttlMs: number; expiresAt: number })
  | (BaseEvent & { type: 'gate.deny';     gate: GateType; reason: string })
  | (BaseEvent & { type: 'gate.revoke';   gate: GateType })

  // Cross-project access
  | (BaseEvent & { type: 'xproject.grant';  target: SandboxId; sharePreview: boolean })
  | (BaseEvent & { type: 'xproject.revoke'; target: SandboxId })

  // Vault scopes (per-sandbox knowledge-vault projections)
  | (BaseEvent & { type: 'vault.scope.create'; scopeName: string })
  | (BaseEvent & { type: 'vault.scope.update'; scopeName: string })
  | (BaseEvent & { type: 'vault.scope.delete'; scopeName: string })
  | (BaseEvent & { type: 'vault.init' })

  // Policies / guardrails
  | (BaseEvent & { type: 'policy.install';  policyName: string })
  | (BaseEvent & { type: 'policy.uninstall'; policyName: string })
  | (BaseEvent & { type: 'policy.toggle';   policyName: string; enabled: boolean })

  // Database
  | (BaseEvent & { type: 'database.provision'; })
  | (BaseEvent & { type: 'database.backup'; })
  | (BaseEvent & { type: 'database.restore'; fromTimestamp: number })

  // Scope enforcement violations — emitted whenever a caller fails
  // SandboxId validation or authenticated-scope binding. Security-critical:
  // repeated hits indicate credential compromise or policy misconfiguration.
  | { type: 'scope.invalid';  code: 'INVALID_SANDBOX_ID'; route: string; reason: string }
  | (BaseEvent & { type: 'scope.mismatch'; code: 'SCOPE_MISMATCH'; sessionScope: SandboxId; route: string });

// ── Writer ───────────────────────────────────────────────────────────────────

/**
 * Extract the sandbox id from a typed event (absent on `scope.invalid` —
 * the input failed validation before a sandbox could be identified).
 */
function eventSandboxId(event: SecurityAuditEvent): SandboxId | null {
  if (event.type === 'scope.invalid') return null;
  return event.sandboxId;
}

/**
 * Flatten a typed event into the `details` JSON payload consumed by the
 * hash-chained audit log. Everything except `type` goes into details so
 * the event type column stays a stable discriminator for queries.
 */
function eventDetails(event: SecurityAuditEvent): Record<string, unknown> {
  const { type: _type, ...rest } = event as { type: string } & Record<string, unknown>;
  return rest;
}

/**
 * Record a security-scoped mutation. Delegates to the hash-chained audit
 * writer in `audit.service.ts`; the event type becomes the `event` column,
 * the sandbox id (when applicable) becomes the `sandbox_id` column, and
 * the remaining fields are JSON-encoded in `details`.
 *
 * Actor attribution is mandatory — passing a fake "unknown" actor breaks
 * the threat model. Prefer `{ kind: 'system', reason }` for internal
 * operations (e.g. sandbox deletion cascading secret wipe).
 */
export function logSecurityAuditEvent(
  event: SecurityAuditEvent,
  ctx: AuditContext,
): AuditEntry {
  const sandboxId = eventSandboxId(event);
  const details = eventDetails(event);

  // Keep actor info on the audit row via credential_id / session_id for
  // existing reviewers; include the structured actor in details for
  // exact-kind queries.
  let credentialId: string | null = null;
  let sessionId: string | null = null;
  if (ctx.actor.kind === 'dashboard' || ctx.actor.kind === 'popup') {
    credentialId = ctx.actor.credentialId;
    sessionId = ctx.actor.sessionId;
  } else if (ctx.actor.kind === 'cli') {
    credentialId = ctx.actor.credentialId;
  }

  return logAuditEvent({
    type: event.type,
    ip: ctx.ip,
    fingerprint: ctx.fingerprint ?? null,
    credentialId,
    sessionId,
    sandboxId,
    details: { ...details, actor: ctx.actor },
  });
}
