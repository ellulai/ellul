// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// MCP Gateway — connects to external MCP servers, classifies tools, gate-checks
// every call via sovereign-shield. Fail-closed on gate errors. Low-confidence
// classification → quarantined (hidden from agents). Tool-list hash detects drift.

import { createHash } from 'crypto';

import type {
  ToolCapability,
  GovernedToolDefinition,
  ToolLifecycleStatus,
  ToolExposureStatus,
  ToolCallResult,
  ProviderIdentity,
  GovernedToolTarget,
  GateType,
  PolicyDecision,
  ProviderTransport,
  ToolPermissionLevel,
  ToolManifestEntry,
} from './Types';

import {
  CAPABILITY_GATE,
  GATEWAY_VERSION,
  TAXONOMY_VERSION,
} from './Types';

import { classifyTool } from './Classifier';
import { evaluatePolicy } from './Policy';
import { callShieldInternal } from '@vps/shared/shield-client';
import type { McpProviderScrubber } from '../../mcp-providers/types';
import {
  SCOPE_CHECK_ENABLED,
  isSandboxScopedCapability,
  extractSharedPathHintsFromJson,
  enrichReasonWithHints,
  recordScopeConfusionDenial,
} from '@vps/shared/cross-project-scope';

// ── Constants ──

const MCP_PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = { name: 'ellul-gateway', version: '1.0.0' } as const;

/** Timeout for MCP protocol initialization and tool discovery. */
const CONNECT_TIMEOUT_MS = 15_000;
/** Timeout for individual MCP tool calls. */
const CALL_TIMEOUT_MS = 30_000;
/** Timeout for health-check probes. */
const HEALTH_CHECK_TIMEOUT_MS = 5_000;
/** Timeout for sovereign-shield gate status checks. */
const GATE_CHECK_TIMEOUT_MS = 3_000;

const LOG_PREFIX = '[MCP-Gateway]';

// ── Public Types ──

export interface McpConnectionConfig {
  connectionId: string;
  url: string;
  transport: 'sse' | 'streamable-http' | 'stdio';
  authToken?: string;
  providerKind: string;
  /** Explicit capability + default permission for known tools. Declared
   *  tools skip the pattern classifier. Default permissions are applied
   *  on connect (user overrides always win). Undeclared tools still go
   *  through the classifier (fail-closed). Scrub layers still apply. */
  toolManifest?: Readonly<Record<string, ToolManifestEntry>>;
  scrubber?: McpProviderScrubber;
}

export interface ToolCallContext {
  threadId: string;
  sandboxId: string;
  serverId: string;
  userId: string;
  callerType: 'human' | 'agent' | 'system';
}

/**
 * A governed tool definition enriched with the effective capability and gate
 * as determined by the policy engine. This is what gets surfaced to the
 * context service for system prompt injection.
 */
export interface ApprovedToolSummary {
  /** Tool name as declared by the provider. */
  toolName: string;
  /** Human-readable description. */
  description: string;
  /** Effective capability after policy evaluation (null if not classified). */
  effectiveCapability: ToolCapability | null;
  /** Provider ID that supplies this tool. */
  providerId: string;
}

// ── Internal Types ──

interface DiscoveredMcpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

type ConnectionStatus = 'connected' | 'connecting' | 'error' | 'disconnected';

interface McpConnectionState {
  config: McpConnectionConfig;
  status: ConnectionStatus;
  tools: Map<string, GovernedToolDefinition>;
  toolListHash: string;
  lastDiscovery: Date | null;
  lastHealthCheck: Date | null;
  error?: string;
  /** Monotonically increasing JSON-RPC message ID for this connection. */
  nextMessageId: number;
}

/** Parsed JSON-RPC response envelope. */
interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Shape of the tools/list result from an MCP server. */
interface ToolsListResult {
  tools: DiscoveredMcpTool[];
}

/** Shape of the tools/call result from an MCP server. */
interface ToolsCallResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
}

/** Response from sovereign-shield gate status endpoint. */
interface GateStatusResponse {
  [gate: string]: boolean | number;
}

// ── Crypto Helpers ──

/**
 * Compute SHA-256 hex digest of a string.
 */
function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Compute a deterministic tool list hash for drift detection.
 * Sorted by name, then hashed over (name + description).
 */
function computeToolListHash(tools: DiscoveredMcpTool[]): string {
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  const payload = sorted.map(t => `${t.name}:${t.description ?? ''}`).join('\n');
  return sha256(payload);
}

/**
 * Compute the definition hash for a single tool.
 */
function computeDefinitionHash(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
): string {
  const payload = JSON.stringify({ name, description, inputSchema });
  return sha256(payload);
}

// ── JSON-RPC Transport ──

/**
 * Send a JSON-RPC request to an MCP server and return the parsed result.
 *
 * Throws on network errors, non-200 responses, and JSON-RPC error responses.
 * Uses AbortSignal.timeout for deadline enforcement.
 */
async function sendJsonRpc(
  url: string,
  method: string,
  id: number,
  params: unknown | undefined,
  authToken: string | undefined,
  timeoutMs: number,
): Promise<unknown> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  const body: Record<string, unknown> = {
    jsonrpc: '2.0',
    method,
    id,
  };
  if (params !== undefined) {
    body.params = params;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `MCP server returned HTTP ${res.status}: ${text.slice(0, 200)}`,
    );
  }

  const contentType = res.headers.get('content-type') ?? '';

  // Streamable-http servers (e.g. gbrain) may respond with SSE even when
  // Accept includes application/json. Parse the first `data:` line that
  // contains a JSON-RPC response.
  if (contentType.includes('text/event-stream')) {
    const text = await res.text();
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try {
        const data = JSON.parse(line.slice(5)) as JsonRpcResponse;
        if (data.error) {
          throw new Error(`MCP JSON-RPC error (${data.error.code}): ${data.error.message || 'Unknown'}`);
        }
        return data.result;
      } catch (e) {
        if (e instanceof SyntaxError) continue;
        throw e;
      }
    }
    throw new Error('No JSON-RPC response found in SSE stream');
  }

  const data = (await res.json()) as JsonRpcResponse;

  if (data.error) {
    const errMsg = data.error.message || 'Unknown MCP error';
    const errCode = data.error.code;
    throw new Error(`MCP JSON-RPC error (${errCode}): ${errMsg}`);
  }

  return data.result;
}

// ── Gate Check ──

/**
 * Check whether a specific Sovereign Gate is open for a thread.
 *
 * Uses the shield-client for authenticated internal API calls.
 * Fail-closed: returns false on any error (shield unreachable, timeout, etc.).
 */
export async function checkGateOpen(
  gate: GateType,
  threadId: string,
  sandboxId?: string | null,
): Promise<boolean> {
  try {
    let url = `/api/internal/gate/status?threadId=${encodeURIComponent(threadId)}`;
    if (sandboxId) url += `&sandboxId=${encodeURIComponent(sandboxId)}`;
    const res = await callShieldInternal(url, { timeout: GATE_CHECK_TIMEOUT_MS });
    if (!res.ok) return false;
    const status = (await res.json()) as GateStatusResponse;
    return status[gate] === true;
  } catch {
    return false;
  }
}

// ── Transport Mapping ──

function toProviderTransport(
  transport: McpConnectionConfig['transport'],
): ProviderTransport {
  return transport as ProviderTransport;
}

// ── Classification Pipeline ──

/**
 * Run a single discovered tool through the classify -> evaluate pipeline,
 * producing a fully governed tool definition.
 */
function classifyAndEvaluateTool(
  rawTool: DiscoveredMcpTool,
  providerIdentity: ProviderIdentity,
  config: McpConnectionConfig,
): GovernedToolDefinition {
  const name = rawTool.name;
  const description = rawTool.description ?? '';
  const inputSchema = rawTool.inputSchema ?? {};
  const now = new Date().toISOString();

  // Step 1: Classify
  let classifierOutput = classifyTool(
    name,
    description,
    Object.keys(inputSchema).length > 0 ? inputSchema : undefined,
    config.providerKind,
    config.transport,
  );

  // Step 1b: Tool manifest override. When the connection declares a
  // toolManifest, declared tools skip the classifier entirely — same
  // pattern as builtin platform tools (PlatformTools.ts buildToolDef).
  // Undeclared tools still go through the classifier (fail-closed).
  const manifestEntry = config.toolManifest?.[name];
  if (manifestEntry) {
    classifierOutput = {
      confidence: 'high',
      capability: manifestEntry.capability,
      signals: [{ source: 'manifest', matched: `${config.providerKind}/${name}`, weight: 1.0 }],
      classifierVersion: classifierOutput.classifierVersion,
      taxonomyVersion: classifierOutput.taxonomyVersion,
    };
  }

  // Step 2: Build target for policy evaluation
  const target: GovernedToolTarget = {
    resourceType: 'mcp_tool',
    resourceId: `${config.connectionId}/${name}`,
    environment: 'sandbox',
    scope: config.connectionId,
  };

  // Step 3: Evaluate policy
  const decision: PolicyDecision = evaluatePolicy({
    classifierOutput,
    providerIdentity,
    target,
    userOverride: null,
    orgPolicy: null,
    transport: toProviderTransport(config.transport),
  });

  // Step 4: Extract capability from classifier output
  const capability: ToolCapability | null =
    classifierOutput.confidence !== 'low'
      ? classifierOutput.capability
      : classifierOutput.suggestedCapability;

  const lifecycleStatus: ToolLifecycleStatus = decision.toolLifecycleStatus;
  const exposureStatus: ToolExposureStatus = decision.exposureStatus;

  return {
    name,
    description,
    inputSchema,
    outputSchema: null,
    provider: providerIdentity,
    capability,
    lifecycleStatus,
    exposureStatus,
    definitionHash: computeDefinitionHash(name, description, inputSchema),
    discoveredAt: now,
    classifiedAt: now,
    taxonomyVersion: TAXONOMY_VERSION,
  };
}

// ── Tool Permission Types ──

interface ToolPermissionEntry {
  permission: ToolPermissionLevel;
  source: 'manifest_default' | 'user_override';
}

/**
 * Composite key for the tool permission map: `{connectionId}:{toolName}`.
 */
function toolPermKey(connectionId: string, toolName: string): string {
  return `${connectionId}:${toolName}`;
}

// ── McpGateway ──

export class McpGateway {
  private connections = new Map<string, McpConnectionState>();

  /**
   * Per-tool permission overrides.
   * Key: `{connectionId}:{toolName}`, value: permission level.
   * Set by the console via WebSocket -> bridge -> this method.
   */
  private toolPermissions = new Map<string, ToolPermissionEntry>();

  // ── Builtin Tools (code-mode, etc.) ──

  private builtinTools = new Map<string, GovernedToolDefinition>();
  private builtinHandlers = new Map<
    string,
    (args: Record<string, unknown>, ctx: ToolCallContext) => Promise<ToolCallResult>
  >();

  /**
   * Callback fired when `callTool` returns `approval_required`. The host
   * wiring (main.ts) injects a handler that proactively triggers the
   * gate_request popup in the chat UI via the normal /api/internal/gate-request
   * flow (with its auto-grant + broadcast semantics). Without this hook,
   * the approval UX was broken: the MCP endpoint used to format a text
   * response telling the AGENT MODEL to curl the gate-request endpoint
   * itself, which models do unreliably — resulting in "please approve
   * the gate" messages in chat with no popup ever appearing.
   *
   * sandboxId is the sandboxId passed to sovereign-shield's auto-grant /
   * auto-deny check — required for env/db/logs gates so the grant is
   * scoped to the correct app. Passing null produces a best-effort popup
   * without auto-grant lookup (used only when no sandbox is attached).
   *
   * The callback is fire-and-forget; the gateway still returns
   * approval_required synchronously so the caller can short-circuit.
   */
  private approvalCallback:
    | ((gate: string, threadId: string, reason: string, toolName: string, sandboxId: string | null) => void)
    | null = null;

  setOnApprovalRequired(
    cb: (gate: string, threadId: string, reason: string, toolName: string, sandboxId: string | null) => void,
  ): void {
    this.approvalCallback = cb;
  }

  /**
   * Fire the approval callback from outside the gateway.
   *
   * The code-mode layer runs its own gate check (see tool-resolver.ts) so
   * that denials surface as typed `resolved: false` results instead of
   * roundtripping through the gateway's callTool path. That flow needs to
   * trigger the same popup as a direct `tools/call`, so we expose this
   * method rather than re-implementing the callback plumbing in two places.
   *
   * Fire-and-forget. Callback errors are logged but never bubble up.
   */
  fireApprovalRequired(
    gate: string,
    threadId: string,
    reason: string,
    toolName: string,
    sandboxId: string | null,
  ): void {
    if (!this.approvalCallback) return;
    try {
      this.approvalCallback(gate, threadId, reason, toolName, sandboxId);
    } catch (err) {
      console.warn(`${LOG_PREFIX} fireApprovalRequired callback threw: ${(err as Error).message}`);
    }
  }

  /**
   * Connect to an MCP server, perform protocol initialization,
   * discover tools, and classify+evaluate each one.
   *
   * Returns the list of governed tool definitions and any non-fatal errors
   * encountered during individual tool classification.
   */
  async connect(config: McpConnectionConfig): Promise<{
    tools: GovernedToolDefinition[];
    errors: string[];
  }> {
    if (config.transport === 'stdio') {
      return {
        tools: [],
        errors: [
          'stdio transport is not supported by the MCP gateway (use SSE or streamable-http)',
        ],
      };
    }

    const connectionId = config.connectionId;
    const errors: string[] = [];

    // Initialize connection state
    const state: McpConnectionState = {
      config,
      status: 'connecting',
      tools: new Map(),
      toolListHash: '',
      lastDiscovery: null,
      lastHealthCheck: null,
      nextMessageId: 0,
    };
    this.connections.set(connectionId, state);

    console.log(`${LOG_PREFIX} Connecting to ${config.url} (${connectionId})`);

    try {
      // Step 1: MCP protocol initialization
      const initId = ++state.nextMessageId;
      await sendJsonRpc(
        config.url,
        'initialize',
        initId,
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: CLIENT_INFO,
        },
        config.authToken,
        CONNECT_TIMEOUT_MS,
      );

      // Step 2: Discover tools
      const listId = ++state.nextMessageId;
      const listResult = (await sendJsonRpc(
        config.url,
        'tools/list',
        listId,
        undefined,
        config.authToken,
        CONNECT_TIMEOUT_MS,
      )) as ToolsListResult | null;

      const rawTools: DiscoveredMcpTool[] = listResult?.tools ?? [];

      if (rawTools.length === 0) {
        console.log(`${LOG_PREFIX} No tools discovered from ${connectionId}`);
      } else {
        console.log(
          `${LOG_PREFIX} Discovered ${rawTools.length} tool(s) from ${connectionId}`,
        );
      }

      // Step 3: Compute tool list hash for drift detection
      const toolListHash = computeToolListHash(rawTools);
      state.toolListHash = toolListHash;

      // Step 4: Build provider identity
      const providerIdentity: ProviderIdentity = {
        providerId: connectionId,
        providerType: 'mcp',
        endpoint: config.url,
        transport: toProviderTransport(config.transport),
        tlsFingerprint: null,
        manifestFingerprint: null,
        toolListHash,
      };

      // Step 5: Classify and evaluate each tool
      const governedTools: GovernedToolDefinition[] = [];

      for (const rawTool of rawTools) {
        try {
          const governed = classifyAndEvaluateTool(
            rawTool,
            providerIdentity,
            config,
          );
          state.tools.set(rawTool.name, governed);
          governedTools.push(governed);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`Failed to classify tool "${rawTool.name}": ${msg}`);
          console.warn(
            `${LOG_PREFIX} Classification error for "${rawTool.name}":`,
            msg,
          );
        }
      }

      state.status = 'connected';
      state.lastDiscovery = new Date();
      state.lastHealthCheck = new Date();

      // Apply manifest default permissions for known providers.
      // Only sets defaults for tools that don't have a user override.
      if (config.toolManifest) {
        for (const [tName, entry] of Object.entries(config.toolManifest)) {
          if (!state.tools.has(tName)) continue;
          const key = toolPermKey(connectionId, tName);
          const existing = this.toolPermissions.get(key);
          if (!existing || existing.source === 'manifest_default') {
            this.toolPermissions.set(key, {
              permission: entry.defaultPermission,
              source: 'manifest_default',
            });
          }
        }
      }

      const approvedCount = governedTools.filter(
        t => t.lifecycleStatus === 'approved',
      ).length;
      const quarantinedCount = governedTools.filter(
        t => t.lifecycleStatus === 'quarantined',
      ).length;

      console.log(
        `${LOG_PREFIX} Connected to ${connectionId}: ` +
        `${governedTools.length} tool(s) classified, ` +
        `${approvedCount} approved, ${quarantinedCount} quarantined`,
      );

      return { tools: governedTools, errors };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      state.status = 'error';
      state.error = msg;
      console.error(
        `${LOG_PREFIX} Connection failed for ${connectionId}:`,
        msg,
      );
      return { tools: [], errors: [msg] };
    }
  }

  /**
   * Disconnect from an MCP server and clean up all state.
   */
  disconnect(connectionId: string): void {
    const state = this.connections.get(connectionId);
    if (!state) return;

    state.status = 'disconnected';
    state.tools.clear();
    this.connections.delete(connectionId);
    this.clearToolPermissions(connectionId);
    console.log(`${LOG_PREFIX} Disconnected from ${connectionId}`);
  }

  /**
   * Health-check a connection by sending an `initialize` probe.
   *
   * Returns healthy=true if the server responds within the timeout.
   * Does NOT re-discover tools; use discoverTools() for that.
   */
  async healthCheck(
    connectionId: string,
  ): Promise<{ healthy: boolean; error?: string }> {
    const state = this.connections.get(connectionId);
    if (!state) {
      return { healthy: false, error: 'Connection not found' };
    }

    if (state.config.transport === 'stdio') {
      return {
        healthy: false,
        error: 'stdio transport does not support health checks',
      };
    }

    try {
      const probeId = ++state.nextMessageId;
      await sendJsonRpc(
        state.config.url,
        'initialize',
        probeId,
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: CLIENT_INFO,
        },
        state.config.authToken,
        HEALTH_CHECK_TIMEOUT_MS,
      );

      state.lastHealthCheck = new Date();
      state.status = 'connected';
      state.error = undefined;
      return { healthy: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      state.status = 'error';
      state.error = msg;
      return { healthy: false, error: msg };
    }
  }

  /**
   * Re-discover tools from an active connection.
   *
   * Sends `tools/list` again, re-classifies all tools, and updates
   * the connection state. Detects tool list drift via hash comparison
   * and logs when the set changes.
   */
  async discoverTools(connectionId: string): Promise<GovernedToolDefinition[]> {
    const state = this.connections.get(connectionId);
    if (!state) {
      throw new Error(`Connection "${connectionId}" not found`);
    }

    if (state.status !== 'connected') {
      throw new Error(
        `Connection "${connectionId}" is not connected (status: ${state.status})`,
      );
    }

    if (state.config.transport === 'stdio') {
      throw new Error(
        'stdio transport is not supported for tool discovery',
      );
    }

    const listId = ++state.nextMessageId;
    const listResult = (await sendJsonRpc(
      state.config.url,
      'tools/list',
      listId,
      undefined,
      state.config.authToken,
      CONNECT_TIMEOUT_MS,
    )) as ToolsListResult | null;

    const rawTools: DiscoveredMcpTool[] = listResult?.tools ?? [];
    const newHash = computeToolListHash(rawTools);

    if (newHash !== state.toolListHash) {
      console.log(
        `${LOG_PREFIX} Tool list changed for ${connectionId} ` +
        `(hash ${state.toolListHash.slice(0, 12)} -> ${newHash.slice(0, 12)})`,
      );
    }

    state.toolListHash = newHash;
    state.tools.clear();

    const providerIdentity: ProviderIdentity = {
      providerId: connectionId,
      providerType: 'mcp',
      endpoint: state.config.url,
      transport: toProviderTransport(state.config.transport),
      tlsFingerprint: null,
      manifestFingerprint: null,
      toolListHash: newHash,
    };

    const governed: GovernedToolDefinition[] = [];

    for (const rawTool of rawTools) {
      try {
        const def = classifyAndEvaluateTool(
          rawTool,
          providerIdentity,
          state.config,
        );
        state.tools.set(rawTool.name, def);
        governed.push(def);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `${LOG_PREFIX} Re-classification error for "${rawTool.name}":`,
          msg,
        );
      }
    }

    state.lastDiscovery = new Date();
    return governed;
  }

  /**
   * Execute a tool call on an MCP server, gated by Sovereign Shield.
   *
   * Flow:
   *   1. Validate connection exists and is connected
   *   2. Validate tool exists, is approved, and is agent-visible
   *   3. Check Sovereign Gate via shield internal API (fail-closed)
   *   4. Forward JSON-RPC `tools/call` to the MCP server
   *   5. Return structured result with timing
   */
  async callTool(
    connectionId: string,
    toolName: string,
    args: Record<string, unknown>,
    context: ToolCallContext,
  ): Promise<ToolCallResult> {
    // Step 0: Check for builtin tools (code-mode, etc.)
    if (connectionId === '__builtin__') {
      const builtinDef = this.builtinTools.get(toolName);
      if (!builtinDef) {
        return {
          status: 'error',
          errorCode: 'TOOL_NOT_FOUND',
          message: `Builtin tool "${toolName}" not found`,
          retryable: false,
          providerId: null,
        };
      }
      if (!builtinDef.capability) {
        return {
          status: 'error',
          errorCode: 'NO_CAPABILITY',
          message: `Builtin tool "${toolName}" has no classified capability`,
          retryable: false,
          providerId: '__builtin__',
        };
      }
      const builtinPermKey = toolPermKey('__builtin__', toolName);
      const builtinPerm = this.toolPermissions.get(builtinPermKey);
      if (builtinPerm) {
        switch (builtinPerm.permission) {
          case 'never':
            return {
              status: 'denied',
              deniedCapability: builtinDef.capability,
              reason: `Builtin tool "${toolName}" is blocked by per-tool permission (never allow)`,
              policyVersion: GATEWAY_VERSION,
            };
          case 'allow_always': {
            const h = this.builtinHandlers.get(toolName)!;
            return h(args, context);
          }
          case 'allow_session': {
            const effectiveGateSess = CAPABILITY_GATE[builtinDef.capability];
            const sessionOpen = await checkGateOpen(effectiveGateSess, context.threadId, context.sandboxId);
            if (sessionOpen) {
              const h = this.builtinHandlers.get(toolName)!;
              return h(args, context);
            }
            break;
          }
          case 'ask':
            break;
        }
      }

      const effectiveGate = CAPABILITY_GATE[builtinDef.capability];
      const gateOpen = await checkGateOpen(effectiveGate, context.threadId, context.sandboxId);
      if (!gateOpen) {
        const pendingArtifactId = sha256(
          `__builtin__:${toolName}:${context.threadId}:${Date.now()}`,
        );
        if (this.approvalCallback) {
          try {
            const reason = `Builtin tool "${toolName}" requires "${effectiveGate}" gate`;
            this.approvalCallback(effectiveGate, context.threadId, reason, toolName, context.sandboxId ?? null);
          } catch {}
        }
        return {
          status: 'approval_required',
          requiredGate: effectiveGate,
          requiredCapability: builtinDef.capability,
          reason: `Gate "${effectiveGate}" is not open for thread ${context.threadId.slice(0, 8)}`,
          pendingArtifactId,
        };
      }
      const handler = this.builtinHandlers.get(toolName)!;
      return handler(args, context);
    }

    const state = this.connections.get(connectionId);
    if (!state) {
      return {
        status: 'error',
        errorCode: 'CONNECTION_NOT_FOUND',
        message: `Connection "${connectionId}" not found`,
        retryable: false,
        providerId: null,
      };
    }

    if (state.status !== 'connected') {
      return {
        status: 'error',
        errorCode: 'CONNECTION_NOT_READY',
        message: `Connection "${connectionId}" is not connected (status: ${state.status})`,
        retryable: state.status === 'error',
        providerId: connectionId,
      };
    }

    // Step 2: Look up tool
    const toolDef = state.tools.get(toolName);
    if (!toolDef) {
      return {
        status: 'error',
        errorCode: 'TOOL_NOT_FOUND',
        message: `Tool "${toolName}" not found on connection "${connectionId}"`,
        retryable: false,
        providerId: connectionId,
      };
    }

    // Step 3: Verify tool is approved and agent-visible
    if (toolDef.lifecycleStatus !== 'approved') {
      return {
        status: 'denied',
        deniedCapability: toolDef.capability ?? 'execution:shell',
        reason: `Tool "${toolName}" is not approved (status: ${toolDef.lifecycleStatus})`,
        policyVersion: GATEWAY_VERSION,
      };
    }

    if (toolDef.exposureStatus !== 'agent_visible') {
      return {
        status: 'denied',
        deniedCapability: toolDef.capability ?? 'execution:shell',
        reason: `Tool "${toolName}" is not visible to agents (exposure: ${toolDef.exposureStatus})`,
        policyVersion: GATEWAY_VERSION,
      };
    }

    if (!toolDef.capability) {
      return {
        status: 'error',
        errorCode: 'NO_CAPABILITY',
        message: `Tool "${toolName}" has no classified capability`,
        retryable: false,
        providerId: connectionId,
      };
    }

    // Step 3a: Cross-project scope-confusion — L1 structural denial.
    //
    // If the tool invocation targets a sandbox-scoped capability
    // (database/secrets/deployment/observability — all semantically bound
    // to THIS sandbox's own resources) AND the args reference another
    // sandbox's `.shared/` snapshot or `/projects/<slug>` path, the call
    // is nonsensical by construction: no gate grant in this sandbox's
    // scope could ever give access to another sandbox's data. Deny
    // outright before any gate-request is built — no popup, no shield
    // round-trip, no operator notification.
    //
    // Gated by SCOPE_CHECK_ENABLED so operators have a rollback knob
    // (ELLUL_CROSS_PROJECT_SCOPE_CHECK=0).
    const sharedArgHints = SCOPE_CHECK_ENABLED
      ? extractSharedPathHintsFromJson(args)
      : [];
    if (
      SCOPE_CHECK_ENABLED &&
      sharedArgHints.length > 0 &&
      isSandboxScopedCapability(toolDef.capability)
    ) {
      recordScopeConfusionDenial('bridge_tool_call');
      console.log(
        `${LOG_PREFIX} Scope-confusion denial: "${toolName}" (${toolDef.capability}) ` +
        `called with cross-sandbox args [${sharedArgHints.join(', ')}]`,
      );
      return {
        status: 'denied',
        deniedCapability: toolDef.capability,
        reason:
          `Tool "${toolName}" (${toolDef.capability}) was called with arguments referencing ` +
          `${sharedArgHints.join(', ')}. Those paths belong to a read-only source snapshot of ` +
          `another sandbox; ${toolDef.capability} operates only on THIS sandbox's own resources, ` +
          `so the call cannot do what it appears to ask for. To inspect cross-sandbox code, use ` +
          `filesystem reads on \`.shared/*\` directly — no gate or runtime access is required.`,
        policyVersion: GATEWAY_VERSION,
      };
    }

    // Step 3b: Check per-tool permission override (takes precedence over gate)
    const toolPerm = this.getToolPermission(connectionId, toolName);
    if (toolPerm) {
      switch (toolPerm) {
        case 'never':
          return {
            status: 'denied',
            deniedCapability: toolDef.capability,
            reason: `Tool "${toolName}" is blocked by per-tool permission (never allow)`,
            policyVersion: GATEWAY_VERSION,
          };
        case 'allow_always':
          return this.executeToolCall(state, toolName, args, connectionId, context);
        case 'allow_session': {
          const effectiveGate = CAPABILITY_GATE[toolDef.capability];
          const sessionGateOpen = await checkGateOpen(effectiveGate, context.threadId, context.sandboxId);
          if (sessionGateOpen) {
            return this.executeToolCall(state, toolName, args, connectionId, context);
          }
          break;
        }
        case 'ask':
          break;
      }
    }

    const effectiveGate = CAPABILITY_GATE[toolDef.capability];
    const gateOpen = await checkGateOpen(effectiveGate, context.threadId, context.sandboxId);

    if (!gateOpen) {
      const pendingArtifactId = sha256(
        `${connectionId}:${toolName}:${context.threadId}:${Date.now()}`,
      );
      if (this.approvalCallback) {
        try {
          const baseReason = `Tool "${toolName}" requires "${effectiveGate}" gate`;
          const reason = enrichReasonWithHints(baseReason, sharedArgHints);
          this.approvalCallback(effectiveGate, context.threadId, reason, toolName, context.sandboxId ?? null);
        } catch {}
      }
      return {
        status: 'approval_required',
        requiredGate: effectiveGate,
        requiredCapability: toolDef.capability,
        reason: `Gate "${effectiveGate}" is not open for thread ${context.threadId.slice(0, 8)}`,
        pendingArtifactId,
      };
    }
    // Step 5: Provider scrub middleware (fail-closed)
    let finalArgs = args;
    const scrubber = state.config.scrubber;
    if (scrubber && scrubber.writeTools.has(toolName)) {
      try {
        finalArgs = scrubber.scrubArgs(args);
      } catch (err) {
        console.error(
          `${LOG_PREFIX} scrub failed for "${connectionId}/${toolName}", denying write:`,
          (err as Error).message,
        );
        return {
          status: 'error',
          errorCode: 'SCRUB_FAILED',
          message: 'Secret redaction failed — write denied (fail-closed)',
          retryable: false,
          providerId: connectionId,
        };
      }
    }

    // Step 6: Execute the tool call on the MCP server
    return this.executeToolCall(state, toolName, finalArgs, connectionId, context);
  }

  /**
   * Internal: send JSON-RPC `tools/call` to the MCP server and return the result.
   * Extracted so both gated and per-tool-overridden paths share the same execution logic.
   */
  private async executeToolCall(
    state: McpConnectionState,
    toolName: string,
    args: Record<string, unknown>,
    connectionId: string,
    context: ToolCallContext,
  ): Promise<ToolCallResult> {
    const startMs = Date.now();

    try {
      const callId = ++state.nextMessageId;
      const result = (await sendJsonRpc(
        state.config.url,
        'tools/call',
        callId,
        { name: toolName, arguments: args },
        state.config.authToken,
        CALL_TIMEOUT_MS,
      )) as ToolsCallResult | null;

      const durationMs = Date.now() - startMs;

      // MCP-level tool error (isError flag in response content)
      if (result?.isError) {
        const errorText = result.content
          .filter(c => c.type === 'text' && c.text)
          .map(c => c.text)
          .join('\n');

        return {
          status: 'error',
          errorCode: 'TOOL_EXECUTION_ERROR',
          message: errorText || 'Tool returned an error',
          retryable: false,
          providerId: connectionId,
        };
      }

      console.log(
        `${LOG_PREFIX} Tool call "${toolName}" on ${connectionId} completed in ${durationMs}ms`,
      );

      return {
        status: 'success',
        output: result?.content ?? null,
        durationMs,
        artifactId: sha256(
          `${connectionId}:${toolName}:${context.threadId}:${startMs}`,
        ),
        providerId: connectionId,
      };
    } catch (err) {
      const durationMs = Date.now() - startMs;
      const msg = err instanceof Error ? err.message : String(err);
      const isTimeout = msg.includes('timeout') || msg.includes('abort');

      console.error(
        `${LOG_PREFIX} Tool call "${toolName}" on ${connectionId} failed after ${durationMs}ms: ${msg}`,
      );

      return {
        status: 'error',
        errorCode: isTimeout ? 'TIMEOUT' : 'EXECUTION_FAILED',
        message: msg,
        retryable: isTimeout,
        providerId: connectionId,
      };
    }
  }

  // ── Tool Permission Methods ──

  /**
   * Set a per-tool permission override.
   * Called by the bridge when the console sends a tool_permission_set message.
   */
  setToolPermission(
    connectionId: string,
    toolName: string,
    permission: ToolPermissionLevel,
  ): void {
    const key = toolPermKey(connectionId, toolName);
    this.toolPermissions.set(key, { permission, source: 'user_override' });
    console.log(
      `${LOG_PREFIX} Tool permission set: ${connectionId}/${toolName} -> ${permission}`,
    );
  }

  /**
   * Remove a per-tool permission override (revert to gate-level default).
   * Called by the bridge when the console sends a tool_permission_reset message.
   */
  resetToolPermission(connectionId: string, toolName: string): void {
    const key = toolPermKey(connectionId, toolName);
    this.toolPermissions.delete(key);
    console.log(
      `${LOG_PREFIX} Tool permission reset: ${connectionId}/${toolName} -> gate default`,
    );
  }

  /**
   * Get the per-tool permission override for a specific tool, if any.
   * Returns null if no override exists (caller should fall through to gate check).
   */
  getToolPermission(
    connectionId: string,
    toolName: string,
  ): ToolPermissionLevel | null {
    const key = toolPermKey(connectionId, toolName);
    return this.toolPermissions.get(key)?.permission ?? null;
  }

  /**
   * Clear all per-tool permissions for a connection (e.g. on disconnect).
   */
  clearToolPermissions(connectionId: string): void {
    const prefix = `${connectionId}:`;
    for (const key of this.toolPermissions.keys()) {
      if (key.startsWith(prefix)) {
        this.toolPermissions.delete(key);
      }
    }
  }

  // ── Query Methods ──

  /**
   * Get all approved, agent-visible tools for a single connection.
   */
  getApprovedTools(connectionId: string): GovernedToolDefinition[] {
    const state = this.connections.get(connectionId);
    if (!state) return [];

    const approved: GovernedToolDefinition[] = [];
    for (const tool of state.tools.values()) {
      if (
        tool.lifecycleStatus === 'approved' &&
        tool.exposureStatus === 'agent_visible'
      ) {
        approved.push(tool);
      }
    }
    return approved;
  }

  /**
   * Get all tools for a connection, including quarantined and disabled.
   */
  getAllTools(connectionId: string): GovernedToolDefinition[] {
    const state = this.connections.get(connectionId);
    if (!state) return [];
    return [...state.tools.values()];
  }

  /**
   * Get all approved, agent-visible tools across every connected MCP server.
   * Returns enriched summaries suitable for system prompt injection.
   */
  getAllApprovedTools(): ApprovedToolSummary[] {
    const result: ApprovedToolSummary[] = [];
    for (const state of this.connections.values()) {
      for (const tool of state.tools.values()) {
        if (
          tool.lifecycleStatus === 'approved' &&
          tool.exposureStatus === 'agent_visible'
        ) {
          result.push({
            toolName: tool.name,
            description: tool.description,
            effectiveCapability: tool.capability,
            providerId: tool.provider.providerId,
          });
        }
      }
    }
    // Include builtin tools
    for (const tool of this.builtinTools.values()) {
      if (
        tool.lifecycleStatus === 'approved' &&
        tool.exposureStatus === 'agent_visible'
      ) {
        result.push({
          toolName: tool.name,
          description: tool.description,
          effectiveCapability: tool.capability,
          providerId: tool.provider.providerId,
        });
      }
    }
    return result;
  }

  /**
   * Get the current status of a connection.
   */
  getConnectionStatus(connectionId: string): ConnectionStatus | null {
    return this.connections.get(connectionId)?.status ?? null;
  }

  /**
   * Get all registered connection IDs (all statuses).
   */
  getConnectionIds(): string[] {
    return [...this.connections.keys()];
  }

  /**
   * Get all connected (healthy) connection IDs.
   */
  getActiveConnectionIds(): string[] {
    const ids: string[] = [];
    for (const [id, state] of this.connections) {
      if (state.status === 'connected') {
        ids.push(id);
      }
    }
    return ids;
  }

  /**
   * Check whether the gateway has any active connections.
   */
  hasConnections(): boolean {
    return this.connections.size > 0;
  }

  /**
   * Get the tool list hash for a connection (for drift detection).
   */
  getToolListHash(connectionId: string): string | null {
    return this.connections.get(connectionId)?.toolListHash ?? null;
  }

  /**
   * Disconnect all connections and clear all state.
   */
  disconnectAll(): void {
    for (const connectionId of [...this.connections.keys()]) {
      this.disconnect(connectionId);
    }
  }

  // ── Builtin Tool Methods ──

  /**
   * Register a builtin tool (e.g., execute_code).
   * Builtin tools bypass the MCP discovery/classification pipeline
   * but still go through gate checks in callTool().
   */
  registerBuiltinTool(
    toolName: string,
    definition: GovernedToolDefinition,
    handler: (args: Record<string, unknown>, ctx: ToolCallContext) => Promise<ToolCallResult>,
  ): void {
    this.builtinTools.set(toolName, definition);
    this.builtinHandlers.set(toolName, handler);
    console.log(`${LOG_PREFIX} Builtin tool registered: ${toolName}`);
  }

  /**
   * Get all governed tool definitions across all connections AND builtins.
   * Used by code-mode type generator.
   */
  getAllGovernedTools(): GovernedToolDefinition[] {
    const result: GovernedToolDefinition[] = [];
    for (const state of this.connections.values()) {
      for (const tool of state.tools.values()) {
        result.push(tool);
      }
    }
    for (const tool of this.builtinTools.values()) {
      result.push(tool);
    }
    return result;
  }

  /**
   * Direct tool call — MCP JSON-RPC dispatch ONLY.
   * Skips the gateway's own classify → policy → gate pipeline.
   * Used by code-mode ToolExecutor after policy has already been checked.
   */
  async callToolDirect(
    connectionId: string,
    toolName: string,
    args: Record<string, unknown>,
    context: ToolCallContext,
  ): Promise<ToolCallResult> {
    const state = this.connections.get(connectionId);
    if (!state) {
      return {
        status: 'error',
        errorCode: 'CONNECTION_NOT_FOUND',
        message: `Connection "${connectionId}" not found`,
        retryable: false,
        providerId: null,
      };
    }
    if (state.status !== 'connected') {
      return {
        status: 'error',
        errorCode: 'CONNECTION_NOT_READY',
        message: `Connection "${connectionId}" is not connected (status: ${state.status})`,
        retryable: state.status === 'error',
        providerId: connectionId,
      };
    }
    return this.executeToolCall(state, toolName, args, connectionId, context);
  }
}

// ── Singleton & Exports ──

/** Singleton gateway instance. */
export const mcpGateway = new McpGateway();

export { CAPABILITY_GATE };
export type { GateType, ToolPermissionLevel };
