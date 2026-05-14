// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Code-Mode Observability
 *
 * Three events. OTel-compatible shape:
 * - executionId → trace ID
 * - sequenceNumber → span ordering
 * - durationMs → span duration
 *
 * Wiring to OpenTelemetry is a consumer change, not a schema change.
 */

import type { ToolCallState } from './Types';

// ── Event Types ──

export interface ToolStartedEvent {
  tool: string;
  executionId: string;
  sequenceNumber: number;
}

export interface ToolFinishedEvent {
  tool: string;
  executionId: string;
  durationMs: number;
  state: ToolCallState;
  idempotencyKey: string;
}

export interface ToolFailedEvent {
  tool: string;
  executionId: string;
  error: string;
  state: ToolCallState;
  idempotencyKey: string;
}

export type CodeModeEventMap = {
  'tool.started': ToolStartedEvent;
  'tool.finished': ToolFinishedEvent;
  'tool.failed': ToolFailedEvent;
};

// ── Emitter Interface ──

export interface ObservabilityEmitter {
  emit<K extends keyof CodeModeEventMap>(event: K, data: CodeModeEventMap[K]): void;
}

// ── Default Implementation ──

type Listener<T> = (data: T) => void;

export class CodeModeObservability implements ObservabilityEmitter {
  private listeners = new Map<string, Set<Listener<unknown>>>();

  emit<K extends keyof CodeModeEventMap>(event: K, data: CodeModeEventMap[K]): void {
    const set = this.listeners.get(event);
    if (set) {
      for (const fn of set) {
        try { fn(data); } catch { /* observer errors must not crash execution */ }
      }
    }
  }

  on<K extends keyof CodeModeEventMap>(event: K, listener: Listener<CodeModeEventMap[K]>): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<unknown>);
  }

  off<K extends keyof CodeModeEventMap>(event: K, listener: Listener<CodeModeEventMap[K]>): void {
    this.listeners.get(event)?.delete(listener as Listener<unknown>);
  }
}
