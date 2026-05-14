// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Code-Mode
 *
 * Batched TypeScript execution for MCP tools.
 * Collapses N tool calls into 1 execution boundary.
 */

// Types
export type {
  ToolCallState,
  ToolCallRecord,
  ToolIdentity,
  ToolInvocation,
  ResolveResult,
  PolicyResult,
  BatchResult,
  CodeModeResult,
  ToolCallSummary,
  ConsoleEntry,
  RuntimeResult,
  CodeModeExecutionConfig,
} from './Types';
export { deriveIdempotencyKey, DEFAULT_CONFIG } from './Types';

// Components
export { ToolRegistry } from './ToolRegistry';
export { ExecutionLifecycle } from './ExecutionLifecycle';
export { ToolExecutor } from './ToolExecutor';
export { ToolResolver } from './ToolResolver';
export { ExecutionRuntime } from './ExecutionRuntime';
export { CodeModeService } from './CodeMode';
export { generateToolTypeDefinitions } from './TypeGenerator';
export { registerBuiltinTools, BUILTIN_CONNECTION_ID } from './BuiltinToolRegistry';
export { registerPlatformTools, scaffoldProjectDirect } from './PlatformTools';

// Observability
export type { ObservabilityEmitter } from './Observability';
export { CodeModeObservability } from './Observability';
