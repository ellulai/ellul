// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Tool Resolver
 *
 * Single entry point for resolving a tool call into a fully-qualified invocation.
 * Internally delegates to three independent functions that evolve at different rates:
 *   - resolveIdentity() — changes when tool registry changes
 *   - evaluatePolicy() — changes when auth/gate logic changes
 *   - deriveIdempotencyKey() — pure, changes almost never
 *
 * One external function (resolve), three internal functions.
 * Orchestrator calls resolve(). Executor receives the result.
 * Replay reuses the same function.
 */

import type { ToolCallContext } from '../mcp-tool/governance/McpGateway';
import type { McpGateway } from '../mcp-tool/governance/McpGateway';
import { CAPABILITY_GATE } from '../mcp-tool/governance/Types';
import { checkGateOpen } from '../mcp-tool/governance/McpGateway';
import {
  SCOPE_CHECK_ENABLED,
  isSandboxScopedCapability,
  extractSharedPathHintsFromJson,
  enrichReasonWithHints,
  recordScopeConfusionDenial,
} from '@vps/shared/cross-project-scope';

import type { ToolIdentity, ResolveResult, PolicyResult } from './Types';
import { deriveIdempotencyKey } from './Types';
import type { ToolRegistry } from './ToolRegistry';

export class ToolResolver {
  constructor(
    private registry: ToolRegistry,
    private gateway: McpGateway,
  ) {}

  /**
   * Resolve a tool call into a fully-qualified invocation.
   * Single deterministic entry point.
   */
  async resolve(
    toolName: string,
    args: Record<string, unknown>,
    context: ToolCallContext,
    executionId: string,
    sequenceNumber: number,
  ): Promise<ResolveResult> {
    // 1. Identity — changes when registry changes
    const identity = this.resolveIdentity(toolName);
    if (!identity) {
      return { resolved: false, reason: 'TOOL_NOT_REGISTERED' };
    }

    // 2. Policy — changes when auth/gate logic changes
    const policy = await this.evaluatePolicy(identity, args, context);
    if (!policy.allowed) {
      return { resolved: false, reason: policy.reason, requiredGate: policy.requiredGate };
    }

    // 3. Idempotency key — pure, changes almost never
    const idempotencyKey = deriveIdempotencyKey(executionId, toolName, sequenceNumber);

    return {
      resolved: true,
      invocation: {
        identity,
        args,
        context,
        idempotencyKey,
        sequenceNumber,
        origin: 'codemode' as const,
      },
    };
  }

  /** Identity resolution. Delegates to registry. */
  private resolveIdentity(toolName: string): ToolIdentity | null {
    return this.registry.resolve(toolName);
  }

  /** Policy evaluation. Checks permission override, cross-project scope confusion, then gate status. */
  private async evaluatePolicy(
    identity: ToolIdentity,
    args: Record<string, unknown>,
    context: ToolCallContext,
  ): Promise<PolicyResult> {
    const perm = this.gateway.getToolPermission(identity.connectionId, identity.toolName);
    if (perm === 'never') return { allowed: false, reason: 'TOOL_BLOCKED' };

    // Cross-project scope-confusion — L1 structural denial (mirrors
    // mcp-gateway.callTool). Nested tool calls from execute_code targeting
    // sandbox-scoped capabilities with cross-sandbox args are denied
    // without firing the approval popup.
    const sharedArgHints = SCOPE_CHECK_ENABLED
      ? extractSharedPathHintsFromJson(args)
      : [];
    if (
      SCOPE_CHECK_ENABLED &&
      sharedArgHints.length > 0 &&
      isSandboxScopedCapability(identity.capability)
    ) {
      recordScopeConfusionDenial('bridge_tool_call');
      return { allowed: false, reason: 'CROSS_PROJECT_SCOPE_CONFUSION' };
    }

    if (perm === 'allow_always') return { allowed: true };

    const gate = CAPABILITY_GATE[identity.capability];
    const open = await checkGateOpen(gate, context.threadId, context.sandboxId);
    if (!open) {
      // Fire the HITL popup for nested calls inside execute_code, mirroring
      // the direct `tools/call` path in mcp-gateway. Enrich reason with
      // extracted shared-path hints so shield's L3 matcher catches
      // scope-confused requests that slipped past L1 (non-sandbox-scoped
      // capabilities with cross-sandbox args).
      const sandboxId = context.sandboxId || null;
      const baseReason = `Tool "${identity.toolName}" requires "${gate}" gate`;
      const reason = enrichReasonWithHints(baseReason, sharedArgHints);
      this.gateway.fireApprovalRequired(gate, context.threadId, reason, identity.toolName, sandboxId);
      return { allowed: false, reason: 'GATE_CLOSED', requiredGate: gate };
    }

    return { allowed: true };
  }
}
