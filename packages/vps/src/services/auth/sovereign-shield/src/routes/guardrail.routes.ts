// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Guardrail Routes — Agent-facing policy discovery
 *
 * These endpoints let the agent READ the active guardrail rules BEFORE writing
 * code. This prevents wasted tokens from trial-and-error discovery.
 *
 * The agent calls ellul_list_guardrails → /_auth/guardrail/rules → gets back
 * a complete list of active rules with their descriptions, languages, and
 * severity levels. The agent uses this to inform its code generation.
 *
 * Security:
 * - All endpoints require SESSION auth (tier-gate middleware applied globally)
 * - Read-only: no mutation endpoints exposed to the agent
 * - Proposals are write-only: agent can propose, human approves
 */

import type { Hono } from 'hono';
import {
  listRules,
  listPendingProposals,
  createProposal,
  setRuleEnabled,
  deleteRule,
  addRule,
  approveProposal,
  denyProposal,
} from '../application/guardrails/GuardrailSync';
import { logAuditEvent } from '../application/audit/Audit';
import { getClientIp } from '../auth/fingerprint';

export function registerGuardrailRoutes(app: Hono): void {
  /**
   * GET /_auth/guardrail/rules
   *
   * Returns all active guardrail rules. The agent should call this at the
   * start of a coding session to understand the constraints it must follow.
   *
   * Response format is designed for LLM consumption — each rule includes
   * a human-readable message that tells the agent exactly what to avoid
   * and what to do instead.
   */
  app.get('/_auth/guardrail/rules', (c) => {
    const rules = listRules();

    // Return ALL rules (enabled + disabled) for the UI.
    // The agent sees instructions; the UI sees the full management view.
    const formatted = rules.map(r => ({
      id: r.id,
      scope: r.scope,
      language: r.language,
      name: r.name,
      description: r.description,
      severity: r.severity,
      message: r.message,
      query_scm: r.query_scm,
      enabled: r.enabled,
      locked: r.locked,
    }));

    return c.json({
      rules: formatted,
      total: formatted.length,
      instructions:
        'These are the code guardrail rules enforced on this workspace. ' +
        'Your code will be statically analyzed against these rules BEFORE execution. ' +
        'If any rule is violated, execution is blocked and you receive the error. ' +
        'Review these constraints before writing code to avoid wasted attempts. ' +
        'Rules marked locked=true cannot be disabled or modified.',
    });
  });

  /**
   * POST /_auth/guardrail/propose
   *
   * Agent proposes a rule modification. Stored locally in SQLite.
   * Human approves/denies via the VPS dashboard. No cloud notification.
   *
   * The agent should call this when it believes a rule is preventing
   * correct code from executing, explaining WHY the change is needed.
   */
  app.post('/_auth/guardrail/propose', async (c) => {
    const ip = getClientIp(c);

    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.action !== 'string' || typeof body.reason !== 'string') {
      return c.json({ error: 'Invalid request. Required: { action, reason, rule_id?, payload? }' }, 400);
    }

    const validActions = new Set(['create', 'modify', 'disable', 'delete']);
    if (!validActions.has(body.action)) {
      return c.json({ error: `Invalid action "${body.action}". Must be one of: create, modify, disable, delete` }, 400);
    }

    try {
      const proposalId = createProposal({
        ruleId: body.rule_id || undefined,
        action: body.action,
        reason: body.reason,
        payload: body.payload || undefined,
      });

      logAuditEvent({
        type: 'guardrail_proposal_created',
        ip,
        details: { proposalId, action: body.action, ruleId: body.rule_id, reason: body.reason },
      });

      return c.json({
        status: 'pending',
        proposal_id: proposalId,
        message:
          'Proposal submitted and stored locally. The human user will see this ' +
          'in their VPS dashboard. DO NOT retry the blocked operation until the ' +
          'user approves or denies this proposal. You can check the status of ' +
          'pending proposals via ellul_list_guardrails.',
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 403);
    }
  });

  /**
   * GET /_auth/guardrail/proposals
   *
   * Returns pending proposals so the agent can check if its proposals
   * have been approved or are still waiting.
   */
  app.get('/_auth/guardrail/proposals', (c) => {
    const pending = listPendingProposals();
    return c.json({
      proposals: pending,
      total: pending.length,
    });
  });

  // ── Management endpoints (dashboard UI) ─────────────────────

  /**
   * PATCH /_auth/guardrail/rules/:id/toggle
   * Enable or disable a rule. Locked rules cannot be disabled.
   */
  app.patch('/_auth/guardrail/rules/:id/toggle', async (c) => {
    const ip = getClientIp(c);
    const id = decodeURIComponent(c.req.param('id'));
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.enabled !== 'boolean') {
      return c.json({ error: 'Required: { enabled: boolean }' }, 400);
    }
    try {
      setRuleEnabled(id, body.enabled);
      logAuditEvent({ type: 'guardrail_rule_toggled', ip, details: { id, enabled: body.enabled } });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 403);
    }
  });

  /**
   * DELETE /_auth/guardrail/rules/:id
   * Delete a custom rule. Locked rules cannot be deleted.
   */
  app.delete('/_auth/guardrail/rules/:id', async (c) => {
    const ip = getClientIp(c);
    const id = decodeURIComponent(c.req.param('id'));
    try {
      deleteRule(id);
      logAuditEvent({ type: 'guardrail_rule_deleted', ip, details: { id } });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 403);
    }
  });

  /**
   * POST /_auth/guardrail/rules
   * Add a new custom rule.
   */
  app.post('/_auth/guardrail/rules', async (c) => {
    const ip = getClientIp(c);
    const body = await c.req.json().catch(() => null);
    if (!body || !body.language || !body.name || !body.query_scm || !body.message) {
      return c.json({ error: 'Required: { scope, language, name, query_scm, message }' }, 400);
    }
    try {
      const id = addRule({
        scope: body.scope || 'workspace',
        language: body.language,
        name: body.name,
        description: body.description || '',
        query_scm: body.query_scm,
        severity: body.severity || 'error',
        message: body.message,
      });
      logAuditEvent({ type: 'guardrail_rule_created', ip, details: { id, name: body.name } });
      return c.json({ ok: true, id });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  /**
   * POST /_auth/guardrail/proposals/:id/approve
   * Approve a pending agent proposal.
   */
  app.post('/_auth/guardrail/proposals/:id/approve', async (c) => {
    const ip = getClientIp(c);
    const id = decodeURIComponent(c.req.param('id'));
    try {
      approveProposal(id);
      logAuditEvent({ type: 'guardrail_proposal_approved', ip, details: { id } });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 403);
    }
  });

  /**
   * POST /_auth/guardrail/proposals/:id/deny
   * Deny a pending agent proposal.
   */
  app.post('/_auth/guardrail/proposals/:id/deny', async (c) => {
    const ip = getClientIp(c);
    const id = decodeURIComponent(c.req.param('id'));
    try {
      denyProposal(id);
      logAuditEvent({ type: 'guardrail_proposal_denied', ip, details: { id } });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 403);
    }
  });
}
