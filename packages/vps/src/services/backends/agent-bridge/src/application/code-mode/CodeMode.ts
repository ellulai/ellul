// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Code-Mode Orchestrator
 *
 * Thin. Wires planes together. Owns nothing except the execution flow.
 *
 * Architecture:
 *   onToolCall: budget check → resolve → emit started → dispatch → emit finished/failed → record
 *   onBatchCall: resolve all (split allowed/denied) → dispatch allowed → return BatchResult
 *
 * Tool call state machine:
 *   PENDING → SENT → SUCCESS/FAILED
 *   On catch: UNKNOWN → execution fails (see UNKNOWN recovery policy in architecture doc)
 *
 * Physical entanglement note:
 *   The orchestrator currently wires runtime + policy + transport in one callback.
 *   This is correct for v1 (single-process, sequential).
 *   The plane separation is logical now, physical later.
 */

import type {
  CodeModeResult,
  CodeModeExecutionConfig,
  ToolCallResult,
  ToolCallRecord,
  ToolCallSummary,
  ToolInvocation,
  ConsoleEntry,
  BatchResult,
} from './Types';
import { DEFAULT_CONFIG, deriveIdempotencyKey } from './Types';
import type { ToolCallContext } from '../mcp-tool/governance/McpGateway';
import type { ExecutionRuntime } from './ExecutionRuntime';
import type { ToolResolver } from './ToolResolver';
import type { ToolExecutor } from './ToolExecutor';
import type { ExecutionLifecycle } from './ExecutionLifecycle';
import type { ObservabilityEmitter } from './Observability';

const LOG_PREFIX = '[CodeMode]';
const MAX_CONCURRENT_ISOLATES = 4;

export class CodeModeService {
  private activeIsolates = 0;

  constructor(
    private runtime: ExecutionRuntime,
    private resolver: ToolResolver,
    private executor: ToolExecutor,
    private lifecycle: ExecutionLifecycle,
    private emitter: ObservabilityEmitter,
    private config: CodeModeExecutionConfig = DEFAULT_CONFIG,
  ) {}

  /**
   * Execute agent-generated TypeScript code with batched tool calls.
   */
  async executeCode(
    code: string,
    context: ToolCallContext,
    typeDefs: string,
  ): Promise<CodeModeResult> {
    // Concurrency guard
    if (this.activeIsolates >= MAX_CONCURRENT_ISOLATES) {
      return {
        status: 'error',
        output: null,
        console: [],
        toolCalls: [],
        durationMs: 0,
        executionId: '',
        peakMemoryMb: 0,
        error: { message: `Concurrency limit exceeded (${MAX_CONCURRENT_ISOLATES})` },
      };
    }

    const executionId = this.lifecycle.create(this.config);
    const consoleEntries: ConsoleEntry[] = [];
    const startMs = Date.now();

    this.activeIsolates++;

    try {
      const result = await this.runtime.execute(
        code,
        typeDefs,
        { timeoutMs: this.config.timeoutMs, memoryLimitMb: this.config.memoryLimitMb },

        // ── secureExecute callback ──
        async (toolName, args) => {
          return this.handleToolCall(toolName, args, context, executionId);
        },

        // ── secureExecuteBatch callback ──
        async (calls) => {
          return this.handleBatch(calls, context, executionId);
        },

        // ── console callback ──
        (level, args) => {
          consoleEntries.push({ level: level as ConsoleEntry['level'], args });
        },
      );

      const durationMs = Date.now() - startMs;

      // Check if the runtime returned a code-mode error (gate required, tool denied)
      if (result.status === 'success' && this.isCodeModeError(result.output)) {
        const cmErr = result.output as { type: string; gate?: string; message?: string };
        if (cmErr.type === 'gate_required') {
          this.lifecycle.fail(executionId);
          return {
            status: 'tool_denied',
            output: null,
            console: consoleEntries,
            toolCalls: this.buildSummaries(executionId),
            durationMs,
            executionId,
            peakMemoryMb: result.peakMemoryMb,
            deniedTool: { name: '', gate: cmErr.gate ?? '', reason: cmErr.message ?? '' },
          };
        }
        if (cmErr.type === 'tool_denied' || cmErr.type === 'execution_error') {
          this.lifecycle.fail(executionId);
          return {
            status: 'error',
            output: null,
            console: consoleEntries,
            toolCalls: this.buildSummaries(executionId),
            durationMs,
            executionId,
            peakMemoryMb: result.peakMemoryMb,
            error: { message: cmErr.message ?? 'Execution error' },
          };
        }
      }

      if (result.status === 'timeout') {
        this.lifecycle.fail(executionId);
        return {
          status: 'timeout',
          output: null,
          console: consoleEntries,
          toolCalls: this.buildSummaries(executionId),
          durationMs,
          executionId,
          peakMemoryMb: result.peakMemoryMb,
        };
      }

      if (result.status === 'error') {
        this.lifecycle.fail(executionId);
        return {
          status: 'error',
          output: null,
          console: consoleEntries,
          toolCalls: this.buildSummaries(executionId),
          durationMs,
          executionId,
          peakMemoryMb: result.peakMemoryMb,
          error: result.error,
        };
      }

      this.lifecycle.complete(executionId);
      return {
        status: 'success',
        output: result.output,
        console: consoleEntries,
        toolCalls: this.buildSummaries(executionId),
        durationMs,
        executionId,
        peakMemoryMb: result.peakMemoryMb,
      };
    } catch (err) {
      this.lifecycle.fail(executionId);
      return {
        status: 'error',
        output: null,
        console: consoleEntries,
        toolCalls: this.buildSummaries(executionId),
        durationMs: Date.now() - startMs,
        executionId,
        peakMemoryMb: 0,
        error: { message: err instanceof Error ? err.message : String(err) },
      };
    } finally {
      this.activeIsolates--;
    }
  }

  // ── Single Tool Call Handler ──

  private async handleToolCall(
    toolName: string,
    args: Record<string, unknown>,
    context: ToolCallContext,
    executionId: string,
  ): Promise<ToolCallResult> {
    // Budget check
    const budget = this.lifecycle.checkBudget(executionId);
    if (!budget.ok) {
      return {
        status: 'error',
        errorCode: 'BUDGET_EXCEEDED',
        message: budget.reason!,
        retryable: false,
        providerId: null,
      };
    }

    if (!this.lifecycle.isAlive(executionId)) {
      return {
        status: 'error',
        errorCode: 'EXECUTION_CANCELLED',
        message: 'Execution cancelled',
        retryable: false,
        providerId: null,
      };
    }

    // Resolve: identity + policy + idempotency key
    const seq = this.lifecycle.getCallCount(executionId);
    const resolution = await this.resolver.resolve(toolName, args, context, executionId, seq);

    if (!resolution.resolved) {
      return {
        status: 'approval_required' as ToolCallResult['status'],
        requiredGate: resolution.requiredGate!,
        requiredCapability: 'execution:code_eval',
        reason: resolution.reason,
        pendingArtifactId: '',
      } as ToolCallResult;
    }

    // Record as SENT
    const record: ToolCallRecord = {
      tool: toolName,
      sequenceNumber: seq,
      state: 'SENT',
      idempotencyKey: resolution.invocation.idempotencyKey,
      connectionId: resolution.invocation.identity.connectionId,
      sentAt: Date.now(),
    };

    this.emitter.emit('tool.started', { tool: toolName, executionId, sequenceNumber: seq });

    try {
      const result = await this.executor.dispatch(resolution.invocation);

      record.state = result.status === 'success' ? 'SUCCESS' : 'FAILED';
      record.result = result;
      record.completedAt = Date.now();

      this.emitter.emit('tool.finished', {
        tool: toolName,
        executionId,
        durationMs: record.completedAt - record.sentAt!,
        state: record.state,
        idempotencyKey: record.idempotencyKey,
      });

      this.lifecycle.recordToolCall(executionId, record);
      return result;
    } catch (err) {
      // UNKNOWN state — isolate killed mid-call, network partition, etc.
      record.state = 'UNKNOWN';
      record.completedAt = Date.now();

      this.emitter.emit('tool.failed', {
        tool: toolName,
        executionId,
        error: err instanceof Error ? err.message : String(err),
        state: 'UNKNOWN',
        idempotencyKey: record.idempotencyKey,
      });

      this.lifecycle.recordToolCall(executionId, record);

      // UNKNOWN recovery: execution fails. Agent retries entire block.
      console.error(
        `${LOG_PREFIX} Tool call "${toolName}" entered UNKNOWN state (idemp: ${record.idempotencyKey.slice(0, 12)}): ${err}`,
      );
      throw err;
    }
  }

  // ── Batch Handler ──

  private async handleBatch(
    calls: Array<{ tool: string; args: Record<string, unknown> }>,
    context: ToolCallContext,
    executionId: string,
  ): Promise<BatchResult> {
    const baseSequence = this.lifecycle.getCallCount(executionId);
    const resolvedAllowed: Array<{ index: number; invocation: ToolInvocation }> = [];
    const denied: BatchResult['denied'] = [];

    // Phase 1: Resolve all — split into allowed vs denied
    for (const [i, call] of calls.entries()) {
      const result = await this.resolver.resolve(
        call.tool,
        call.args,
        context,
        executionId,
        baseSequence + i,
      );
      if (result.resolved) {
        resolvedAllowed.push({ index: i, invocation: result.invocation });
      } else {
        denied.push({
          index: i,
          tool: call.tool,
          reason: result.reason,
          requiredGate: result.requiredGate,
        });
      }
    }

    // Phase 2: Dispatch allowed calls sequentially (v1). v2: parallel.
    const results: Array<ToolCallResult | null> = new Array(calls.length).fill(null);

    for (const { index, invocation } of resolvedAllowed) {
      const record: ToolCallRecord = {
        tool: invocation.identity.toolName,
        sequenceNumber: invocation.sequenceNumber,
        state: 'SENT',
        idempotencyKey: invocation.idempotencyKey,
        connectionId: invocation.identity.connectionId,
        sentAt: Date.now(),
      };

      this.emitter.emit('tool.started', {
        tool: invocation.identity.toolName,
        executionId,
        sequenceNumber: invocation.sequenceNumber,
      });

      try {
        const result = await this.executor.dispatch(invocation);
        record.state = result.status === 'success' ? 'SUCCESS' : 'FAILED';
        record.result = result;
        record.completedAt = Date.now();

        this.emitter.emit('tool.finished', {
          tool: invocation.identity.toolName,
          executionId,
          durationMs: record.completedAt - record.sentAt!,
          state: record.state,
          idempotencyKey: record.idempotencyKey,
        });

        this.lifecycle.recordToolCall(executionId, record);
        results[index] = result;
      } catch (err) {
        record.state = 'UNKNOWN';
        record.completedAt = Date.now();

        this.emitter.emit('tool.failed', {
          tool: invocation.identity.toolName,
          executionId,
          error: err instanceof Error ? err.message : String(err),
          state: 'UNKNOWN',
          idempotencyKey: record.idempotencyKey,
        });

        this.lifecycle.recordToolCall(executionId, record);
        throw err;
      }
    }

    return { results, denied };
  }

  // ── Helpers ──

  private isCodeModeError(output: unknown): boolean {
    return (
      typeof output === 'object' &&
      output !== null &&
      '__codemode_error' in output &&
      (output as Record<string, unknown>).__codemode_error === true
    );
  }

  private buildSummaries(executionId: string): ToolCallSummary[] {
    return this.lifecycle.getToolCalls(executionId).map(tc => ({
      tool: tc.tool,
      sequenceNumber: tc.sequenceNumber,
      state: tc.state,
      idempotencyKey: tc.idempotencyKey,
      durationMs: tc.completedAt && tc.sentAt ? tc.completedAt - tc.sentAt : 0,
      connectionId: tc.connectionId,
    }));
  }
}
