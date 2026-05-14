// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Exec Routes — Sovereign Sandbox endpoints
 *
 * Three endpoints for remote code execution in shielded namespaces:
 *
 * - POST /_auth/exec/sync   — Full file sync (tar.gz upload)
 * - POST /_auth/exec/patch  — Incremental file patches (HMR-speed)
 * - GET  /_auth/exec/run    — SSE stream: gate check → namespace → exec → stream output
 *
 * Security:
 * - All endpoints require SESSION auth (tier-gate middleware)
 * - exec/run requires `exec` gate to be open (browser approval, 4hr TTL)
 * - Secrets injected via stdin pipe (never in env or CLI args)
 * - Output redacted via createRedactor before SSE transmission
 * - Network egress whitelisted per-project via nftables
 *
 * Performance:
 * - syncFiles/patchFiles are async (don't block event loop)
 * - SSE streaming uses a write queue to handle back-pressure correctly
 *   without mixing callback and async patterns
 *
 * All writes target the persistent shielded workspace:
 *   /var/lib/ellul-shielded/projects/{name}/workspace/
 */

import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { getClientIp } from '../auth/fingerprint';
import { checkApiRateLimit } from '../application/platform/RateLimiter';
import { logAuditEvent } from '../application/audit/Audit';
import { isGateOpenForApp } from '../application/gates/Gate';
import {
  syncFiles,
  patchFiles,
  validateWorkspace,
  getWorkspaceDir,
  getCacheDir,
  computePatchSize,
  detectInstallCommand,
  MAX_PATCH_SIZE,
  type PatchFile,
} from '../application/process/Exec';
import {
  createShieldedNamespace,
  applyWhitelist,
  execInNamespace,
  destroyNamespace,
} from '../application/process/Netns';
import { scanWorkspace } from '../application/guardrails/Guardrail';
import { listRules, ingestProposedPolicies } from '../application/guardrails/GuardrailSync';
// Rule store is local SQLite — no cloud sync needed. Rules are materialized
// to .scm files on init and on every modification via the management API.
// The guardrail binary reads the materialized files directly.
import {
  recordStrike,
  clearStrikes,
  isHardStopped,
  MAX_STRIKES,
} from '../application/guardrails/GuardrailStrikes';
import { createRedactor } from '../application/audit/LogRedaction';
import { readSecrets } from '../application/vault/Secrets';
import { parseSandboxId, SandboxIdSchema } from '@ellul.ai/types';
import { resolveDestinations } from '../application/gates/Whitelist';
import {
  signSyncReceipt,
  verifySyncReceipt,
  computeWorkspaceHash,
  incrementEpoch,
  getWorkspaceLock,
  type SyncReceipt,
} from '../application/platform/SyncReceipt';
import { EXEC_MAX_SYNC_SIZE, EXEC_DEV_PORT_BASE, EXEC_DEV_PORT_RANGE } from '../config';

// Exec scope is the sandbox; validation is delegated to `SandboxIdSchema`
// from `@ellul.ai/types` (imported above). Inline regex was removed so the
// canonical pattern lives in one place.

/** Valid exec commands */
const VALID_COMMANDS = new Set(['dev', 'build', 'test']);

/**
 * Register exec routes on Hono app
 */
export function registerExecRoutes(app: Hono): void {
  // ── POST /_auth/exec/sync — Full tar.gz upload ──
  app.post('/_auth/exec/sync', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    // Billing tier enforced by billingGateMiddleware (free → 403)

    const projectParsed = SandboxIdSchema.safeParse(c.req.query('project'));
    if (!projectParsed.success) {
      return c.json({ error: 'Invalid or missing project (sandbox slug required)', code: 'INVALID_SANDBOX_ID' }, 400);
    }
    const project = projectParsed.data;

    // Validate workspace exists
    const check = await validateWorkspace(project);
    if (!check.valid) {
      return c.json({ error: check.error }, 404);
    }

    // Check Content-Length before reading the body to prevent OOM from
    // oversized uploads. The limit is enforced again in syncFiles()
    // on the actual buffer, but this early check avoids allocating memory.
    const contentLength = parseInt(c.req.header('content-length') || '0', 10);
    if (contentLength > EXEC_MAX_SYNC_SIZE) {
      return c.json({ error: `Upload exceeds ${EXEC_MAX_SYNC_SIZE / 1024 / 1024}MB limit` }, 413);
    }

    // Read raw body as buffer
    const body = await c.req.arrayBuffer();
    const buffer = Buffer.from(body);

    // Double-check actual size (Content-Length can be spoofed or absent)
    if (buffer.length > EXEC_MAX_SYNC_SIZE) {
      return c.json({ error: `Upload exceeds ${EXEC_MAX_SYNC_SIZE / 1024 / 1024}MB limit` }, 413);
    }

    const lock = getWorkspaceLock(project);

    try {
      const result = await syncFiles(project, buffer);

      // ── Sync receipt: sign a receipt binding workspace hash to epoch ──
      await lock.acquireWrite();
      let receipt: SyncReceipt | null = null;
      try {
        incrementEpoch(project);
        const hash = await computeWorkspaceHash(project);

        // Transit integrity: verify X-Content-Hash header matches computed hash
        const clientHash = c.req.header('X-Content-Hash');
        if (clientHash && clientHash !== hash) {
          return c.json({
            error: 'content_hash_mismatch',
            message: 'Upload integrity check failed: workspace hash does not match X-Content-Hash header',
          }, 400);
        }

        receipt = signSyncReceipt(hash, project);
      } finally {
        lock.releaseWrite();
      }

      logAuditEvent({
        type: 'exec_sync',
        ip,
        details: { project, filesCount: result.filesCount, size: buffer.length },
      });
      return c.json({ ok: true, filesCount: result.filesCount, receipt });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // ── POST /_auth/exec/patch — Incremental file patches ──
  app.post('/_auth/exec/patch', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    // Billing tier enforced by billingGateMiddleware (free → 403)

    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.project !== 'string' || !Array.isArray(body.files)) {
      return c.json({ error: 'Invalid request body. Expected: { project, files: [...] }' }, 400);
    }

    const projectParsed = SandboxIdSchema.safeParse(body.project);
    if (!projectParsed.success) {
      return c.json({ error: 'Invalid project (sandbox slug required)', code: 'INVALID_SANDBOX_ID' }, 400);
    }
    const project = projectParsed.data;

    const patches: PatchFile[] = body.files;

    // Validate total patch size
    const totalSize = computePatchSize(patches);
    if (totalSize > MAX_PATCH_SIZE) {
      return c.json({ error: `Patch payload exceeds ${MAX_PATCH_SIZE / 1024 / 1024}MB limit` }, 400);
    }

    const lock = getWorkspaceLock(project);

    try {
      const result = await patchFiles(project, patches);

      // ── Sync receipt: patches mutate workspace, so increment epoch + sign ──
      await lock.acquireWrite();
      let receipt: SyncReceipt | null = null;
      try {
        incrementEpoch(project);
        const hash = await computeWorkspaceHash(project);
        receipt = signSyncReceipt(hash, project);
      } finally {
        lock.releaseWrite();
      }

      return c.json({
        ok: true,
        applied: result.applied,
        errors: result.errors.length > 0 ? result.errors : undefined,
        receipt,
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // ── GET /_auth/exec/run — SSE stream for shielded execution ──
  app.get('/_auth/exec/run', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    // Billing tier enforced by billingGateMiddleware (free → 403)

    const projectParsed = SandboxIdSchema.safeParse(c.req.query('project'));
    const cmd = c.req.query('cmd') || 'dev';
    const script = c.req.query('script'); // Optional override

    if (!projectParsed.success) {
      return c.json({ error: 'Invalid or missing project (sandbox slug required)', code: 'INVALID_SANDBOX_ID' }, 400);
    }
    const project = projectParsed.data;

    if (!VALID_COMMANDS.has(cmd) && !script) {
      return c.json({ error: `Invalid command: ${cmd}. Must be one of: dev, build, test` }, 400);
    }

    // Validate script parameter: must be a safe package manager command.
    // Prevents arbitrary shell injection even though namespace provides isolation.
    const SCRIPT_PATTERN = /^(npm|npx|pnpm|yarn|bun|python|python3|pip|poetry|pipenv)\s/;
    if (script && !SCRIPT_PATTERN.test(script)) {
      return c.json({ error: 'Invalid script. Must start with a known package manager command (npm, pnpm, yarn, bun, python, pip, poetry, pipenv).' }, 400);
    }

    // Gate check: require `exec` gate to be open for this project
    if (!isGateOpenForApp('exec', project)) {
      logAuditEvent({
        type: 'exec_gate_denied',
        ip,
        details: { project, cmd },
      });
      return c.json({
        error: 'Exec gate not open. Approve via browser/extension.',
        gate: 'exec',
        project,
      }, 403);
    }

    // ── Sync receipt verification (REQUIRED) ──
    const receiptHeader = c.req.header('X-Sync-Receipt');
    if (!receiptHeader) {
      return c.json({ error: 'missing_receipt', message: 'X-Sync-Receipt header is required. Sync code before execution.' }, 400);
    }
    let parsed: SyncReceipt;
    try {
      parsed = JSON.parse(receiptHeader);
    } catch {
      return c.json({ error: 'stale_receipt', message: 'Malformed X-Sync-Receipt header' }, 400);
    }
    const check = verifySyncReceipt(parsed, project);
    if (!check.valid) {
      return c.json({ error: 'stale_receipt', message: check.reason || 'Receipt verification failed' }, 409);
    }

    // Validate workspace
    const wsCheck = await validateWorkspace(project);
    if (!wsCheck.valid) {
      return c.json({ error: wsCheck.error }, 404);
    }

    const workspaceDir = getWorkspaceDir(project);
    const cacheDir = getCacheDir(project);

    // ── GUARDRAIL GATE ──────────────────────────────────────────

    // Ingest agent-proposed .scm files from .ellul/policies/proposed/.
    // Creates pending proposals in SQLite — does NOT activate rules.
    // Human must approve via dashboard before rules take effect.
    ingestProposedPolicies(workspaceDir);

    // Strike 3 hard stop (check BEFORE scanning to save compute)
    if (isHardStopped(project, cmd)) {
      logAuditEvent({
        type: 'exec_guardrail_halted',
        ip,
        details: { project, cmd },
      });
      return c.json({
        error: 'guardrail_halted',
        message:
          'SYSTEM_HALT: You have failed to satisfy the compiler constraints ' +
          'after 3 attempts. DO NOT RETRY. Suspend execution and ask the ' +
          'human user for clarification or permission to bypass.',
      }, 403);
    }

    // Guardrail scan (fail-closed)
    const guardrailResult = scanWorkspace(workspaceDir);

    if (guardrailResult.blocked) {
      const strikeCount = recordStrike(project, cmd);

      logAuditEvent({
        type: 'exec_guardrail_blocked',
        ip,
        details: {
          project,
          cmd,
          strike: strikeCount,
          findings: guardrailResult.findings,
        },
      });

      // Strike 3: halt directive instead of normal error
      if (strikeCount >= MAX_STRIKES) {
        return c.json({
          error: 'guardrail_halted',
          message:
            'SYSTEM_HALT: You have failed to satisfy the compiler constraints ' +
            'after 3 attempts. DO NOT RETRY. Suspend execution and ask the ' +
            'human user for clarification or permission to bypass.',
        }, 403);
      }

      // Strike 1-2: return precise findings (golden prompt) + ALL active rules
      // so the agent learns every constraint in a single response. This prevents
      // the agent from fixing one violation only to hit another on the next attempt.
      const activeRules = listRules()
        .filter(r => r.enabled)
        .map(r => ({ language: r.language, name: r.name, constraint: r.message }));

      return c.json({
        error: 'guardrail_blocked',
        type: 'policy_violation',
        strike: strikeCount,
        strikes_remaining: MAX_STRIKES - strikeCount,
        findings: guardrailResult.findings,
        all_active_rules: activeRules,
        hint: 'This is a POLICY violation, not a permission issue. The exec gate is open — your code ' +
          'was blocked by static analysis. Fix the violations listed in findings. Do NOT request ' +
          'gate access again. If a policy conflicts with your task, call ellul_propose_rule_change.',
      }, 403);
    }

    // Scan passed — clear accumulated strikes
    clearStrikes(project, cmd);

    // ── END GUARDRAIL GATE ──────────────────────────────────────

    // Read secrets for the sandbox (single-scope, no fallback merging).
    const secrets = readSecrets(parseSandboxId(project));
    const secretValues = [...secrets.values()];
    const secretEnv: Record<string, string> = {};
    for (const [k, v] of secrets) {
      secretEnv[k] = v;
    }

    // Resolve egress whitelist from secrets
    const destinations = resolveDestinations(secrets);

    // Add package registries to whitelist
    destinations.push(
      { host: 'registry.npmjs.org', port: 443, protocol: 'tcp' },
      { host: 'registry.yarnpkg.com', port: 443, protocol: 'tcp' },
      { host: 'pypi.org', port: 443, protocol: 'tcp' },
      { host: 'files.pythonhosted.org', port: 443, protocol: 'tcp' },
    );

    // Detect dep install command
    const installCmd = await detectInstallCommand(project);

    // Build the full command: install deps (if needed) then run
    const userCommand = script || `npm run ${cmd}`;
    const command = installCmd
      ? `${installCmd} && ${userCommand}`
      : userCommand;

    // Allocate a port for the dev server (deterministic from project name hash)
    const portHash = Buffer.from(project).reduce((acc, b) => acc + b, 0);
    const port = EXEC_DEV_PORT_BASE + (portHash % EXEC_DEV_PORT_RANGE);

    logAuditEvent({
      type: 'exec_start',
      ip,
      details: { project, cmd, command, port, installCmd },
    });

    // Acquire read lock for the duration of execution (receipt always present)
    const execLock = getWorkspaceLock(project);

    // SSE response
    return streamSSE(c, async (stream) => {
      let nsCreated = false;
      await execLock.acquireRead();

      // ── Write queue: serializes SSE writes to handle back-pressure ──
      // Child process stdout/stderr callbacks push into this queue.
      // A single consumer drains it, so we never have concurrent writeSSE calls.
      const writeQueue: Array<{ event: string; data: string }> = [];
      let draining = false;
      let streamClosed = false;

      async function drainQueue(): Promise<void> {
        if (draining || streamClosed) return;
        draining = true;
        while (writeQueue.length > 0 && !streamClosed) {
          const item = writeQueue.shift()!;
          try {
            await stream.writeSSE(item);
          } catch {
            streamClosed = true;
          }
        }
        draining = false;
      }

      function enqueueSSE(event: string, data: string): void {
        if (streamClosed) return;
        writeQueue.push({ event, data });
        drainQueue();
      }

      try {
        // 1. Create shielded namespace
        const { nsIp } = createShieldedNamespace(project, port);
        nsCreated = true;

        // 2. Apply egress whitelist
        applyWhitelist(project, destinations);

        // 3. Send metadata
        await stream.writeSSE({
          event: 'meta',
          data: JSON.stringify({
            project,
            cmd,
            port,
            nsIp,
            installCmd,
            previewUrl: `http://${nsIp}:${port}`,
          }),
        });

        // 4. Build redactor for secret scrubbing
        const redact = createRedactor(secretValues);

        // 5. Execute in namespace
        const shielded = execInNamespace(project, {
          command,
          cwd: workspaceDir,
          env: secretEnv,
          writableDirs: ['.cache', 'node_modules', '.next', '.vite', 'dist', '__pycache__'],
        }, secretValues);

        // 6. Stream stdout/stderr via write queue (back-pressure safe)
        shielded.child.stdout?.on('data', (chunk: Buffer) => {
          enqueueSSE('stdout', redact(chunk.toString()));
        });

        shielded.child.stderr?.on('data', (chunk: Buffer) => {
          enqueueSSE('stderr', redact(chunk.toString()));
        });

        // 7. Wait for process exit or client disconnect
        await new Promise<void>((resolve) => {
          shielded.child.on('close', (code) => {
            enqueueSSE('exit', JSON.stringify({ code: code ?? 1 }));
            // Allow queue to drain before resolving
            const waitDrain = setInterval(() => {
              if (writeQueue.length === 0 || streamClosed) {
                clearInterval(waitDrain);
                resolve();
              }
            }, 50);
          });

          shielded.child.on('error', (err) => {
            enqueueSSE('error', JSON.stringify({ message: err.message }));
            resolve();
          });

          // Handle client disconnect
          stream.onAbort(() => {
            streamClosed = true;
            try { shielded.child.kill('SIGTERM'); } catch {}
            // Give the process 5s to exit gracefully, then SIGKILL
            setTimeout(() => {
              try { shielded.child.kill('SIGKILL'); } catch {}
            }, 5000);
            resolve();
          });
        });
      } catch (err) {
        if (!streamClosed) {
          try {
            await stream.writeSSE({
              event: 'error',
              data: JSON.stringify({ message: (err as Error).message }),
            });
          } catch {
            streamClosed = true;
          }
        }
      } finally {
        // 8. Cleanup: destroy namespace but preserve workspace
        if (nsCreated) {
          try { destroyNamespace(project); } catch {}
        }
        // Release read lock
        try { execLock.releaseRead(); } catch {}
        logAuditEvent({
          type: 'exec_end',
          ip,
          details: { project, cmd },
        });
      }
    });
  });
}
