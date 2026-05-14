// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Execution Lifecycle
 *
 * Ephemeral in-memory budget + cancellation tracker.
 * NOT durable — does not survive process restart.
 * v2 migrates to journal-backed state; this is a known-scope change.
 *
 * Invariants:
 *   - getCallCount() is monotonic, single-writer enforced
 *   - sequenceNumber = invocation order, NOT completion order
 *   - Terminal states cannot transition (state machine enforcement)
 *   - checkBudget enforces: tool count, wall-clock deadline, heap memory
 */

import * as crypto from 'crypto';

import type { ToolCallRecord, CodeModeExecutionConfig, ToolCallState } from './Types';
import { isTerminalState, DEFAULT_CONFIG } from './Types';

// ── Execution State ──

type ExecutionStatus = 'running' | 'completed' | 'cancelled' | 'failed';

interface ExecutionState {
  executionId: string;
  status: ExecutionStatus;
  config: CodeModeExecutionConfig;
  createdAt: number;
  deadline: number;
  /** Monotonic invocation count. Incremented on recordToolCall, not on completion. */
  invocationCount: number;
  /** Separate completion tracking — not tied to invocation order. */
  completedCount: number;
  toolCalls: ToolCallRecord[];
  cancelReason?: string;
}

export interface BudgetCheckResult {
  ok: boolean;
  reason?: string;
}

// ── Isolate heap stats (subset of isolated-vm's HeapStatistics) ──

interface HeapStatisticsLike {
  used_heap_size: number;
}

interface IsolateLike {
  getHeapStatisticsSync(): HeapStatisticsLike;
}

// ── Lifecycle Manager ──

export class ExecutionLifecycle {
  /** Ephemeral projection. Not durable. */
  private executions = new Map<string, ExecutionState>();

  /**
   * Create a new execution. Returns executionId.
   */
  create(config: Partial<CodeModeExecutionConfig> = {}): string {
    const executionId = crypto.randomUUID();
    const merged: CodeModeExecutionConfig = { ...DEFAULT_CONFIG, ...config };

    this.executions.set(executionId, {
      executionId,
      status: 'running',
      config: merged,
      createdAt: Date.now(),
      deadline: Date.now() + merged.timeoutMs,
      invocationCount: 0,
      completedCount: 0,
      toolCalls: [],
    });

    return executionId;
  }

  /**
   * Cancel a running execution.
   */
  cancel(executionId: string, reason = 'cancelled'): void {
    const state = this.executions.get(executionId);
    if (state && state.status === 'running') {
      state.status = 'cancelled';
      state.cancelReason = reason;
    }
  }

  /**
   * Check if an execution is still alive (running, not cancelled/timed out).
   */
  isAlive(executionId: string): boolean {
    const state = this.executions.get(executionId);
    if (!state) return false;
    if (state.status !== 'running') return false;
    if (Date.now() > state.deadline) {
      state.status = 'failed';
      return false;
    }
    return true;
  }

  /**
   * Check budget: tool call count + wall-clock deadline + heap memory.
   * Pass the isolate for heap memory check (optional, skipped if not provided).
   */
  checkBudget(executionId: string, isolate?: IsolateLike): BudgetCheckResult {
    const state = this.executions.get(executionId);
    if (!state) return { ok: false, reason: 'Execution not found' };

    if (state.status !== 'running') {
      return { ok: false, reason: `Execution ${state.status}` };
    }

    // Wall-clock deadline
    if (Date.now() > state.deadline) {
      state.status = 'failed';
      return { ok: false, reason: 'Execution timeout' };
    }

    // Tool call count
    if (state.invocationCount >= state.config.maxToolCalls) {
      return { ok: false, reason: `Tool call limit exceeded (${state.config.maxToolCalls})` };
    }

    // Heap memory (early warning at 90% before hard OOM kill)
    if (isolate) {
      try {
        const stats = isolate.getHeapStatisticsSync();
        const limitBytes = state.config.memoryLimitMb * 1024 * 1024;
        if (stats.used_heap_size > limitBytes * 0.9) {
          return { ok: false, reason: `Heap memory approaching limit (${state.config.memoryLimitMb}MB)` };
        }
      } catch {
        // If getHeapStatisticsSync fails (isolate disposed), budget check still passes
        // — the isolate's own OOM handler will catch it.
      }
    }

    return { ok: true };
  }

  /**
   * Record a tool call. Increments the monotonic invocation count.
   * Enforces state machine: terminal states cannot transition.
   */
  recordToolCall(executionId: string, record: ToolCallRecord): void {
    const state = this.executions.get(executionId);
    if (!state) return;

    // Check for duplicate sequence numbers (should never happen with single-writer)
    const existing = state.toolCalls.find(tc => tc.sequenceNumber === record.sequenceNumber);
    if (existing) {
      // Update existing record if it's not in a terminal state
      if (isTerminalState(existing.state)) return;
      existing.state = record.state;
      existing.completedAt = record.completedAt;
      existing.result = record.result;
      if (isTerminalState(record.state)) {
        state.completedCount++;
      }
      return;
    }

    state.toolCalls.push(record);
    state.invocationCount++;
    if (isTerminalState(record.state)) {
      state.completedCount++;
    }
  }

  /**
   * Get monotonic invocation count.
   * This is invocation order, NOT completion order.
   */
  getCallCount(executionId: string): number {
    return this.executions.get(executionId)?.invocationCount ?? 0;
  }

  /**
   * Get all tool call records for an execution.
   */
  getToolCalls(executionId: string): ToolCallRecord[] {
    return this.executions.get(executionId)?.toolCalls ?? [];
  }

  /**
   * Mark execution as complete. Terminal.
   */
  complete(executionId: string): void {
    const state = this.executions.get(executionId);
    if (state && state.status === 'running') {
      state.status = 'completed';
    }
  }

  /**
   * Mark execution as failed. Terminal.
   */
  fail(executionId: string): void {
    const state = this.executions.get(executionId);
    if (state && state.status === 'running') {
      state.status = 'failed';
    }
  }

  /**
   * Clean up finished executions older than maxAgeMs.
   */
  cleanup(maxAgeMs = 300_000): void {
    const now = Date.now();
    for (const [id, state] of this.executions) {
      if (state.status !== 'running' && now - state.createdAt > maxAgeMs) {
        this.executions.delete(id);
      }
    }
  }
}
