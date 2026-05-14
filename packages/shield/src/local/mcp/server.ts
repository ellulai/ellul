// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Local MCP stdio subprocess. Stateless; connects to daemon via UDS or TCP fallback.
// Tools: ellul_exec, ellul_list_guardrails, ellul_propose_rule_change, ellul_gate_*, ellul_env_*, ellul_scan.

import fs from 'fs';
import path from 'path';
import http from 'http';

// ── Daemon Discovery ──

const CONFIG_DIR = path.join(process.env.HOME || '~', '.ellul');
const SOCKET_PATH = path.join(CONFIG_DIR, 'daemon.sock');
const PORT_FILE = path.join(CONFIG_DIR, 'proxy.port');
const NONCE_FILE = path.join(CONFIG_DIR, 'daemon.nonce');

interface LocalProject {
  projectSlug?: string;
  projectName?: string;
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

interface DaemonConnection {
  type: 'unix' | 'tcp';
  socketPath?: string;
  host?: string;
  port?: number;
  nonce?: string;
}

function discoverDaemon(): DaemonConnection | null {
  // Try Unix socket first
  if (fs.existsSync(SOCKET_PATH)) {
    return { type: 'unix', socketPath: SOCKET_PATH };
  }

  // Try TCP fallback
  try {
    const raw = fs.readFileSync(PORT_FILE, 'utf8').trim();
    const [portStr, pidStr] = raw.split(':');
    const port = parseInt(portStr, 10);
    const pid = pidStr ? parseInt(pidStr, 10) : 0;
    if (isNaN(port) || port <= 0) return null;

    // Verify PID alive
    if (pid) {
      try { process.kill(pid, 0); } catch { return null; }
    }

    let nonce: string | undefined;
    try { nonce = fs.readFileSync(NONCE_FILE, 'utf8').trim(); } catch {}

    return { type: 'tcp', host: '127.0.0.1', port, nonce };
  } catch {
    return null;
  }
}

// ── HTTP over Unix Socket ──

/** Single HTTP request attempt to the daemon. */
function makeRequestOnce(
  conn: DaemonConnection,
  method: string,
  urlPath: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...extraHeaders,
    };

    if (conn.nonce) {
      headers['X-Daemon-Nonce'] = conn.nonce;
    }

    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    if (bodyStr) {
      headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
    }

    const options: http.RequestOptions = {
      method,
      path: urlPath,
      headers,
    };

    if (conn.type === 'unix') {
      options.socketPath = conn.socketPath;
    } else {
      options.hostname = conn.host;
      options.port = conn.port;
    }

    const req = http.request(options, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode || 500, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode || 500, data: { error: data || `HTTP ${res.statusCode}` } });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/**
 * HTTP request with retry + exponential backoff.
 * Retries on ECONNREFUSED, ENOENT (socket missing), ECONNRESET.
 * Does NOT retry on 4xx/5xx (those are valid daemon responses).
 * Max 3 attempts: immediate → 500ms → 1500ms.
 */
const MAX_RETRIES = 3;
const RETRY_DELAYS = [0, 500, 1500]; // ms

async function makeRequest(
  conn: DaemonConnection,
  method: string,
  urlPath: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; data: unknown }> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
      // Re-discover daemon (may have restarted)
      const freshConn = discoverDaemon();
      if (freshConn) {
        conn = freshConn;
      }
    }

    try {
      return await makeRequestOnce(conn, method, urlPath, body, extraHeaders);
    } catch (err) {
      lastError = err as Error;
      const code = (err as NodeJS.ErrnoException).code;

      // Retryable errors: connection failures
      if (code === 'ECONNREFUSED' || code === 'ENOENT' || code === 'ECONNRESET' || code === 'EPIPE') {
        process.stderr.write(`[mcp-local] Daemon connection failed (attempt ${attempt + 1}/${MAX_RETRIES}): ${code}\n`);
        continue;
      }

      // Non-retryable: timeout, other errors
      throw err;
    }
  }

  throw lastError || new Error('All retry attempts exhausted');
}

// ── Tool Result Helpers ──

/**
 * Consume an SSE stream from the daemon exec/run endpoint.
 * Collects stdout/stderr chunks and returns combined output + exit code.
 * Used for ellul_exec which the daemon serves as Server-Sent Events.
 */
function consumeSSEExec(
  conn: DaemonConnection,
  body: unknown,
  extraHeaders?: Record<string, string>,
  timeoutMs: number = 300_000,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Execution timed out'));
    }, timeoutMs);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      ...extraHeaders,
    };
    if (conn.nonce) headers['X-Daemon-Nonce'] = conn.nonce;

    const bodyStr = JSON.stringify(body);
    headers['Content-Length'] = String(Buffer.byteLength(bodyStr));

    const options: http.RequestOptions = {
      method: 'POST',
      path: '/_local/exec/run',
      headers,
    };
    if (conn.type === 'unix') {
      options.socketPath = conn.socketPath;
    } else {
      options.hostname = conn.host;
      options.port = conn.port;
    }

    const req = http.request(options, (res) => {
      const contentType = res.headers['content-type'] || '';

      // Non-SSE response (JSON error from pre-exec checks)
      if (!contentType.includes('text/event-stream')) {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          clearTimeout(timer);
          try { resolve({ status: res.statusCode || 500, data: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode || 500, data: { error: data } }); }
        });
        return;
      }

      // SSE stream — parse events
      let stdout = '';
      let stderr = '';
      let exitCode: number | null = null;
      let meta: Record<string, unknown> | null = null;
      let errorMsg: string | null = null;
      let buffer = '';
      let currentEvent = '';
      let currentData = '';

      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('event:')) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            currentData = line.slice(5).trim();
          } else if (line === '') {
            if (currentEvent && currentData) {
              switch (currentEvent) {
                case 'stdout': stdout += currentData; break;
                case 'stderr': stderr += currentData; break;
                case 'exit':
                  try { exitCode = JSON.parse(currentData).code ?? null; } catch {}
                  break;
                case 'meta':
                  try { meta = JSON.parse(currentData); } catch {}
                  break;
                case 'error':
                  try { errorMsg = JSON.parse(currentData).message || currentData; }
                  catch { errorMsg = currentData; }
                  break;
              }
            }
            currentEvent = '';
            currentData = '';
          }
        }
      });

      res.on('end', () => {
        clearTimeout(timer);
        if (errorMsg) {
          resolve({ status: 500, data: { error: errorMsg, stdout, stderr } });
          return;
        }
        resolve({
          status: 200,
          data: {
            ok: exitCode === 0,
            exitCode: exitCode ?? (stderr && !stdout ? 1 : 0),
            stdout, stderr, meta,
          },
        });
      });
    });

    req.on('error', (err) => { clearTimeout(timer); reject(err); });
    req.write(bodyStr);
    req.end();
  });
}

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function toolSuccess(content: unknown): ToolResult {
  return {
    content: [{
      type: 'text' as const,
      text: typeof content === 'string' ? content : JSON.stringify(content, null, 2),
    }],
  };
}

function toolError(error: string, details?: Record<string, unknown>): ToolResult {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ error, ...details }, null, 2),
    }],
    isError: true,
  };
}

function daemonNotRunning(): ToolResult {
  return toolError('daemon_not_running', {
    message: 'ellul daemon is not running. Start it with: ellul',
  });
}

// ── Tool Definitions ──

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'ellul_exec',
    description:
      'Execute a command with guardrail protection. In capability mode (default), ' +
      'only test/build/lint/dev commands are allowed. The command is scanned by ' +
      'tree-sitter AST analysis before execution. Secrets are injected as env vars ' +
      'and redacted from output. Requires the appropriate gate to be open.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to execute (e.g., "npm test")' },
        timeout: { type: 'number', description: 'Timeout in seconds (default: 300)' },
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
      'locally and the user sees it in their REPL. DO NOT retry the ' +
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
      'Request a gate to be opened. This prompts the developer in the REPL. ' +
      'The developer must approve before the gate opens. ' +
      'Provide a clear reason — the developer sees it.',
    inputSchema: {
      type: 'object',
      properties: {
        gate: {
          type: 'string',
          description: 'Gate to request',
          enum: ['test', 'build', 'lint', 'dev', 'exec'],
        },
        reason: { type: 'string', description: 'Why you need this gate — shown to the developer' },
      },
      required: ['gate', 'reason'],
    },
  },
  {
    name: 'ellul_gate_status',
    description: 'Check current gate states for the project.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'ellul_env_read',
    description:
      'List secret names stored for this project. Values are NOT returned — ' +
      'they are automatically injected as environment variables during ellul_exec.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'ellul_env_import',
    description:
      'Import environment variables from .env file content. ' +
      'Each value is encrypted and stored locally. ' +
      'Values are automatically injected during ellul_exec.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The .env file content to parse and import' },
      },
      required: ['content'],
    },
  },
  {
    name: 'ellul_scan',
    description:
      'Manually trigger a guardrail scan against the current workspace. ' +
      'Returns findings without executing anything.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// ── Tool Handlers ──

async function handleTool(
  toolName: string,
  args: Record<string, unknown>,
  conn: DaemonConnection,
  project: string,
): Promise<ToolResult> {
  const projectHeader = { 'X-Ellul-Project': project };

  try {
    switch (toolName) {
      case 'ellul_exec': {
        const command = args.command as string;
        if (!command) return toolError('missing_parameter', { message: 'command is required' });

        // Use SSE streaming to consume exec output with real-time redaction
        const { status, data } = await consumeSSEExec(conn, {
          project,
          command,
          timeout: args.timeout,
          stream: true,
        }, projectHeader, (args.timeout as number || 300) * 1000);

        const body = data as Record<string, unknown>;

        if (status === 403) {
          if (body.error === 'command_not_allowed') {
            return toolError('command_not_allowed', {
              message: 'This command is not in the capability allowlist. ' +
                'Allowed: test, build, lint, dev commands (npm test, go build, etc.). ' +
                'Ask the developer to enable unrestricted mode if needed.',
              ...body,
            });
          }
          if (body.error === 'gate_closed') {
            return toolError('gate_closed', {
              message: `The ${body.gate} gate is closed. Call ellul_gate_request to request access.`,
              ...body,
            });
          }
          if (body.error === 'guardrail_blocked') {
            return toolError('policy_violation', {
              message: 'Your code was blocked by a guardrail policy — NOT a permission issue. ' +
                'The gate is open. Fix the violations listed in findings.',
              ...body,
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
          return toolError('forbidden', body);
        }

        if (status >= 500) return toolError('daemon_error', body);
        return toolSuccess(data);
      }

      case 'ellul_list_guardrails': {
        const { status, data } = await makeRequest(conn, 'GET', '/_local/guardrails/rules', undefined, projectHeader);
        if (status >= 400) return toolError('request_failed', data as Record<string, unknown>);
        return toolSuccess(data);
      }

      case 'ellul_propose_rule_change': {
        const reason = args.reason as string;
        if (!reason) return toolError('missing_parameter', { message: 'reason is required' });

        const { status, data } = await makeRequest(conn, 'POST', '/_local/guardrails/propose', {
          rule_id: args.rule_id,
          action: args.action,
          reason,
          payload: args.payload,
        }, projectHeader);

        if (status === 403) return toolError('proposal_rejected', data as Record<string, unknown>);
        if (status >= 400) return toolError('proposal_failed', data as Record<string, unknown>);
        return toolSuccess(data);
      }

      case 'ellul_gate_request': {
        const gate = args.gate as string;
        const reason = args.reason as string;
        if (!gate) return toolError('missing_parameter', { message: 'gate is required' });
        if (!reason) return toolError('missing_parameter', { message: 'reason is required' });

        const { status, data } = await makeRequest(conn, 'POST', '/_local/gates/request', {
          gate,
          project,
          reason,
        }, projectHeader);

        if (status >= 400) return toolError('request_failed', data as Record<string, unknown>);
        return toolSuccess(data);
      }

      case 'ellul_gate_status': {
        const { status, data } = await makeRequest(
          conn, 'GET', `/_local/gates?project=${encodeURIComponent(project)}`,
          undefined, projectHeader,
        );
        if (status >= 400) return toolError('request_failed', data as Record<string, unknown>);
        return toolSuccess(data);
      }

      case 'ellul_env_read': {
        const { status, data } = await makeRequest(
          conn, 'GET', `/_local/secrets?project=${encodeURIComponent(project)}`,
          undefined, projectHeader,
        );
        if (status >= 400) return toolError('request_failed', data as Record<string, unknown>);
        return toolSuccess(data);
      }

      case 'ellul_env_import': {
        const content = args.content as string;
        if (!content) return toolError('missing_parameter', { message: 'content is required' });

        const { status, data } = await makeRequest(conn, 'POST', '/_local/secrets/import', {
          project,
          content,
        }, projectHeader);

        if (status >= 400) return toolError('import_failed', data as Record<string, unknown>);
        return toolSuccess(data);
      }

      case 'ellul_scan': {
        const { status, data } = await makeRequest(conn, 'POST', '/_local/exec/scan', {
          project,
        }, projectHeader);

        if (status >= 400) return toolError('scan_failed', data as Record<string, unknown>);
        return toolSuccess(data);
      }

      default:
        return toolError('unknown_tool', { message: `Unknown tool: ${toolName}` });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('ECONNREFUSED') || message.includes('ENOENT')) {
      return daemonNotRunning();
    }
    return toolError('internal_error', { message });
  }
}

// ── JSON-RPC over stdio ──

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
}

function sendResponse(id: number | string, result: unknown): void {
  const msg = { jsonrpc: '2.0', id, result };
  const json = JSON.stringify(msg);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

function sendError(id: number | string | undefined, code: number, message: string): void {
  const msg = {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message },
  };
  const json = JSON.stringify(msg);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

const SERVER_INFO = { name: 'ellul-local', version: '0.1.0' };
const SERVER_CAPABILITIES = { tools: {} };

async function handleMessage(
  msg: JsonRpcMessage,
  conn: DaemonConnection | null,
  project: string,
): Promise<void> {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      sendResponse(id!, {
        protocolVersion: '2024-11-05',
        capabilities: SERVER_CAPABILITIES,
        serverInfo: SERVER_INFO,
      });
      break;

    case 'notifications/initialized':
      break;

    case 'tools/list':
      sendResponse(id!, { tools: TOOL_DEFINITIONS });
      break;

    case 'tools/call': {
      const p = params as { name: string; arguments?: Record<string, unknown> } | undefined;
      if (!p?.name) { sendError(id!, -32602, 'Missing tool name'); return; }

      if (!conn) { sendResponse(id!, daemonNotRunning()); return; }
      if (!project) {
        sendResponse(id!, toolError('no_project', {
          message: 'No .ellul/project.json found. Run: ellul init',
        }));
        return;
      }

      const result = await handleTool(p.name, p.arguments ?? {}, conn, project);
      sendResponse(id!, result);
      break;
    }

    case 'ping':
      sendResponse(id!, {});
      break;

    default:
      if (id !== undefined) sendError(id, -32601, `Method not found: ${method}`);
  }
}

// ── stdin Parser (Content-Length framing) ──

function startStdioParser(onMessage: (msg: JsonRpcMessage) => void): void {
  let buffer = '';
  let expectedLength = -1;

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;

    while (true) {
      if (expectedLength === -1) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) break;

        const header = buffer.slice(0, headerEnd);
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) { buffer = buffer.slice(headerEnd + 4); continue; }

        expectedLength = parseInt(match[1], 10);
        buffer = buffer.slice(headerEnd + 4);
      }

      if (expectedLength >= 0 && buffer.length >= expectedLength) {
        const body = buffer.slice(0, expectedLength);
        buffer = buffer.slice(expectedLength);
        expectedLength = -1;

        try { onMessage(JSON.parse(body) as JsonRpcMessage); } catch {}
      } else {
        break;
      }
    }
  });
}

// ── Main ──

/**
 * Start the local MCP server. Called by the unified MCP entry point.
 */
export async function startLocalMcp(): Promise<void> {
  const project = readLocalProject();
  const projectSlug = project.projectSlug || '';

  if (!projectSlug) {
    process.stderr.write('[mcp] Warning: No .ellul/project.json found. Tools will fail.\n');
  }

  const conn = discoverDaemon();
  if (!conn) {
    process.stderr.write('[mcp] Warning: ellul daemon not running. Start with: ellul\n');
  }

  startStdioParser((msg) => {
    // Re-discover daemon on each message (daemon may have restarted)
    const currentConn = discoverDaemon();
    handleMessage(msg, currentConn, projectSlug).catch((err) => {
      process.stderr.write(`[mcp] Error: ${err}\n`);
      if (msg.id !== undefined) {
        sendError(msg.id, -32603, 'Internal error');
      }
    });
  });
}
