// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Integration tests for `runScopeCheck` — the shared orchestrator used
 * by both gate-request shield routes (`/_auth/gates/request` and
 * `/api/internal/gate/auto-grant`).
 *
 * Proves the decision pipeline end-to-end:
 *   1. Match detection delegated to `detectCrossProjectScopeConfusion`
 *      (itself backed by `listCrossProjectAccess` — mocked here).
 *   2. On denial: metric counter increments, audit event logged with
 *      full structured details, response body has the right shape for
 *      the calling route (gate_request vs auto_grant variants).
 *   3. On no-match or flag-off: returns `{ denied: false }`.
 *
 * Dependencies are mocked at the module boundary so we don't need the
 * full shield DB / config stack to run.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseSandboxId, type SandboxId } from '@ellul.ai/types';

// `vi.hoisted` runs BEFORE `vi.mock` factory hoists — this is the
// supported pattern for sharing mock fns between the factory and the
// test body. The factory itself is hoisted and can't close over
// lexically-later bindings.
const mocks = vi.hoisted(() => ({
  listCrossProjectAccess: vi.fn(),
  logAuditEvent: vi.fn(),
}));

vi.mock('../cross-project.service', async () => {
  const { matchScopeConfusionInReason } = await import('@vps/shared/cross-project-scope');
  return {
    detectCrossProjectScopeConfusion: (reader: SandboxId, reason: string) => {
      const slugs = mocks.listCrossProjectAccess(reader);
      return matchScopeConfusionInReason(slugs, reason);
    },
    listCrossProjectAccess: mocks.listCrossProjectAccess,
    cleanupSandboxCrossProjectAccess: vi.fn(),
    grantCrossProjectAccess: vi.fn(),
    revokeCrossProjectAccess: vi.fn(),
    listAllCrossProjectAccess: vi.fn(),
  };
});

vi.mock('../audit/Audit', () => ({
  logAuditEvent: mocks.logAuditEvent,
}));

import { runScopeCheck } from './GateScopeCheck';
import { getScopeConfusionDenialStats } from '@vps/shared/cross-project-scope';

const A: SandboxId = parseSandboxId('sbx-aaaaaaa');
const B: SandboxId = parseSandboxId('sbx-bbbbbbb');

describe('runScopeCheck — L3 shield decision pipeline', () => {
  beforeEach(() => {
    mocks.listCrossProjectAccess.mockReset();
    mocks.logAuditEvent.mockReset();
  });

  it('DENIES /_auth/gates/request shape with structured body + audit event + metric increment', () => {
    mocks.listCrossProjectAccess.mockReturnValue([B]);

    const before = getScopeConfusionDenialStats();
    const result = runScopeCheck({
      project: A,
      reason: 'query .shared/sbx-bbbbbbb/schema.sql',
      gate: 'db_read',
      layer: 'shield_gate_request',
      auditExtras: { ip: '127.0.0.1' },
      shape: 'gate_request',
    });
    const after = getScopeConfusionDenialStats();

    expect(result.denied).toBe(true);
    if (!result.denied) return; // type guard
    expect(result.status).toBe(403);
    expect(result.body.status).toBe('denied');
    expect(result.body.reason).toBe('cross_project_scope_confusion');
    expect(result.body.sharedSandbox).toBe(B);
    expect(result.body.matchedToken).toBe('.shared/sbx-bbbbbbb');
    expect(result.body.message).toContain(B);
    expect(result.body.message).toContain('db_read');

    // Metric incremented on the correct layer.
    expect(after.count).toBe(before.count + 1);
    expect(after.byLayer.shield_gate_request).toBe(before.byLayer.shield_gate_request + 1);

    // Audit event fired with full context.
    expect(mocks.logAuditEvent).toHaveBeenCalledOnce();
    const auditCall = mocks.logAuditEvent.mock.calls[0]![0];
    expect(auditCall.type).toBe('gate_denied_cross_project_scope');
    expect(auditCall.details).toMatchObject({
      layer: 'shield_gate_request',
      gate: 'db_read',
      project: A,
      reason: 'query .shared/sbx-bbbbbbb/schema.sql',
      sharedSandbox: B,
      matchedToken: '.shared/sbx-bbbbbbb',
      ip: '127.0.0.1',
    });
  });

  it('DENIES /api/internal/gate/auto-grant shape with compact body', () => {
    mocks.listCrossProjectAccess.mockReturnValue([B]);

    const result = runScopeCheck({
      project: A,
      reason: 'Tool db_query requires db_read gate [tool args reference: .shared/sbx-bbbbbbb]',
      gate: 'db_read',
      layer: 'shield_auto_grant',
      auditExtras: { threadId: 't_abc' },
      shape: 'auto_grant',
    });

    expect(result.denied).toBe(true);
    if (!result.denied) return;
    expect(result.status).toBe(403);
    expect(result.body.denied).toBe(true);
    // auto_grant shape has no `message` field — just denied + sharedSandbox + matchedToken.
    expect(result.body.message).toBeUndefined();
    expect(result.body.sharedSandbox).toBe(B);

    expect(mocks.logAuditEvent).toHaveBeenCalledOnce();
    expect(mocks.logAuditEvent.mock.calls[0]![0].details.threadId).toBe('t_abc');
    expect(mocks.logAuditEvent.mock.calls[0]![0].details.layer).toBe('shield_auto_grant');
  });

  it('ALLOWS when reason does NOT name a shared sandbox', () => {
    mocks.listCrossProjectAccess.mockReturnValue([B]);

    const before = getScopeConfusionDenialStats();
    const result = runScopeCheck({
      project: A,
      reason: 'need db_read to query users table',
      gate: 'db_read',
      layer: 'shield_gate_request',
      shape: 'gate_request',
    });
    const after = getScopeConfusionDenialStats();

    expect(result.denied).toBe(false);
    expect(after.count).toBe(before.count); // no metric increment
    expect(mocks.logAuditEvent).not.toHaveBeenCalled();
  });

  it('ALLOWS when reader has no shared-access grants at all', () => {
    mocks.listCrossProjectAccess.mockReturnValue([]);

    const result = runScopeCheck({
      project: A,
      reason: 'query .shared/sbx-bbbbbbb/schema.sql', // matches a pattern but not a granted slug
      gate: 'db_read',
      layer: 'shield_gate_request',
      shape: 'gate_request',
    });

    expect(result.denied).toBe(false);
    expect(mocks.logAuditEvent).not.toHaveBeenCalled();
  });

  it('Flag off → allow even when match would fire', async () => {
    // Re-import with the flag disabled via vi.resetModules + stubEnv.
    vi.resetModules();
    vi.stubEnv('ELLUL_CROSS_PROJECT_SCOPE_CHECK', '0');
    // The mocks above are registered for the first-module graph; when
    // vi.resetModules clears, we need to reapply in the same scope.
    vi.doMock('../cross-project.service', async () => {
      const { matchScopeConfusionInReason } = await import('@vps/shared/cross-project-scope');
      return {
        detectCrossProjectScopeConfusion: (reader: SandboxId, reason: string) =>
          matchScopeConfusionInReason([B], reason),
      };
    });
    vi.doMock('../audit/Audit', () => ({ logAuditEvent: vi.fn() }));

    const { runScopeCheck: runScopeCheckOff } = await import('./GateScopeCheck');
    const result = runScopeCheckOff({
      project: A,
      reason: 'query .shared/sbx-bbbbbbb/schema.sql',
      gate: 'db_read',
      layer: 'shield_gate_request',
      shape: 'gate_request',
    });
    expect(result.denied).toBe(false);

    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
