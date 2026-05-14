// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Tool Executor
 *
 * Transport only. Dispatches resolved invocations to MCP servers.
 * No policy. No retry. No identity resolution.
 * Retry is the orchestrator's responsibility.
 */

import type { McpGateway } from '../mcp-tool/governance/McpGateway';
import type { ToolInvocation, ToolCallResult } from './Types';

export class ToolExecutor {
  constructor(private gateway: McpGateway) {}

  /**
   * Dispatch a fully-resolved invocation to the MCP server.
   * Dumb pipe — calls gateway.callToolDirect() and returns the result.
   */
  async dispatch(invocation: ToolInvocation): Promise<ToolCallResult> {
    return this.gateway.callToolDirect(
      invocation.identity.connectionId,
      invocation.identity.toolName,
      invocation.args,
      invocation.context,
    );
  }
}
