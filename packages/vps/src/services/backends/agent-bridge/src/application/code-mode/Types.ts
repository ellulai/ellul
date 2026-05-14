// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Code-Mode Type System
 *
 * Shared types for the batched TypeScript execution layer.
 * All types in one file — tool call state machine, invocation records,
 * identity, execution results, and the deterministic idempotency key derivation.
 */

import { createHash } from 'crypto';

import type {
  ToolCapability,
  GateType,
  ToolCallResult,
  GovernedToolDefinition,
} from '../mcp-tool/governance/Types';
import type { ToolCallContext } from '../mcp-tool/governance/McpGateway';

// ── Tool Call State Machine ──

/**
 * Canonical states for a tool call within an execution.
 *
 * PENDING → SENT → SUCCESS | FAILED | TIMEOUT | UNKNOWN
 *
 * Terminal states: SUCCESS, FAILED, TIMEOUT, UNKNOWN.
 * Once terminal, a call cannot transition again.
 *
 * UNKNOWN is the critical state — if an isolate is killed mid-call,
 * the call may have: never reached the server, succeeded silently,
 * or partially applied. UNKNOWN surfaces this ambiguity instead of
 * silently assuming SUCCESS or FAILED.
 */
export type ToolCallState =
  | 'PENDING'
  | 'SENT'
  | 'SUCCESS'
  | 'FAILED'
  | 'TIMEOUT'
  | 'UNKNOWN';

const TERMINAL_STATES: ReadonlySet<ToolCallState> = new Set([
  'SUCCESS',
  'FAILED',
  'TIMEOUT',
  'UNKNOWN',
]);

export function isTerminalState(state: ToolCallState): boolean {
  return TERMINAL_STATES.has(state);
}

// ── Tool Call Record ──

/**
 * Record of a single tool call within an execution.
 * Tracks state machine transitions, timing, and the idempotency key
 * for debugging UNKNOWN states.
 */
export interface ToolCallRecord {
  tool: string;
  sequenceNumber: number;
  state: ToolCallState;
  idempotencyKey: string;
  connectionId: string;
  sentAt?: number;
  completedAt?: number;
  result?: ToolCallResult;
}

// ── Tool Identity ──

/**
 * Full identity for a tool: (name + connectionId + capability).
 * Prevents namespace collisions, ambiguous routing,
 * and privilege escalation via name reuse.
 */
export interface ToolIdentity {
  toolName: string;
  connectionId: string;
  capability: ToolCapability;
}

// ── Tool Invocation ──

/**
 * A fully-resolved tool invocation ready for dispatch.
 * Produced by ToolResolver, consumed by ToolExecutor.
 */
export interface ToolInvocation {
  identity: ToolIdentity;
  args: Record<string, unknown>;
  context: ToolCallContext;
  idempotencyKey: string;
  sequenceNumber: number;
  origin: 'codemode';
}

// ── Resolve Result ──

/**
 * Discriminated union returned by ToolResolver.resolve().
 */
export type ResolveResult =
  | { resolved: true; invocation: ToolInvocation }
  | { resolved: false; reason: string; requiredGate?: GateType };

// ── Policy Result ──

/**
 * Internal result from ToolResolver.evaluatePolicy().
 */
export type PolicyResult =
  | { allowed: true }
  | { allowed: false; reason: string; requiredGate?: GateType };

// ── Batch Result ──

/**
 * Result of a secureExecuteBatch() call.
 * Partial execution: allowed calls execute, denied calls return null with structured denial.
 */
export interface BatchResult {
  results: Array<ToolCallResult | null>;
  denied: Array<{
    index: number;
    tool: string;
    reason: string;
    requiredGate?: GateType;
  }>;
}

// ── Execution Result ──

/**
 * Top-level result from CodeModeService.executeCode().
 */
export interface CodeModeResult {
  status: 'success' | 'error' | 'timeout' | 'cancelled' | 'tool_denied';
  output: unknown;
  console: ConsoleEntry[];
  toolCalls: ToolCallSummary[];
  durationMs: number;
  executionId: string;
  peakMemoryMb: number;
  error?: { message: string; stack?: string };
  deniedTool?: { name: string; gate: string; reason: string };
}

export interface ToolCallSummary {
  tool: string;
  sequenceNumber: number;
  state: ToolCallState;
  /** Exposed for agent debugging — the handle for investigating UNKNOWN states. */
  idempotencyKey: string;
  durationMs: number;
  connectionId: string;
}

export interface ConsoleEntry {
  level: 'log' | 'warn' | 'error';
  args: string[];
}

// ── Runtime Result ──

/**
 * Raw result from ExecutionRuntime.execute().
 * The orchestrator maps this → CodeModeResult.
 */
export type RuntimeResult =
  | { status: 'success'; output: unknown }
  | { status: 'error'; error: { message: string; stack?: string } }
  | { status: 'timeout' };

// ── Execution Config ──

export interface CodeModeExecutionConfig {
  /** Max wall-clock time for entire execution. Default: 30_000ms. */
  timeoutMs: number;
  /** Max tool calls per execution. Default: 50. */
  maxToolCalls: number;
  /** V8 isolate heap limit in MB. Default: 128. */
  memoryLimitMb: number;
}

export const DEFAULT_CONFIG: Readonly<CodeModeExecutionConfig> = {
  timeoutMs: 30_000,
  maxToolCalls: 50,
  memoryLimitMb: 128,
};

// ── Idempotency Key Derivation ──

/**
 * Deterministic idempotency key derivation.
 * Pure function of (executionId, toolName, sequenceNumber).
 *
 * Shared across: orchestrator, executor, replay engine.
 * Same execution + same tool + same sequence = same key.
 * Different executionId (retry) = different key (no dedup collision).
 */
export function deriveIdempotencyKey(
  executionId: string,
  toolName: string,
  sequenceNumber: number,
): string {
  return createHash('sha256')
    .update(`${executionId}:${toolName}:${sequenceNumber}`)
    .digest('hex');
}

// ── Re-exports for convenience ──

export type { ToolCallResult, ToolCapability, GateType, GovernedToolDefinition, ToolCallContext };
