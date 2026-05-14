// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Daemon Routes — All HTTP route handlers composed via LocalRouter
 *
 * Replaces the monolithic if/else chain with middleware-composed routes.
 * Each route is registered with its method, path pattern, and handler.
 * Global middleware handles: rate limiting, nonce check, connection tracking,
 * shutdown guard, STS verification, and correlation ID propagation.
 */

import * as crypto from 'crypto';

import { verifyLocalSts, signLocalSts, verifyOperatorSignature, ruleApprovePayload, ruleDenyPayload } from '../crypto/index';
import { getAvailableTier } from '../infra/peercred';
import { getRequiredGate, isAllowlisted, getAllCapabilities, type GateType } from '../gates/capability-allowlist';
import { scanWorkspace, verifyAndRestoreIntegrity, resolveGuardrailBinary } from '../guardrails/scanner';
import { recordStrike, clearStrikes, isHardStopped, MAX_STRIKES } from '../guardrails/strikes';
import { executeCommandSSE, executeCommandBuffered } from './exec';
import { getPromotionInventory, executePromotion, isPromotionInProgress } from '../promotion/index';
import {
  type LocalDaemonState, RateLimiter,
  parseJson, readBody, getSecretStore, reloadSecretEntries,
  resolveRequestProject, verifyNonce, CONFIG_DIR,
} from './state';
import { LocalRouter, type Middleware, jsonResponse } from './router';

// ── STS Verification Constants ──

const STS_GUARDED_PREFIXES = [
  '/_local/exec/',
  '/_local/gates/request',
  '/_local/gates/approve',
  '/_local/gates/deny',
  '/_local/secrets',
  '/_local/guardrails/propose',
];

function requiresStsVerification(urlPath: string): boolean {
  return STS_GUARDED_PREFIXES.some(prefix => urlPath.startsWith(prefix));
}

// ── Middleware Factories ──

function rateLimitMiddleware(limiter: RateLimiter): Middleware {
  return async (ctx, next) => {
    const clientId = (ctx.req.socket as unknown as { _peername?: { address?: string } })?._peername?.address || 'unknown';
    if (!limiter.check(clientId)) {
      jsonResponse(ctx, 429, { error: 'Rate limit exceeded' });
      return;
    }
    await next();
  };
}

function nonceMiddleware(state: LocalDaemonState): Middleware {
  return async (ctx, next) => {
    if (state.nonce && !verifyNonce(ctx.req, state.nonce)) {
      jsonResponse(ctx, 401, { error: 'Invalid daemon nonce' });
      return;
    }
    await next();
  };
}

function connectionTrackingMiddleware(state: LocalDaemonState): Middleware {
  return async (ctx, next) => {
    state.activeRequests.add(ctx.res);
    ctx.res.on('close', () => state.activeRequests.delete(ctx.res));
    if (state.shuttingDown) {
      jsonResponse(ctx, 503, { error: 'Daemon shutting down' });
      return;
    }
    await next();
  };
}

function stsVerificationMiddleware(state: LocalDaemonState): Middleware {
  return async (ctx, next) => {
    if (!requiresStsVerification(ctx.path)) {
      await next();
      return;
    }

    const stsToken = ctx.req.headers['x-sts-token'] as string | undefined;
    if (stsToken) {
      const stsResult = verifyLocalSts(stsToken, state.derivedKeys.stsSigningKey);
      if (!stsResult.valid) {
        state.logger.security('sts_rejected', `Invalid STS token: ${stsResult.reason}`, { correlationId: ctx.correlationId });
        jsonResponse(ctx, 401, { error: 'Invalid STS token', reason: stsResult.reason });
        return;
      }

      const project = state.registry.getProject(stsResult.payload.sub);
      if (project && stsResult.payload.fpr !== project.fingerprint) {
        state.logger.security('sts_fingerprint_mismatch', `Fingerprint mismatch for ${stsResult.payload.sub}`, { correlationId: ctx.correlationId });
        jsonResponse(ctx, 401, { error: 'STS token workspace fingerprint mismatch. Run: ellul rebind' });
        return;
      }

      (ctx.req as unknown as { _verifiedProject?: string })._verifiedProject = stsResult.payload.sub;
    }

    await next();
  };
}

function loggingMiddleware(state: LocalDaemonState): Middleware {
  return async (ctx, next) => {
    state.logger.debug('request', `${ctx.method} ${ctx.path}`, { correlationId: ctx.correlationId });
    await next();
  };
}

// ── Route Registration ──

export function createRouter(state: LocalDaemonState): LocalRouter {
  const router = new LocalRouter();
  const { logger, audit } = state;

  // Global middleware chain
  const limiter = new RateLimiter(100);
  router.use(rateLimitMiddleware(limiter));
  router.use(nonceMiddleware(state));
  router.use(connectionTrackingMiddleware(state));
  router.use(stsVerificationMiddleware(state));
  router.use(loggingMiddleware(state));

  // ── Health ──
  router.get('/_local/health', async (ctx) => {
    const components: Record<string, { status: string; detail?: string }> = {
      daemon: { status: 'ok' },
      peercred: { status: getAvailableTier() === 'filesystem-only' ? 'degraded' : 'ok', detail: getAvailableTier() },
      guardrail: { status: resolveGuardrailBinary() ? 'ok' : 'unhealthy', detail: resolveGuardrailBinary() || 'not found' },
      ruleStore: { status: state.ruleStore ? 'ok' : 'degraded', detail: state.ruleStore ? `${state.ruleStore.listRules().filter(r => r.enabled).length} rules` : 'SQLite failed' },
      projects: { status: state.registry.getAllProjects().length > 0 ? 'ok' : 'degraded', detail: `${state.registry.getAllProjects().length} registered` },
    };
    const overall = Object.values(components).some(c => c.status === 'unhealthy') ? 'unhealthy'
      : Object.values(components).some(c => c.status === 'degraded') ? 'degraded' : 'ok';
    jsonResponse(ctx, overall === 'unhealthy' ? 503 : 200, { status: overall, components });
  });

  // ── Status ──
  router.get('/_local/status', async (ctx) => {
    jsonResponse(ctx, 200, {
      version: '0.1.0', mode: 'local', execMode: state.execMode,
      uptime: process.uptime(),
      ipc: state.socketPath ? 'unix-socket' : 'tcp-fallback',
      peercredTier: getAvailableTier(),
      operatorKeyPublic: state.operatorKey.publicKeyBase64,
      guardrailBinary: resolveGuardrailBinary() ? 'found' : 'missing',
      ruleCount: state.ruleStore?.listRules().filter(r => r.enabled).length ?? 0,
      projects: state.registry.getAllProjects().map(p => ({
        slug: p.projectSlug, name: p.projectName, directory: p.directory,
        fingerprint: p.fingerprint,
        secrets: getSecretStore(state, p.projectSlug)?.count() ?? 0,
      })),
      gates: state.registry.getDefaultProject()
        ? state.gateManager.getGateStates(state.registry.getDefaultProject()!) : [],
    });
  });

  // ── Projects ──
  router.post('/_local/projects/register', async (ctx) => {
    const body = parseJson(await readBody(ctx.req)) as { dir?: string } | null;
    if (!body?.dir) { jsonResponse(ctx, 400, { error: 'Missing field: dir' }); return; }
    const project = await state.registry.registerProject(body.dir);
    if (!project) { jsonResponse(ctx, 400, { error: 'No valid .ellul/project.json found' }); return; }
    reloadSecretEntries(state);
    logger.info('project_registered', `Registered ${project.projectSlug}`, {
      project: project.projectSlug, details: { directory: project.directory, fingerprint: project.fingerprint },
    });
    jsonResponse(ctx, 200, { ok: true, slug: project.projectSlug, fingerprint: project.fingerprint });
  });

  router.get('/_local/projects', async (ctx) => {
    jsonResponse(ctx, 200, {
      projects: state.registry.getAllProjects().map(p => ({
        slug: p.projectSlug, name: p.projectName, directory: p.directory,
      })),
    });
  });

  router.post('/_local/projects/:slug/sts', async (ctx) => {
    const slug = ctx.pathParams.slug;
    const project = state.registry.getProject(slug);
    if (!project) { jsonResponse(ctx, 404, { error: 'Project not registered' }); return; }
    const token = signLocalSts(slug, project.directory, state.derivedKeys.stsSigningKey);
    jsonResponse(ctx, 200, { token, expiresAt: Math.floor(Date.now() / 1000) + 900, slug });
  });

  // ── Secrets ──
  router.get('/_local/secrets', async (ctx) => {
    const slug = ctx.params.get('project') || state.registry.getDefaultProject();
    if (!slug) { jsonResponse(ctx, 400, { error: 'Missing project' }); return; }
    const store = getSecretStore(state, slug);
    if (!store) { jsonResponse(ctx, 404, { error: 'Project not found or secrets.db missing' }); return; }
    jsonResponse(ctx, 200, { names: store.list(), count: store.count() });
  });

  router.post('/_local/secrets', async (ctx) => {
    const body = parseJson(await readBody(ctx.req)) as { project?: string; name?: string; value?: string } | null;
    const slug = resolveRequestProject(ctx.req, body, ctx.path, state.registry.getDefaultProject());
    if (!slug) { jsonResponse(ctx, 400, { error: 'Missing project' }); return; }
    const store = getSecretStore(state, slug);
    if (!store) { jsonResponse(ctx, 404, { error: 'secrets.db missing' }); return; }
    if (!body?.name || !body?.value) { jsonResponse(ctx, 400, { error: 'Missing name or value' }); return; }
    store.set(body.name, body.value);
    reloadSecretEntries(state);
    logger.info('secret_set', `Secret "${body.name}" stored`, { project: slug });
    jsonResponse(ctx, 200, { ok: true });
  });

  router.post('/_local/secrets/import', async (ctx) => {
    const body = parseJson(await readBody(ctx.req, 5 * 1024 * 1024)) as { project?: string; content?: string } | null;
    const slug = resolveRequestProject(ctx.req, body, ctx.path, state.registry.getDefaultProject());
    if (!slug || !body?.content) { jsonResponse(ctx, 400, { error: 'Missing project or content' }); return; }
    const store = getSecretStore(state, slug);
    if (!store) { jsonResponse(ctx, 404, { error: 'secrets.db missing' }); return; }
    const count = store.importEnv(body.content);
    reloadSecretEntries(state);
    logger.info('secrets_imported', `Imported ${count} secrets`, { project: slug });
    jsonResponse(ctx, 200, { ok: true, imported: count });
  });

  router.del('/_local/secrets/:name', async (ctx) => {
    const slug = ctx.params.get('project') || state.registry.getDefaultProject();
    if (!slug) { jsonResponse(ctx, 400, { error: 'Missing project' }); return; }
    const store = getSecretStore(state, slug);
    if (!store) { jsonResponse(ctx, 404, { error: 'secrets.db missing' }); return; }
    store.delete(ctx.pathParams.name);
    reloadSecretEntries(state);
    logger.info('secret_deleted', `Secret "${ctx.pathParams.name}" deleted`, { project: slug });
    jsonResponse(ctx, 200, { ok: true });
  });

  // ── Gates ──
  router.get('/_local/gates', async (ctx) => {
    const slug = ctx.params.get('project') || state.registry.getDefaultProject();
    if (!slug) { jsonResponse(ctx, 400, { error: 'Missing project' }); return; }
    jsonResponse(ctx, 200, { gates: state.gateManager.getGateStates(slug) });
  });

  router.post('/_local/gates/request', async (ctx) => {
    const body = parseJson(await readBody(ctx.req, 4096)) as { gate?: string; project?: string; reason?: string } | null;
    if (!body?.gate || !body?.reason) { jsonResponse(ctx, 400, { error: 'Missing gate or reason' }); return; }
    const slug = resolveRequestProject(ctx.req, body, ctx.path, state.registry.getDefaultProject());
    if (!slug) { jsonResponse(ctx, 400, { error: 'Missing project' }); return; }
    const result = state.gateManager.requestGate(body.gate as GateType, slug, body.reason);
    logger.info('gate_requested', `Gate ${body.gate} requested`, {
      project: slug, correlationId: ctx.correlationId, details: { status: result.status },
    });
    jsonResponse(ctx, 200, result);
  });

  router.post('/_local/gates/approve', async (ctx) => {
    const body = parseJson(await readBody(ctx.req, 4096)) as {
      gate?: string; project?: string; duration?: number;
      operatorSignature?: string; operatorTimestamp?: string;
    } | null;
    if (!body?.gate || !body?.project || !body?.operatorSignature || !body?.operatorTimestamp) {
      jsonResponse(ctx, 400, { error: 'Missing required fields' }); return;
    }
    const ok = await state.gateManager.approveGate(
      body.gate as GateType, body.project, body.duration || 300,
      body.operatorSignature, body.operatorTimestamp,
    );
    if (!ok) {
      logger.security('gate_approve_rejected', 'Invalid operator signature', { project: body.project });
      jsonResponse(ctx, 403, { error: 'Invalid operator signature' }); return;
    }
    logger.security('gate_approved', `Gate ${body.gate} approved`, { project: body.project });
    jsonResponse(ctx, 200, { ok: true });
  });

  router.post('/_local/gates/deny', async (ctx) => {
    const body = parseJson(await readBody(ctx.req, 4096)) as {
      gate?: string; project?: string; operatorSignature?: string; operatorTimestamp?: string;
    } | null;
    if (!body?.gate || !body?.project || !body?.operatorSignature || !body?.operatorTimestamp) {
      jsonResponse(ctx, 400, { error: 'Missing required fields' }); return;
    }
    const ok = await state.gateManager.denyGate(body.gate as GateType, body.project, body.operatorSignature, body.operatorTimestamp);
    if (!ok) { jsonResponse(ctx, 403, { error: 'Invalid operator signature' }); return; }
    logger.security('gate_denied', `Gate ${body.gate} denied`, { project: body.project });
    jsonResponse(ctx, 200, { ok: true });
  });

  // ── Guardrails ──
  router.get('/_local/guardrails/rules', async (ctx) => {
    if (!state.ruleStore) { jsonResponse(ctx, 503, { error: 'Rule store unavailable (degraded mode)' }); return; }
    const rules = state.ruleStore.listRules();
    jsonResponse(ctx, 200, {
      rules: rules.map(r => ({
        id: r.id, scope: r.scope, language: r.language, name: r.name,
        description: r.description, severity: r.severity, message: r.message,
        query_scm: r.query_scm, enabled: r.enabled, locked: r.locked,
      })),
      total: rules.length,
      instructions: 'These are the guardrail rules enforced on this workspace.',
    });
  });

  router.post('/_local/guardrails/propose', async (ctx) => {
    if (!state.ruleStore) { jsonResponse(ctx, 503, { error: 'Rule store unavailable' }); return; }
    const body = parseJson(await readBody(ctx.req, 16384)) as { action?: string; reason?: string; rule_id?: string; payload?: Record<string, unknown> } | null;
    if (!body?.action || !body?.reason) { jsonResponse(ctx, 400, { error: 'Missing action or reason' }); return; }
    try {
      const id = state.ruleStore.createProposal({ ruleId: body.rule_id, action: body.action, reason: body.reason, payload: body.payload });
      logger.info('guardrail_proposal_created', `Proposal ${id}`, { details: { reason: body.reason } });
      jsonResponse(ctx, 200, { status: 'pending', proposal_id: id, message: 'Proposal submitted. Review in REPL.' });
    } catch (err) {
      jsonResponse(ctx, 403, { error: (err as Error).message });
    }
  });

  router.get('/_local/guardrails/proposals', async (ctx) => {
    if (!state.ruleStore) { jsonResponse(ctx, 503, { error: 'Rule store unavailable' }); return; }
    jsonResponse(ctx, 200, { proposals: state.ruleStore.listPendingProposals() });
  });

  router.post('/_local/guardrails/proposals/:id/approve', async (ctx) => {
    if (!state.ruleStore) { jsonResponse(ctx, 503, { error: 'Rule store unavailable' }); return; }
    const body = parseJson(await readBody(ctx.req)) as { operatorSignature?: string; operatorTimestamp?: string } | null;
    if (!body?.operatorSignature || !body?.operatorTimestamp) { jsonResponse(ctx, 400, { error: 'Missing signature' }); return; }
    const payload = ruleApprovePayload(ctx.pathParams.id);
    const valid = await verifyOperatorSignature(state.operatorKey.publicKeyBase64, payload, body.operatorSignature, body.operatorTimestamp);
    if (!valid) { jsonResponse(ctx, 403, { error: 'Invalid operator signature' }); return; }
    try {
      state.ruleStore.approveProposal(ctx.pathParams.id);
      logger.security('guardrail_proposal_approved', `Proposal ${ctx.pathParams.id} approved`, { correlationId: ctx.correlationId });
      jsonResponse(ctx, 200, { ok: true });
    } catch (err) { jsonResponse(ctx, 400, { error: (err as Error).message }); }
  });

  router.post('/_local/guardrails/proposals/:id/deny', async (ctx) => {
    if (!state.ruleStore) { jsonResponse(ctx, 503, { error: 'Rule store unavailable' }); return; }
    const body = parseJson(await readBody(ctx.req)) as { operatorSignature?: string; operatorTimestamp?: string } | null;
    if (!body?.operatorSignature || !body?.operatorTimestamp) { jsonResponse(ctx, 400, { error: 'Missing signature' }); return; }
    const payload = ruleDenyPayload(ctx.pathParams.id);
    const valid = await verifyOperatorSignature(state.operatorKey.publicKeyBase64, payload, body.operatorSignature, body.operatorTimestamp);
    if (!valid) { jsonResponse(ctx, 403, { error: 'Invalid operator signature' }); return; }
    try {
      state.ruleStore.denyProposal(ctx.pathParams.id);
      logger.security('guardrail_proposal_denied', `Proposal ${ctx.pathParams.id} denied`, { correlationId: ctx.correlationId });
      jsonResponse(ctx, 200, { ok: true });
    } catch (err) { jsonResponse(ctx, 400, { error: (err as Error).message }); }
  });

  // ── Exec ──
  router.post('/_local/exec/scan', async (ctx) => {
    const body = parseJson(await readBody(ctx.req, 1024)) as { project?: string } | null;
    const slug = resolveRequestProject(ctx.req, body, ctx.path, state.registry.getDefaultProject());
    if (!slug) { jsonResponse(ctx, 400, { error: 'Missing project' }); return; }
    const project = state.registry.getProject(slug);
    if (!project) { jsonResponse(ctx, 404, { error: 'Project not registered' }); return; }
    if (state.ruleStore) {
      verifyAndRestoreIntegrity(CONFIG_DIR, () => state.ruleStore!.materializeRules(), (msg) => logger.warn('integrity', msg));
    }
    const result = scanWorkspace(project.directory, CONFIG_DIR);
    logger.info('guardrail_scan', `Scan: ${result.blocked ? 'BLOCKED' : 'CLEAN'}`, {
      project: slug, details: { blocked: result.blocked, findings: result.findings.length },
    });
    jsonResponse(ctx, 200, result);
  });

  router.post('/_local/exec/run', async (ctx) => {
    const body = parseJson(await readBody(ctx.req, 4096)) as { project?: string; command?: string; timeout?: number; stream?: boolean } | null;
    if (!body?.command) { jsonResponse(ctx, 400, { error: 'Missing command' }); return; }
    const slug = resolveRequestProject(ctx.req, body, ctx.path, state.registry.getDefaultProject());
    if (!slug) { jsonResponse(ctx, 400, { error: 'Missing project' }); return; }
    const project = state.registry.getProject(slug);
    if (!project) { jsonResponse(ctx, 404, { error: 'Project not registered' }); return; }
    const command = body.command;

    // Step 1: Capability check
    if (!isAllowlisted(command, state.execMode)) {
      audit.record('exec_rejected', 'agent', { project: slug, details: { command, reason: 'not_in_allowlist' } });
      jsonResponse(ctx, 403, {
        error: 'command_not_allowed', command, mode: state.execMode,
        hint: 'Allowed: ' + getAllCapabilities().flatMap(c => c.patterns.slice(0, 2)).join(', '),
      });
      return;
    }

    // Step 2: Gate check
    const requiredGate = getRequiredGate(command, state.execMode);
    if (requiredGate && !state.gateManager.isGateOpen(requiredGate, slug)) {
      jsonResponse(ctx, 403, { error: 'gate_closed', gate: requiredGate, command });
      return;
    }

    // Step 3: Ingest proposals
    if (state.ruleStore) state.ruleStore.ingestProposedPolicies(project.directory);

    // Step 4: Strike check
    if (isHardStopped(slug, command)) {
      jsonResponse(ctx, 403, { error: 'guardrail_halted', message: 'SYSTEM_HALT: 3 consecutive failures. DO NOT RETRY.' });
      return;
    }

    // Step 5: Integrity restoration
    if (state.ruleStore) {
      const ir = verifyAndRestoreIntegrity(CONFIG_DIR, () => state.ruleStore!.materializeRules(), (msg) => logger.warn('integrity', msg));
      if (ir.mismatched.length > 0) audit.record('integrity_restored', 'daemon', { project: slug, details: { files: ir.mismatched } });
    }

    // Step 6: Guardrail scan
    const scanResult = scanWorkspace(project.directory, CONFIG_DIR);
    if (scanResult.blocked) {
      const strikeCount = recordStrike(slug, command);
      audit.record('exec_guardrail_blocked', 'daemon', { project: slug, details: { command, strike: strikeCount } });
      const activeRules = (state.ruleStore?.listRules() ?? []).filter(r => r.enabled).map(r => ({ language: r.language, name: r.name, constraint: r.message }));
      if (strikeCount >= MAX_STRIKES) {
        jsonResponse(ctx, 403, { error: 'guardrail_halted', message: `SYSTEM_HALT: ${MAX_STRIKES} failures. DO NOT RETRY.` });
        return;
      }
      jsonResponse(ctx, 403, {
        error: 'guardrail_blocked', type: 'policy_violation',
        strike: strikeCount, strikes_remaining: MAX_STRIKES - strikeCount,
        findings: scanResult.findings, all_active_rules: activeRules,
      });
      return;
    }

    // Step 7: Clear strikes
    clearStrikes(slug, command);

    // Step 8: Execute
    audit.record('exec_approved', 'daemon', { project: slug, details: { command } });
    logger.info('exec_start', `Executing: ${command}`, { project: slug, correlationId: ctx.correlationId });

    const useSSE = body.stream !== false && ctx.req.headers.accept?.includes('text/event-stream');
    if (useSSE) {
      executeCommandSSE(ctx.res, command, project, state);
      return;
    }
    const execResult = await executeCommandBuffered(command, project, state);
    logger.info('exec_complete', `Exit ${execResult.exitCode}`, { project: slug, correlationId: ctx.correlationId });
    jsonResponse(ctx, 200, execResult);
  });

  // ── Internal (MCP coordination) ──
  router.post('/_internal/sync-receipt', async (ctx) => {
    const slug = ctx.params.get('project');
    if (!slug) { jsonResponse(ctx, 400, { error: 'Missing project param' }); return; }
    const body = parseJson(await readBody(ctx.req)) as { hash?: string } | null;
    if (body?.hash) state.registry.updateSyncState(slug, body.hash);
    jsonResponse(ctx, 200, { ok: true });
  });

  router.post('/_internal/gate-grant', async (ctx) => {
    const body = parseJson(await readBody(ctx.req)) as { requestId?: string; gate?: string; reason?: string; project?: string } | null;
    if (!body?.gate || !body?.project) { jsonResponse(ctx, 400, { error: 'Missing gate or project' }); return; }
    const requestId = body.requestId || crypto.randomBytes(8).toString('hex');
    const result = state.gateManager.requestGate(body.gate as GateType, body.project, body.reason || '');
    logger.info('gate_requested_mcp', `Agent requests ${body.gate}`, { project: body.project, details: { status: result.status } });
    jsonResponse(ctx, 200, { ...result, requestId });
  });

  router.post('/_internal/gate-revoke', async (ctx) => {
    jsonResponse(ctx, 403, { error: 'Gate revocation requires operator signature. Use REPL /deny.' });
  });

  router.post('/_internal/policy-set', async (ctx) => {
    jsonResponse(ctx, 403, { error: 'Policy changes require operator signature. Use REPL.' });
  });

  // ── Promotion ──
  router.get('/_local/promotion/inventory', async (ctx) => {
    const inventory = getPromotionInventory(state);
    if (!inventory) { jsonResponse(ctx, 400, { error: 'No project registered' }); return; }
    jsonResponse(ctx, 200, inventory);
  });

  router.post('/_local/promotion/execute', async (ctx) => {
    const body = parseJson(await readBody(ctx.req, 4096)) as {
      promotionToken?: string; vpsEndpoint?: string;
      operatorSignature?: string; operatorTimestamp?: string;
    } | null;

    if (!body?.promotionToken || !body?.vpsEndpoint) {
      jsonResponse(ctx, 400, { error: 'Missing promotionToken or vpsEndpoint' }); return;
    }

    const slug = state.registry.getDefaultProject();
    if (!slug) { jsonResponse(ctx, 400, { error: 'No project registered' }); return; }

    // Operator signature verification:
    // Two modes:
    //   1. REPL-initiated: external SLH-DSA signature provided and verified
    //   2. CLI-initiated: CLI has already authenticated the user (passkey + scoped
    //      promotion token). The daemon self-signs to record the approval in the
    //      audit log. The scoped promotion token IS the authorization proof.
    if (body.operatorSignature && body.operatorSignature !== 'cli-initiated' && body.operatorTimestamp) {
      const { verifyOperatorSignature } = await import('../crypto/index');
      const sigPayload = `promotion-execute|${slug}|${body.operatorTimestamp}`;
      const valid = await verifyOperatorSignature(
        state.operatorKey.publicKeyBase64, sigPayload,
        body.operatorSignature, body.operatorTimestamp,
      );
      if (!valid) {
        logger.security('promotion_sig_rejected', 'Invalid operator signature', { project: slug });
        jsonResponse(ctx, 403, { error: 'Invalid operator signature' }); return;
      }
    } else {
      // CLI-initiated: self-sign for audit trail
      // The scoped promotion token (60s, single-use, session-bound) serves as the
      // authorization proof. The daemon logs this as a CLI-initiated promotion.
      const { signOperatorAction } = await import('@ellul.ai/shield-proxy');
      const sigPayload = `promotion-execute-cli|${slug}|${Date.now()}`;
      const sig = await signOperatorAction(state.operatorKey, sigPayload);
      audit.record('promotion_cli_initiated', 'operator', {
        project: slug, details: { signature: sig.signature.slice(0, 20) + '...' },
      });
    }

    if (isPromotionInProgress(slug)) {
      jsonResponse(ctx, 409, { error: 'Promotion already in progress for this project' }); return;
    }

    try {
      const receipt = await executePromotion(state, body.promotionToken, body.vpsEndpoint);
      jsonResponse(ctx, 200, { receipt });
    } catch (err) {
      const message = (err as Error).message;
      logger.error('promotion_failed', message, { project: slug });
      jsonResponse(ctx, 500, { error: message });
    }
  });

  // ── Downgrade / Repatriation ──

  router.get('/_local/downgrade/inventory', async (ctx) => {
    // Only available when in VPS mode
    if (state.execMode && !state.execMode) {
      // Read mode from project config
    }
    const slug = state.registry.getDefaultProject();
    if (!slug) { jsonResponse(ctx, 400, { error: 'No project registered' }); return; }

    // Return inventory (counts only, no secrets)
    const project = state.registry.getProject(slug);
    if (!project) { jsonResponse(ctx, 400, { error: 'Project not found' }); return; }

    // For inventory, we report what the VPS would export
    // The actual counts come from the VPS during the downgrade flow
    // Here we just confirm the project is in VPS mode and ready
    jsonResponse(ctx, 200, {
      slug: project.projectSlug,
      name: project.projectName,
      directory: project.directory,
      message: 'Project is in VPS mode. Run downgrade to repatriate state.',
    });
  });

  router.post('/_local/downgrade/execute', async (ctx) => {
    const body = parseJson(await readBody(ctx.req, 4096)) as {
      downgradeToken?: string; vpsEndpoint?: string;
      operatorSignature?: string; operatorTimestamp?: string;
    } | null;

    if (!body?.downgradeToken || !body?.vpsEndpoint) {
      jsonResponse(ctx, 400, { error: 'Missing downgradeToken or vpsEndpoint' }); return;
    }

    const slug = state.registry.getDefaultProject();
    if (!slug) { jsonResponse(ctx, 400, { error: 'No project registered' }); return; }

    // Operator signature: same two-mode as promotion
    if (body.operatorSignature && body.operatorSignature !== 'cli-initiated' && body.operatorTimestamp) {
      const { verifyOperatorSignature } = await import('../crypto/index');
      const sigPayload = `downgrade-execute|${slug}|${body.operatorTimestamp}`;
      const valid = await verifyOperatorSignature(
        state.operatorKey.publicKeyBase64, sigPayload,
        body.operatorSignature, body.operatorTimestamp,
      );
      if (!valid) {
        jsonResponse(ctx, 403, { error: 'Invalid operator signature' }); return;
      }
    } else {
      const { signOperatorAction } = await import('@ellul.ai/shield-proxy');
      const sigPayload = `downgrade-execute-cli|${slug}|${Date.now()}`;
      const sig = await signOperatorAction(state.operatorKey, sigPayload);
      audit.record('downgrade_cli_initiated', 'operator', {
        project: slug, details: { signature: sig.signature.slice(0, 20) + '...' },
      });
    }

    const { isDowngradeInProgress, executeDowngrade } = await import('../repatriation/index');
    if (isDowngradeInProgress(slug)) {
      jsonResponse(ctx, 409, { error: 'Downgrade already in progress' }); return;
    }

    try {
      const receipt = await executeDowngrade(state, body.downgradeToken, body.vpsEndpoint);
      jsonResponse(ctx, 200, { receipt });
    } catch (err) {
      const message = (err as Error).message;
      logger.error('downgrade_failed', message, { project: slug });
      jsonResponse(ctx, 500, { error: message });
    }
  });

  return router;
}
