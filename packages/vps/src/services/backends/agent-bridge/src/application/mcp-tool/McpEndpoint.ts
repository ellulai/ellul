// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * MCP Endpoint Service
 *
 * Exposes the agent-bridge's MCP gateway as an inbound MCP server so that
 * agents running inside per-project namespaces (OpenCode, Claude Code, Codex)
 * can discover and call governed tools — including execute_code (code-mode),
 * platform tools, and any externally-connected MCP server tools.
 *
 * Architecture:
 *   - Separate HTTP server on 0.0.0.0:7702 (isolated from the main WebSocket bridge on 7700)
 *   - Reachable from namespaces directly via HOST_IP:7702 (no DNAT required)
 *   - MCP JSON-RPC 2.0 over HTTP POST (streamable-http transport)
 *   - Per-project HMAC authentication (derived from jwt-secret, not stored)
 *   - ToolCallContext constructed server-side only (threadId from bridge state, never from caller)
 *
 * Port history: 7701 was the original MCP port, but ellul-term-proxy
 * also claims 7701. The collision manifested only after term-proxy's real
 * bundle shipped (earlier builds used a no-op placeholder that never bound).
 * MCP moved to 7702 and switched to 0.0.0.0 binding simultaneously so
 * namespaces stopped depending on a per-project DNAT-to-loopback rule.
 *
 * Security invariants:
 *   - Every tools/call goes through the full gate pipeline (same as direct callTool)
 *   - Project identity comes from the verified HMAC token, not the request body
 *   - threadId comes from getActiveThreadId(project), not from the caller
 *   - Port 7702 is not externally reachable (host firewall blocks it at edge)
 *   - Every request carries a per-project HMAC token; a request without a
 *     valid token is rejected before hitting any governed tool
 *   - Session tracking enforces initialize-before-use (MCP spec compliance)
 */

import { isSandboxId } from '@ellul.ai/types';
import * as http from 'http';
import * as fs from 'fs';
import { timingSafeEqual } from 'crypto';

import * as path from 'path';
import { MCP_ENDPOINT_PORT, PROJECTS_DIR } from '../../config';
import { mcpGateway } from './governance/McpGateway';
import type { ToolCallContext } from './governance/McpGateway';
import type { GovernedToolDefinition, ToolCallResult } from './governance/Types';
import { getActiveThreadId } from '../archive/ActiveThread';
import { computeMcpToken } from '../namespace/NamespaceSpawn';

// ── Constants ──

const MCP_PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'ellul-platform', version: '1.0.0' } as const;
const LOG_PREFIX = '[MCP-Endpoint]';

/** Maximum request body size. */
const MAX_BODY_SIZE = 1_048_576;

/** Session TTL — 1 hour. Stale sessions are GC'd periodically. */
const SESSION_TTL_MS = 60 * 60 * 1000;

/** Session GC interval — every 10 minutes. */
const SESSION_GC_INTERVAL_MS = 10 * 60 * 1000;

// ── Server Identity ──

let _serverId: string | null = null;
function getServerId(): string {
  if (_serverId) return _serverId;
  try {
    _serverId = fs.readFileSync('/etc/ellul-bootstrap/server-id', 'utf8').trim();
  } catch {
    _serverId = 'local';
  }
  return _serverId;
}

// ── Session Tracking ──
// MCP spec requires initialize before any other method.
// We track per-project sessions so we can enforce this and
// reject pre-initialize calls with a clear error.

interface McpSession {
  project: string;
  initializedAt: number;
  lastActivity: number;
}

const sessions = new Map<string, McpSession>();

function getOrCreateSession(project: string): McpSession {
  let session = sessions.get(project);
  if (!session) {
    session = { project, initializedAt: 0, lastActivity: Date.now() };
    sessions.set(project, session);
  }
  session.lastActivity = Date.now();
  return session;
}

function isSessionInitialized(project: string): boolean {
  const session = sessions.get(project);
  return !!session && session.initializedAt > 0;
}

/** Remove stale sessions (no activity for SESSION_TTL_MS). */
function gcSessions(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [key, session] of sessions) {
    if (session.lastActivity < cutoff) sessions.delete(key);
  }
}

// ── Token Verification ──

/**
 * Verify a per-project HMAC token and extract the project slug.
 *
 * The token is sent as `Authorization: Bearer <hex>` and the project slug
 * as `x-mcp-project: <slug>`. The bridge recomputes the HMAC for the
 * claimed project and compares timing-safely.
 *
 * Returns the validated project slug, or null on failure.
 */
function verifyMcpToken(req: http.IncomingMessage): string | null {
  const authHeader = req.headers['authorization'];
  const project = req.headers['x-mcp-project'] as string | undefined;

  if (!authHeader || !project) return null;
  if (!authHeader.startsWith('Bearer ')) return null;

  // Validate project slug format (sbx-xxxxxxx) to prevent HMAC oracle on arbitrary strings
  if (!isSandboxId(project)) return null;

  const presentedToken = authHeader.slice(7);
  const expectedToken = computeMcpToken(project);
  if (!expectedToken) return null;

  // Timing-safe comparison (fixed-length HMAC hex strings)
  if (presentedToken.length !== expectedToken.length) return null;
  const a = Buffer.from(presentedToken, 'utf8');
  const b = Buffer.from(expectedToken, 'utf8');
  if (!timingSafeEqual(a, b)) return null;

  return project;
}

// ── ToolCallContext Construction ──

/**
 * Resolve sandbox ID to the app-scoped project path registered in the DB.
 *
 * MCP relay tokens are sandbox-scoped (e.g. "sbx-xyz"), but projects are
 * registered in the orchestration DB under their app directory (e.g.
 * "sbx-xyz/my-app"). The sandbox root's `ellul.json` stores `activeApp`
 * which tells us which app the user has selected.
 */
function resolveAppProject(sandboxId: string): string {
  try {
    const metaPath = path.join(PROJECTS_DIR, sandboxId, 'ellul.json');
    const raw = fs.readFileSync(metaPath, 'utf8');
    const meta = JSON.parse(raw) as { activeApp?: string | null };
    if (meta.activeApp && typeof meta.activeApp === 'string') {
      return `${sandboxId}/${meta.activeApp}`;
    }
  } catch { /* sandbox has no ellul.json or no activeApp — use sandbox root */ }
  return sandboxId;
}

/**
 * Build a ToolCallContext entirely from server-side state.
 * The threadId comes from the bridge's active-thread tracking (SQLite-backed),
 * NOT from any field in the MCP request.
 *
 * MCP relay sends the sandbox ID; we resolve it to the app directory so the
 * thread lookup matches the workspace_root in projection_projects.
 */
function buildToolCallContext(project: string): ToolCallContext | null {
  const sandboxId = project.split('/')[0] || project;
  const appProject = resolveAppProject(sandboxId);
  const threadId = getActiveThreadId(appProject);
  if (!threadId) return null;

  return {
    threadId,
    sandboxId,
    serverId: getServerId(),
    userId: 'owner',
    callerType: 'agent',
  };
}

// ── JSON-RPC Helpers ──

function jsonRpcResponse(id: number | string | null, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function jsonRpcError(id: number | string | null, code: number, message: string, data?: unknown): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  });
}

// ── MCP Method Handlers ──

function handleInitialize(id: number | string, project: string): string {
  const session = getOrCreateSession(project);
  session.initializedAt = Date.now();

  console.log(`${LOG_PREFIX} Session initialized for ${project}`);

  return jsonRpcResponse(id, {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
  });
}

function handleToolsList(id: number | string): string {
  const allTools = mcpGateway.getAllGovernedTools();
  const visible = allTools.filter(
    (t: GovernedToolDefinition) => t.lifecycleStatus === 'approved' && t.exposureStatus === 'agent_visible',
  );

  const tools = visible.map((t: GovernedToolDefinition) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));

  return jsonRpcResponse(id, { tools });
}

async function handleToolsCall(
  id: number | string,
  params: { name?: string; arguments?: Record<string, unknown> },
  project: string,
): Promise<string> {
  const { name: toolName, arguments: args } = params;
  if (!toolName) {
    return jsonRpcError(id, -32602, 'Missing required parameter: name');
  }

  const context = buildToolCallContext(project);
  if (!context) {
    return jsonRpcError(id, -32000,
      `No active chat thread for project "${project}". Open the project in the browser and start a conversation first.`);
  }

  const allTools = mcpGateway.getAllGovernedTools();
  const toolDef = allTools.find(
    (t: GovernedToolDefinition) =>
      t.name === toolName && t.lifecycleStatus === 'approved' && t.exposureStatus === 'agent_visible',
  );
  if (!toolDef) {
    return jsonRpcError(id, -32602, `Tool "${toolName}" not found or not available`);
  }

  const connectionId = toolDef.provider.providerId;

  try {
    const result: ToolCallResult = await mcpGateway.callTool(connectionId, toolName, args || {}, context);
    return mapToolCallResult(id, result, context.threadId);
  } catch (err) {
    const error = err as Error;
    console.error(`${LOG_PREFIX} Tool call error (${toolName}):`, error.message);
    return jsonRpcError(id, -32000, `Tool execution failed: ${error.message}`);
  }
}

/**
 * Map a ToolCallResult to an MCP JSON-RPC response.
 *
 * For approval_required: returns structured data so the agent can
 * programmatically request the gate via the existing sovereign-shield
 * curl pattern documented in CLAUDE.md.
 */
function mapToolCallResult(id: number | string, result: ToolCallResult, threadId: string): string {
  switch (result.status) {
    case 'success': {
      const text = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
      return jsonRpcResponse(id, { content: [{ type: 'text', text }] });
    }

    case 'approval_required': {
      // The agent-bridge has ALREADY proactively triggered the gate
      // popup for the user via the McpGateway.onApprovalRequired
      // callback (wired in main.ts). The model does NOT need to do
      // anything to show a popup — it's already showing. All the model
      // should do is tell the user what it's waiting for, then STOP
      // the current turn. When the user approves, the gate opens and
      // the model can retry the tool on its next turn.
      //
      // Critically: we do NOT tell the model to run a curl command.
      // The old copy did that, and models dutifully repeated the curl
      // instructions into chat without ever actually running them,
      // which created the "please approve the gate, waiting..." loop
      // with no popup ever appearing.
      return jsonRpcResponse(id, {
        content: [
          {
            type: 'text',
            text:
              `Approval required for "${result.requiredCapability}" (gate: ${result.requiredGate}).\n\n`
              + `A popup has been shown to the user in the chat UI. `
              + `Stop the current action and tell the user briefly what you need approval for — `
              + `do NOT instruct them to run any command, click any link, or copy any token. `
              + `When the user approves in the UI, retry this tool on your next turn.`,
          },
          {
            type: 'text',
            text: JSON.stringify({
              gate: result.requiredGate,
              capability: result.requiredCapability,
              threadId,
              reason: result.reason,
              popupAlreadyShown: true,
            }),
          },
        ],
        isError: true,
      });
    }

    case 'denied':
      return jsonRpcResponse(id, {
        content: [{ type: 'text', text: `Denied by policy: ${result.reason} (capability: ${result.deniedCapability})` }],
        isError: true,
      });

    case 'error':
      return jsonRpcResponse(id, {
        content: [{ type: 'text', text: `Tool error: ${result.message} (code: ${result.errorCode}, retryable: ${result.retryable})` }],
        isError: true,
      });

    default:
      return jsonRpcError(id, -32000, 'Unexpected tool call result status');
  }
}

// ── HTTP Request Handler ──

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // Only POST /mcp
  if (req.method !== 'POST' || (req.url !== '/mcp' && req.url !== '/mcp/')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  // Verify project HMAC token
  const project = verifyMcpToken(req);
  if (!project) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized: invalid or missing MCP token' }));
    return;
  }

  // Read body with size limit
  const chunks: Buffer[] = [];
  let totalSize = 0;
  for await (const chunk of req) {
    totalSize += (chunk as Buffer).length;
    if (totalSize > MAX_BODY_SIZE) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Payload too large' }));
      return;
    }
    chunks.push(chunk as Buffer);
  }

  let body: { jsonrpc?: string; id?: number | string; method?: string; params?: unknown };
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(jsonRpcError(null, -32700, 'Parse error'));
    return;
  }

  if (body.jsonrpc !== '2.0') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(jsonRpcError(body.id ?? null, -32600, 'Invalid JSON-RPC version'));
    return;
  }

  const { id, method, params } = body;

  // Notifications (no id) — acknowledge silently per MCP spec
  if (id === undefined || id === null) {
    res.writeHead(204);
    res.end();
    return;
  }

  // Session enforcement: initialize must be called before any other method
  if (method !== 'initialize' && !isSessionInitialized(project)) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(jsonRpcError(id, -32002, 'Server not initialized. Call "initialize" first.'));
    return;
  }

  // Keep session alive on every authenticated request (tools/list, tools/call).
  // Without this, only handleInitialize refreshed lastActivity, so the GC
  // would reap active sessions after SESSION_TTL_MS regardless of tool usage.
  const session = sessions.get(project);
  if (session) session.lastActivity = Date.now();

  let response: string;

  switch (method) {
    case 'initialize':
      response = handleInitialize(id, project);
      break;

    case 'tools/list':
      response = handleToolsList(id);
      break;

    case 'tools/call':
      response = await handleToolsCall(id, (params as Record<string, unknown>) || {}, project);
      break;

    default:
      response = jsonRpcError(id, -32601, `Method not found: ${method}`);
  }

  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(response);
}

// ── Server Lifecycle ──

let server: http.Server | null = null;
let gcTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the MCP endpoint HTTP server on 0.0.0.0:7702.
 *
 * Binds to all interfaces. Namespace agents reach it via PREROUTING DNAT
 * (HOST_IP:7702 → 127.0.0.1:7702) set up by network-setup.sh. The 0.0.0.0
 * binding ensures the DNAT-rewritten traffic (arriving on loopback) and any
 * direct host-side traffic both land on the same listener.
 *
 * HMAC-SHA256 per-project token auth on every request (no token = 401).
 * Firewall blocks 7702 from the public network at the host edge.
 */
export function startMcpEndpoint(): void {
  if (server) return;

  server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error(`${LOG_PREFIX} Unhandled error:`, (err as Error).message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    });
  });

  server.listen(MCP_ENDPOINT_PORT, '0.0.0.0', () => {
    console.log(`${LOG_PREFIX} MCP endpoint listening on 0.0.0.0:${MCP_ENDPOINT_PORT}`);
  });

  server.on('error', (err) => {
    console.error(`${LOG_PREFIX} Server error:`, err.message);
  });

  // Periodic session GC
  gcTimer = setInterval(gcSessions, SESSION_GC_INTERVAL_MS);
  if (gcTimer.unref) gcTimer.unref(); // don't keep process alive for GC
}

/**
 * Stop the MCP endpoint server gracefully.
 */
export function stopMcpEndpoint(): Promise<void> {
  if (gcTimer) {
    clearInterval(gcTimer);
    gcTimer = null;
  }
  sessions.clear();

  return new Promise((resolve) => {
    if (!server) { resolve(); return; }
    server.close(() => {
      server = null;
      console.log(`${LOG_PREFIX} MCP endpoint stopped`);
      resolve();
    });
  });
}
