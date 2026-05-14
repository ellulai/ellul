// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.
// MCP stdio subprocess: stateless; all state in daemon. Discovers daemon via ~/.ellul/proxy.port.
// Code-dependent tools (db_write, git_push, deploy, exec) require sync receipt; others go direct.

import fs from 'fs';
import path from 'path';
import { parseEnvContent } from '../shared/env-parser';
import { fetchPublicKey, encryptAndUploadBulk } from './cli-crypto';

// ── Project & Daemon Discovery ──

const CONFIG_DIR = `${process.env.HOME}/.ellul`;
const PORT_FILE = path.join(CONFIG_DIR, 'proxy.port');

interface LocalProject {
  projectSlug?: string;
  projectName?: string;
  projectId?: string;
  domain?: string;
}

function readLocalProject(): LocalProject {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(process.cwd(), '.ellul', 'project.json'), 'utf8'),
    );
  } catch {
    return {};
  }
}

function readProxyPort(): number | null {
  try {
    const raw = fs.readFileSync(PORT_FILE, 'utf8').trim();
    const [portStr, pidStr] = raw.split(':');
    const port = parseInt(portStr, 10);
    const pid = pidStr ? parseInt(pidStr, 10) : 0;
    if (isNaN(port) || port <= 0) return null;

    // Verify PID is alive
    if (pid) {
      try {
        process.kill(pid, 0);
      } catch {
        return null;
      }
    }
    return port;
  } catch {
    return null;
  }
}

// ── HTTP Helpers ──

async function proxyRequest(
  port: number,
  method: string,
  urlPath: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; data: unknown }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...extraHeaders,
  };

  const resp = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const data = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
  return { status: resp.status, data };
}

async function consumeSSEStream(
  port: number,
  urlPath: string,
  extraHeaders?: Record<string, string>,
  timeoutMs: number = 300_000,
): Promise<{ status: number; data: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        ...extraHeaders,
      },
      signal: controller.signal,
    });

    // Non-200 means the endpoint returned a JSON error (gate closed, bad params, etc.)
    if (!resp.ok || !resp.body) {
      clearTimeout(timer);
      const data = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
      return { status: resp.status, data };
    }

    // Parse SSE stream
    let stdout = '';
    let stderr = '';
    let exitCode: number | null = null;
    let meta: Record<string, unknown> | null = null;
    let errorMsg: string | null = null;

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = '';
    let currentData = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE lines
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete last line in buffer

      for (const line of lines) {
        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          currentData = line.slice(5).trim();
        } else if (line === '') {
          // Empty line = end of SSE message
          if (currentEvent && currentData) {
            switch (currentEvent) {
              case 'stdout':
                stdout += currentData;
                break;
              case 'stderr':
                stderr += currentData;
                break;
              case 'exit': {
                try {
                  const parsed = JSON.parse(currentData);
                  exitCode = parsed.code ?? null;
                } catch {}
                break;
              }
              case 'meta': {
                try {
                  meta = JSON.parse(currentData);
                } catch {}
                break;
              }
              case 'error': {
                try {
                  const parsed = JSON.parse(currentData);
                  errorMsg = parsed.message || currentData;
                } catch {
                  errorMsg = currentData;
                }
                break;
              }
            }
          }
          currentEvent = '';
          currentData = '';
        }
      }
    }

    clearTimeout(timer);

    if (errorMsg) {
      return { status: 500, data: { error: errorMsg, stdout, stderr } };
    }

    return {
      status: 200,
      data: {
        ok: true,
        exitCode: exitCode ?? (stderr && !stdout ? 1 : 0),
        stdout,
        stderr,
        meta,
      },
    };
  } catch (err) {
    clearTimeout(timer);
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('abort')) {
      return { status: 408, data: { error: 'Execution timed out' } };
    }
    throw err;
  }
}

// ── Sync Receipt Acquisition ──

interface SyncReceipt {
  hash: string;
  project: string;
  epoch: number;
  timestamp: number;
  signature: string;
}

// Daemon deduplicates receipt fetches across subprocesses.
async function acquireSyncReceipt(port: number, project: string): Promise<SyncReceipt | null> {
  try {
    const { status, data } = await proxyRequest(
      port,
      'POST',
      `/_internal/sync-receipt?project=${encodeURIComponent(project)}`,
    );

    if (status !== 200) {
      return null;
    }

    return data as SyncReceipt;
  } catch {
    return null;
  }
}

// ── Tool Result Helpers ──

function toolSuccess(content: unknown): ToolResult {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof content === 'string' ? content : JSON.stringify(content, null, 2),
      },
    ],
  };
}

function toolError(error: string, details?: Record<string, unknown>): ToolResult {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ error, ...details }, null, 2),
      },
    ],
  };
}

function gateClosed(gate: string): ToolResult {
  return toolError('gate_closed', {
    gate,
    message: `The ${gate} gate is closed. Call ellul_gate_request to request access.`,
    hint: `Provide a reason describing why you need ${gate} access.`,
  });
}

function vpsUnreachable(): ToolResult {
  return toolError('vps_unreachable', {
    message: 'VPS is not reachable. Local git operations are still available.',
  });
}

function daemonNotRunning(): ToolResult {
  return toolError('daemon_not_running', {
    message: 'ellul daemon is not running. Start it with: ellul',
  });
}

// ── MCP Protocol Types ──

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// ── Tool Definitions ──

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'ellul_db_query',
    description:
      'Execute a SQL query via the ellul database proxy. ' +
      'Requires db_read gate for SELECT/EXPLAIN, db_write for INSERT/UPDATE/DELETE, ' +
      'db_migrate for CREATE/ALTER/DROP. Write/migrate operations require code sync.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'SQL query to execute' },
        params: {
          type: 'array',
          description: 'Parameterized query values (optional)',
          items: {},
        },
      },
      required: ['sql'],
    },
  },
  {
    name: 'ellul_git_push',
    description:
      'Push local commits to the remote repository via sovereign git. ' +
      'Requires git gate. Code is synced to VPS before push to ensure consistency.',
    inputSchema: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'Branch to push (default: current)' },
        force: { type: 'boolean', description: 'Force push (default: false)' },
      },
    },
  },
  {
    name: 'ellul_git_pull',
    description:
      'Pull latest changes from the remote repository via sovereign git. ' +
      'Requires git gate. No code sync needed (read-only remote operation).',
    inputSchema: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'Branch to pull (default: current)' },
      },
    },
  },
  {
    name: 'ellul_env_read',
    description:
      'Read environment variables and secrets for the project. ' +
      'Requires env gate. Returns key-value pairs.',
    inputSchema: {
      type: 'object',
      properties: {
        keys: {
          type: 'array',
          description: 'Specific keys to read (optional, default: all)',
          items: { type: 'string' },
        },
      },
    },
  },
  {
    name: 'ellul_env_import',
    description:
      'Import environment variables from a .env file content string. ' +
      'Each value is encrypted client-side before upload. ' +
      'Supports standard .env format: KEY=value, quoted values, comments, export prefix.',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The .env file content to parse and import',
        },
        env: {
          type: 'string',
          description: 'Target environment (default: production)',
          enum: ['production', 'development'],
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'ellul_deploy',
    description:
      'Deploy the application to the VPS. ' +
      'Requires deploy gate. Code is synced before deployment.',
    inputSchema: {
      type: 'object',
      properties: {
        environment: {
          type: 'string',
          description: 'Target environment (default: production)',
          enum: ['production', 'staging'],
        },
      },
    },
  },
  {
    name: 'ellul_exec',
    description:
      'Execute a command in the sovereign namespace on the VPS. ' +
      'Requires exec gate. Code is synced before execution.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to execute' },
        args: {
          type: 'array',
          description: 'Command arguments',
          items: { type: 'string' },
        },
        timeout: {
          type: 'number',
          description: 'Timeout in seconds (default: 300)',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'ellul_list_guardrails',
    description:
      'List all active guardrail rules enforced on this workspace. ' +
      'Call this BEFORE writing code to understand the constraints. ' +
      'Your code is statically analyzed against these rules before execution. ' +
      'Rules marked locked=true cannot be disabled.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'ellul_propose_rule_change',
    description:
      'Propose a guardrail rule modification. Requires human approval. ' +
      'Use this when a rule is blocking correct code. The proposal is stored ' +
      'locally and the user sees it in their dashboard. DO NOT retry the ' +
      'blocked operation until the user approves.',
    inputSchema: {
      type: 'object',
      properties: {
        rule_id: { type: 'string', description: 'ID of the rule to modify (from ellul_list_guardrails)' },
        action: {
          type: 'string',
          description: 'What to do with the rule',
          enum: ['disable', 'modify', 'delete'],
        },
        reason: { type: 'string', description: 'Why this change is needed — be specific' },
        payload: {
          type: 'object',
          description: 'For modify: { query_scm: "new query" }. For disable/delete: omit.',
        },
      },
      required: ['action', 'reason'],
    },
  },
  {
    name: 'ellul_gate_request',
    description:
      'Request a gate to be opened. The developer will see a prompt in their terminal ' +
      'and must approve or deny. Provide a clear reason for why access is needed.',
    inputSchema: {
      type: 'object',
      properties: {
        gate: {
          type: 'string',
          description: 'Gate to request',
          enum: ['db_read', 'db_write', 'db_migrate', 'git', 'env', 'deploy', 'exec', 'logs'],
        },
        reason: { type: 'string', description: 'Why this gate access is needed' },
      },
      required: ['gate', 'reason'],
    },
  },
  {
    name: 'ellul_gate_status',
    description:
      'Check current gate states and policies for the project. ' +
      'Returns which gates are open/closed, their TTL, and policies.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'ellul_gate_grant',
    description:
      'Request to open a gate with a specific duration. The developer MUST approve this ' +
      'from their terminal — you cannot bypass the confirmation. Prefer short durations (5m, 10m).',
    inputSchema: {
      type: 'object',
      properties: {
        gate: {
          type: 'string',
          description: 'Gate to open',
          enum: ['db_read', 'db_write', 'db_migrate', 'git', 'env', 'deploy', 'exec', 'logs'],
        },
        duration: {
          type: 'string',
          description: 'Duration (e.g., "5m", "10m", "1h", "30s")',
        },
        reason: { type: 'string', description: 'Why this gate access is needed' },
      },
      required: ['gate', 'duration', 'reason'],
    },
  },
  {
    name: 'ellul_gate_revoke',
    description: 'Close a gate immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        gate: {
          type: 'string',
          description: 'Gate to close',
          enum: ['db_read', 'db_write', 'db_migrate', 'git', 'env', 'deploy', 'exec', 'logs'],
        },
      },
      required: ['gate'],
    },
  },
  {
    name: 'ellul_policy_set',
    description:
      'Change a gate\'s persistent permission policy. WARNING: This is a security-critical operation. ' +
      'The developer MUST confirm from their terminal. Explain clearly what will change and why BEFORE calling this. ' +
      'NEVER silently change security policies.',
    inputSchema: {
      type: 'object',
      properties: {
        gate: {
          type: 'string',
          description: 'Gate to modify',
          enum: ['db_read', 'db_write', 'db_migrate', 'git', 'env', 'deploy', 'exec', 'logs'],
        },
        policy: {
          type: 'string',
          description: 'New policy',
          enum: ['ask', 'allow_always', 'never'],
        },
        reason: { type: 'string', description: 'Why this policy change is needed' },
      },
      required: ['gate', 'policy', 'reason'],
    },
  },
  {
    name: 'ellul_policy_list',
    description: 'List current permission policies for all gates.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// ── Tool Handlers ──

/** Tools that require a sync receipt (code-dependent operations). */
const CODE_DEPENDENT_TOOLS = new Set([
  'ellul_git_push',
  'ellul_deploy',
  'ellul_exec',
]);

// Heuristic for receipt optimization; VPS gate does the authoritative classification.
function isWriteQuery(sql: string): boolean {
  const upper = sql.trim().toUpperCase();
  const writeKeywords = [
    'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP',
    'TRUNCATE', 'GRANT', 'REVOKE', 'MERGE', 'UPSERT',
  ];
  return writeKeywords.some(kw => upper.startsWith(kw));
}

async function handleTool(
  toolName: string,
  args: Record<string, unknown>,
  port: number,
  project: string,
): Promise<ToolResult> {
  const projectHeader = { 'X-Ellul-Project': project };

  try {
    switch (toolName) {
      // ── Database Query ──
      case 'ellul_db_query': {
        const sql = args.sql as string;
        if (!sql) return toolError('missing_parameter', { message: 'sql is required' });

        // Write queries need sync receipt
        let receiptHeader: Record<string, string> = {};
        if (isWriteQuery(sql)) {
          const receipt = await acquireSyncReceipt(port, project);
          if (receipt) {
            receiptHeader = { 'X-Sync-Receipt': JSON.stringify(receipt) };
          }
        }

        const { status, data } = await proxyRequest(
          port,
          'POST',
          '/api/internal/db/query',
          { sql, params: args.params, project },
          { ...projectHeader, ...receiptHeader },
        );

        if (status === 403) return gateClosed(guessGateFromSql(sql));
        if (status >= 500) return vpsUnreachable();
        return toolSuccess(data);
      }

      // ── Git Push ──
      case 'ellul_git_push': {
        const receipt = await acquireSyncReceipt(port, project);
        if (!receipt) return toolError('sync_failed', { message: 'Failed to sync code to VPS. Is the daemon running?' });

        // Step 1: Obtain an action gate token for git-push via auto-authorize
        const authResp = await proxyRequest(
          port,
          'POST',
          '/api/internal/git-auto-authorize',
          { sandboxId: project, threadId: `mcp-${Date.now()}` },
          projectHeader,
        );

        if (authResp.status === 403) return gateClosed('git');
        if (authResp.status >= 500) return vpsUnreachable();

        const token = (authResp.data as { token?: string })?.token;
        if (!token) {
          return toolError('gate_token_failed', {
            message: 'Failed to obtain git-push authorization. Ensure git gate permission is set to allow_always or allow_session.',
          });
        }

        // Step 2: Execute the push with the action gate token
        const { status, data } = await proxyRequest(
          port,
          'POST',
          '/api/internal/git-push',
          {
            project,
            token,
            force: args.force ?? false,
          },
          { ...projectHeader, 'X-Sync-Receipt': JSON.stringify(receipt) },
        );

        if (status === 403) return gateClosed('git');
        if (status >= 500) return vpsUnreachable();
        return toolSuccess(data);
      }

      // ── Git Pull ──
      case 'ellul_git_pull': {
        const { status, data } = await proxyRequest(
          port,
          'POST',
          '/api/internal/git-pull',
          { project },
          projectHeader,
        );

        if (status === 403) return gateClosed('git');
        if (status >= 500) return vpsUnreachable();
        return toolSuccess(data);
      }

      // ── Environment Read ──
      case 'ellul_env_read': {
        const keys = args.keys as string[] | undefined;
        const qs = keys?.length
          ? `?app=${encodeURIComponent(project)}&keys=${encodeURIComponent(keys.join(','))}`
          : `?app=${encodeURIComponent(project)}`;

        const { status, data } = await proxyRequest(
          port,
          'GET',
          `/_auth/secrets/values${qs}`,
          undefined,
          projectHeader,
        );

        if (status === 403) return gateClosed('env');
        if (status >= 500) return vpsUnreachable();
        return toolSuccess(data);
      }

      // ── Environment Import ──
      case 'ellul_env_import': {
        const content = args.content as string;
        const targetEnv = (args.env as 'production' | 'development') || 'production';

        if (!content || typeof content !== 'string') {
          return toolError('invalid_input', { message: 'content is required and must be a string.' });
        }

        // Parse .env content
        const result = parseEnvContent(content);

        if (result.entries.length === 0) {
          return toolError('empty_input', {
            message: 'No valid entries found in the provided .env content.',
            warnings: result.warnings,
          });
        }

        try {
          const publicKey = await fetchPublicKey(port);
          const entries = result.entries.map(e => ({ key: e.key, value: e.value }));
          const count = await encryptAndUploadBulk(port, publicKey, entries, project, targetEnv);

          return toolSuccess({
            imported: count,
            env: targetEnv,
            keys: result.entries.map(e => e.key),
            warnings: result.warnings.length > 0 ? result.warnings : undefined,
            sensitiveKeys: result.detectedSensitiveKeys.length > 0 ? result.detectedSensitiveKeys : undefined,
          });
        } catch (err) {
          process.stderr.write(`[mcp] env import error: ${err}\n`);
          return toolError('import_failed', { message: 'Failed to import secrets. Ensure the daemon is authenticated.' });
        }
      }

      // ── Deploy ──
      case 'ellul_deploy': {
        const receipt = await acquireSyncReceipt(port, project);
        if (!receipt) return toolError('sync_failed', { message: 'Failed to sync code to VPS.' });

        // Step 1: Obtain a deploy action gate token via auto-authorize
        const authResp = await proxyRequest(
          port,
          'POST',
          '/api/internal/deploy-auto-authorize',
          { sandboxId: project, threadId: `mcp-${Date.now()}` },
          projectHeader,
        );

        if (authResp.status === 403) return gateClosed('deploy');
        if (authResp.status >= 500) return vpsUnreachable();

        const deployToken = (authResp.data as { token?: string })?.token;
        if (!deployToken) {
          return toolError('gate_token_failed', {
            message: 'Failed to obtain deploy authorization. Ensure deploy gate permission is set to allow_always or allow_session.',
          });
        }

        // Step 2: Execute the deployment with the action gate token
        const { status, data } = await proxyRequest(
          port,
          'POST',
          '/api/workflow/expose',
          {
            name: project,
            deployToken,
          },
          { ...projectHeader, 'X-Sync-Receipt': JSON.stringify(receipt) },
        );

        if (status === 403) return gateClosed('deploy');
        if (status >= 500) return vpsUnreachable();
        return toolSuccess(data);
      }

      // ── Guardrail Policy Discovery ──
      case 'ellul_list_guardrails': {
        const { status, data } = await proxyRequest(port, 'GET', '/_auth/guardrail/rules', undefined, projectHeader);
        if (status >= 400) return vpsUnreachable();
        return toolSuccess(data);
      }

      // ── Guardrail Proposal ──
      case 'ellul_propose_rule_change': {
        const reason = args.reason as string;
        if (!reason) return toolError('missing_parameter', { message: 'reason is required' });

        const { status, data } = await proxyRequest(port, 'POST', '/_auth/guardrail/propose', {
          rule_id: args.rule_id || undefined,
          action: args.action,
          reason,
          payload: args.payload || undefined,
        }, projectHeader);

        if (status === 403) return toolError('guardrail_locked', data as Record<string, unknown>);
        if (status >= 400) return toolError('proposal_failed', data as Record<string, unknown>);
        return toolSuccess(data);
      }

      // ── Exec ──
      case 'ellul_exec': {
        const command = args.command as string;
        if (!command) return toolError('missing_parameter', { message: 'command is required' });

        const receipt = await acquireSyncReceipt(port, project);
        if (!receipt) return toolError('sync_failed', { message: 'Failed to sync code to VPS.' });

        // The VPS exec/run endpoint is GET with query params and returns SSE.
        // Valid cmd values: dev, build, test. For arbitrary commands, use the script param.
        const timeoutSec = (args.timeout as number) ?? 300;
        const qs = new URLSearchParams({
          project,
          script: command,
        });

        const { status, data } = await consumeSSEStream(
          port,
          `/_auth/exec/run?${qs.toString()}`,
          { ...projectHeader, 'X-Sync-Receipt': JSON.stringify(receipt) },
          timeoutSec * 1000,
        );

        if (status === 403) {
          const body = data as Record<string, unknown>;
          // Distinguish gate denial from policy violation.
          // Gate denial: { error: '...gate not open...', gate: 'exec' }
          // Policy violation: { error: 'guardrail_blocked', findings: [...] }
          // Policy halt: { error: 'guardrail_halted', message: 'SYSTEM_HALT...' }
          if (body.error === 'guardrail_blocked') {
            return toolError('policy_violation', {
              message: 'Your code was blocked by a policy — NOT a permission issue. ' +
                'The exec gate is open and you have permission to run code. ' +
                'The issue is with the code itself. Review the findings below and fix the violations.',
              strike: body.strike,
              strikes_remaining: body.strikes_remaining,
              findings: body.findings,
              all_active_rules: body.all_active_rules,
              hint: 'Call ellul_list_guardrails to see all active policies. ' +
                'If you believe the policy is wrong, call ellul_propose_rule_change.',
            });
          }
          if (body.error === 'guardrail_halted') {
            return toolError('policy_halt', {
              message: (body.message as string) ||
                'SYSTEM_HALT: You have failed to satisfy policy constraints after 3 attempts. ' +
                'DO NOT RETRY. Ask the human user for help or call ellul_propose_rule_change.',
            });
          }
          // Actual gate denial
          return gateClosed('exec');
        }
        if (status === 408) return toolError('exec_timeout', { message: `Command timed out after ${timeoutSec}s` });
        if (status >= 500) return vpsUnreachable();
        return toolSuccess(data);
      }

      // ── Gate Request ──
      case 'ellul_gate_request': {
        const { status, data } = await proxyRequest(
          port,
          'POST',
          '/_auth/gates/request',
          {
            gate: args.gate,
            reason: args.reason,
            project,
          },
          projectHeader,
        );

        if (status >= 500) return vpsUnreachable();
        return toolSuccess(data);
      }

      // ── Gate Status ──
      case 'ellul_gate_status': {
        const { status, data } = await proxyRequest(
          port,
          'GET',
          `/_auth/gates/active?project=${encodeURIComponent(project)}`,
          undefined,
          projectHeader,
        );

        if (status >= 500) return vpsUnreachable();
        return toolSuccess(data);
      }

      // ── Gate Grant (requires user confirmation in REPL) ──
      case 'ellul_gate_grant': {
        const { status, data } = await proxyRequest(
          port,
          'POST',
          `/_internal/gate-grant`,
          {
            gate: args.gate,
            duration: args.duration,
            reason: args.reason,
            project,
            source: 'agent_mcp',
          },
        );

        if (status >= 500) return vpsUnreachable();
        return toolSuccess(data);
      }

      // ── Gate Revoke ──
      case 'ellul_gate_revoke': {
        const { status, data } = await proxyRequest(
          port,
          'POST',
          `/_internal/gate-revoke`,
          { gate: args.gate, project },
        );

        if (status >= 500) return vpsUnreachable();
        return toolSuccess(data);
      }

      // ── Policy Set (requires user confirmation in REPL) ──
      case 'ellul_policy_set': {
        const { status, data } = await proxyRequest(
          port,
          'POST',
          `/_internal/policy-set`,
          {
            gate: args.gate,
            policy: args.policy,
            reason: args.reason,
            project,
            source: 'agent_mcp',
          },
        );

        if (status >= 500) return vpsUnreachable();
        return toolSuccess(data);
      }

      // ── Policy List ──
      case 'ellul_policy_list': {
        const { status, data } = await proxyRequest(
          port,
          'GET',
          `/api/internal/gate/permissions?sandboxId=${encodeURIComponent(project)}`,
          undefined,
          projectHeader,
        );

        if (status >= 500) return vpsUnreachable();
        return toolSuccess(data);
      }

      default:
        return toolError('unknown_tool', { message: `Unknown tool: ${toolName}` });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('ECONNREFUSED') || message.includes('fetch failed')) {
      return vpsUnreachable();
    }
    return toolError('internal_error', { message });
  }
}

function guessGateFromSql(sql: string): string {
  const upper = sql.trim().toUpperCase();
  if (upper.startsWith('CREATE') || upper.startsWith('ALTER') || upper.startsWith('DROP')) {
    return 'db_migrate';
  }
  if (isWriteQuery(sql)) return 'db_write';
  return 'db_read';
}

// ── JSON-RPC over stdio ──

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function sendResponse(id: number | string, result: unknown): void {
  const msg: JsonRpcMessage = { jsonrpc: '2.0', id, result };
  const json = JSON.stringify(msg);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

function sendError(id: number | string | undefined, code: number, message: string): void {
  const msg: JsonRpcMessage = {
    jsonrpc: '2.0',
    id: id ?? null as unknown as string,
    error: { code, message },
  };
  const json = JSON.stringify(msg);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

function sendNotification(method: string, params?: unknown): void {
  const msg: JsonRpcMessage = { jsonrpc: '2.0', method, params };
  const json = JSON.stringify(msg);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

// ── MCP Protocol Handler ──

const SERVER_INFO = {
  name: 'ellul',
  version: '0.1.0',
};

const SERVER_CAPABILITIES = {
  tools: {},
};

async function handleMessage(
  msg: JsonRpcMessage,
  port: number,
  project: string,
): Promise<void> {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize': {
      sendResponse(id!, {
        protocolVersion: '2024-11-05',
        capabilities: SERVER_CAPABILITIES,
        serverInfo: SERVER_INFO,
      });
      break;
    }

    case 'notifications/initialized': {
      // Client acknowledged initialization — no response needed
      break;
    }

    case 'tools/list': {
      sendResponse(id!, { tools: TOOL_DEFINITIONS });
      break;
    }

    case 'tools/call': {
      const p = params as { name: string; arguments?: Record<string, unknown> } | undefined;
      if (!p?.name) {
        sendError(id!, -32602, 'Missing tool name');
        return;
      }

      const result = await handleTool(p.name, p.arguments ?? {}, port, project);
      sendResponse(id!, result);
      break;
    }

    case 'ping': {
      sendResponse(id!, {});
      break;
    }

    default: {
      if (id !== undefined) {
        sendError(id, -32601, `Method not found: ${method}`);
      }
      // Ignore unknown notifications (no id)
    }
  }
}

// ── stdin Parser (MCP uses Content-Length framing over stdio) ──

function startStdioParser(onMessage: (msg: JsonRpcMessage) => void): void {
  let buffer = '';
  let expectedLength = -1;

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;

    while (true) {
      if (expectedLength === -1) {
        // Look for Content-Length header
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) break;

        const header = buffer.slice(0, headerEnd);
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          // Skip malformed header
          buffer = buffer.slice(headerEnd + 4);
          continue;
        }

        expectedLength = parseInt(match[1], 10);
        buffer = buffer.slice(headerEnd + 4);
      }

      if (expectedLength >= 0 && buffer.length >= expectedLength) {
        const body = buffer.slice(0, expectedLength);
        buffer = buffer.slice(expectedLength);
        expectedLength = -1;

        try {
          const msg = JSON.parse(body) as JsonRpcMessage;
          onMessage(msg);
        } catch {
          // Skip malformed JSON
        }
      } else {
        break;
      }
    }
  });
}

// ── Main ──

export async function startCloudMcp(): Promise<void> {
  const project = readLocalProject();
  // Use immutable slug for X-Ellul-Project header (STS keyed by slug)
  const projectSlug = project.projectSlug;

  if (!projectSlug) {
    // Can't operate without a project — but don't crash,
    // return errors for tool calls instead
    process.stderr.write('[mcp] Warning: No .ellul/project.json found in cwd. Tools will fail.\n');
  }

  const port = readProxyPort();
  if (!port) {
    process.stderr.write('[mcp] Warning: ellul daemon not running. Start with: ellul\n');
  }

  startStdioParser((msg) => {
    // Re-read port on each message (daemon may have restarted)
    const currentPort = readProxyPort();

    if (!currentPort) {
      if (msg.id !== undefined) {
        if (msg.method === 'initialize') {
          // Always respond to initialize even without daemon
          sendResponse(msg.id, {
            protocolVersion: '2024-11-05',
            capabilities: SERVER_CAPABILITIES,
            serverInfo: SERVER_INFO,
          });
        } else if (msg.method === 'tools/list') {
          sendResponse(msg.id, { tools: TOOL_DEFINITIONS });
        } else if (msg.method === 'tools/call') {
          sendResponse(msg.id, daemonNotRunning());
        } else if (msg.method === 'ping') {
          sendResponse(msg.id, {});
        } else {
          sendError(msg.id, -32603, 'ellul daemon not running');
        }
      }
      return;
    }

    handleMessage(msg, currentPort, projectSlug || 'unknown')
      .catch((err) => {
        if (msg.id !== undefined) {
          process.stderr.write(`[mcp] Tool call error: ${err}\n`);
          sendError(msg.id, -32603, 'Internal error processing tool call');
        }
      });
  });

  // Keep process alive until stdin closes
  process.stdin.on('end', () => process.exit(0));
  process.stdin.resume();
}

