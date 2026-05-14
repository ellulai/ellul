// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Tool Governance
 *
 * Governed tool execution layer for MCP tools. Pure functions with
 * no runtime dependencies — classifier proposes, policy engine decides.
 *
 * Barrel export: types, classifier, and policy engine.
 */

export * from './Types';
export { classifyTool } from './Classifier';
export { evaluatePolicy, canAutoApprove } from './Policy';
export { mcpGateway, McpGateway, checkGateOpen } from './McpGateway';
export type { ApprovedToolSummary, McpConnectionConfig, ToolCallContext } from './McpGateway';
