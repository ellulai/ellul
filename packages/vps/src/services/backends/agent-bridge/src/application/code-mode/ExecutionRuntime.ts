// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Execution Runtime
 *
 * Stateless. Disposable. No policy logic.
 * Owns ONLY the V8 isolate, the secureExecute/secureExecuteBatch bridges,
 * and console capture.
 *
 * The runtime receives callbacks (onToolCall, onBatchCall, onConsole) —
 * it does not know what happens inside them. Policy checks, routing,
 * retries, rate limiting all happen in the callbacks, invisible to the runtime.
 *
 * The sandbox is a dumb executor.
 *
 * Security model:
 *   - JS-level hardening (Object.freeze, delete eval) is hygiene only.
 *   - Real security: policy engine + gate system + kernel isolation.
 *   - isolated-vm V8 boundary is defense-in-depth, not primary trust.
 */

import ivm from 'isolated-vm';

import type { RuntimeResult, ToolCallResult, BatchResult } from './Types';

const LOG_PREFIX = '[CodeMode-Runtime]';

export interface RuntimeConfig {
  timeoutMs: number;
  memoryLimitMb: number;
}

export class ExecutionRuntime {
  /**
   * Execute code in a fresh V8 isolate.
   *
   * @param code        - Agent-generated TypeScript/JavaScript code
   * @param typeDefs    - Type definitions string for system prompt context (included as comment)
   * @param config      - Timeout and memory limits
   * @param onToolCall  - Callback for secureExecute() — the ONLY tool invocation path
   * @param onBatchCall - Callback for secureExecuteBatch()
   * @param onConsole   - Callback for console.log/warn/error capture
   */
  async execute(
    code: string,
    typeDefs: string,
    config: RuntimeConfig,
    onToolCall: (toolName: string, args: Record<string, unknown>) => Promise<ToolCallResult>,
    onBatchCall: (calls: Array<{ tool: string; args: Record<string, unknown> }>) => Promise<BatchResult>,
    onConsole: (level: string, args: string[]) => void,
  ): Promise<RuntimeResult & { peakMemoryMb: number }> {
    const isolate = new ivm.Isolate({ memoryLimit: config.memoryLimitMb });

    try {
      const context = await isolate.createContext();
      const jail = context.global;

      // ── 1. Inject console bridge ──
      await this.injectConsoleBridge(jail, onConsole);

      // ── 2. Inject secureExecute bridge ──
      await this.injectToolBridge(jail, onToolCall);

      // ── 3. Inject secureExecuteBatch bridge ──
      await this.injectBatchBridge(jail, onBatchCall);

      // ── 4. Hardening (hygiene only, not a security boundary) ──
      await this.hardenContext(context);

      // ── 5. Build and execute bootstrap + user code ──
      const wrappedCode = this.buildBootstrapScript(code);
      const module = await isolate.compileScript(wrappedCode);

      let rawResult: string;
      try {
        // promise: true is CRITICAL — without it, the async IIFE returns an opaque
        // Promise Reference instead of the resolved value. This tells isolated-vm
        // to proxy the Promise and wait for resolution before returning.
        rawResult = await module.run(context, { timeout: config.timeoutMs, promise: true }) as string;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('Script execution timed out') || msg.includes('isolate was disposed')) {
          return {
            status: 'timeout',
            peakMemoryMb: this.getPeakMemory(isolate),
          };
        }
        return {
          status: 'error',
          error: { message: msg, stack: err instanceof Error ? err.stack : undefined },
          peakMemoryMb: this.getPeakMemory(isolate),
        };
      }

      // ── 6. Parse result ──
      let output: unknown;
      try {
        output = rawResult !== undefined ? JSON.parse(rawResult) : undefined;
      } catch {
        output = rawResult;
      }

      return {
        status: 'success',
        output,
        peakMemoryMb: this.getPeakMemory(isolate),
      };
    } finally {
      isolate.dispose();
    }
  }

  // ── Console Bridge ──

  private async injectConsoleBridge(
    jail: ivm.Reference<Record<string, unknown>>,
    onConsole: (level: string, args: string[]) => void,
  ): Promise<void> {
    // Host side receives pre-stringified args (strings are transferable).
    // Stringification happens inside the isolate (see bootstrap script)
    // to avoid transferring non-primitive objects across the boundary.
    const logRef = new ivm.Reference((level: string, argsJson: string) => {
      try {
        const args = JSON.parse(argsJson) as string[];
        onConsole(level, args);
      } catch { /* observer errors must not crash execution */ }
    });

    await jail.set('__consoleRef', logRef);
  }

  // ── secureExecute Bridge ──

  private async injectToolBridge(
    jail: ivm.Reference<Record<string, unknown>>,
    onToolCall: (toolName: string, args: Record<string, unknown>) => Promise<ToolCallResult>,
  ): Promise<void> {
    const callToolRef = new ivm.Reference(
      async (toolNameTransfer: string, argsJsonTransfer: string): Promise<string> => {
        const toolName = toolNameTransfer;
        const args = JSON.parse(argsJsonTransfer) as Record<string, unknown>;
        const result = await onToolCall(toolName, args);
        return JSON.stringify(result);
      },
    );

    await jail.set('__callToolRef', callToolRef);
  }

  // ── secureExecuteBatch Bridge ──

  private async injectBatchBridge(
    jail: ivm.Reference<Record<string, unknown>>,
    onBatchCall: (calls: Array<{ tool: string; args: Record<string, unknown> }>) => Promise<BatchResult>,
  ): Promise<void> {
    const batchRef = new ivm.Reference(
      async (callsJsonTransfer: string): Promise<string> => {
        const calls = JSON.parse(callsJsonTransfer) as Array<{ tool: string; args: Record<string, unknown> }>;
        const result = await onBatchCall(calls);
        return JSON.stringify(result);
      },
    );

    await jail.set('__batchCallRef', batchRef);
  }

  // ── Hardening (hygiene only) ──

  private async hardenContext(context: ivm.Context): Promise<void> {
    await context.eval(`
      'use strict';
      Object.freeze(Object.prototype);
      Object.freeze(Array.prototype);
      Object.freeze(String.prototype);
      Object.freeze(Number.prototype);
      Object.freeze(Boolean.prototype);
      Object.freeze(Function.prototype);
      Object.freeze(RegExp.prototype);
      Object.freeze(Date.prototype);
      Object.freeze(Error.prototype);
      Object.freeze(Map.prototype);
      Object.freeze(Set.prototype);
      Object.freeze(Promise.prototype);
      Object.freeze(JSON);
      Object.freeze(Math);
      delete globalThis.Function;
      delete globalThis.eval;
      delete globalThis.Proxy;
    `);
  }

  // ── Bootstrap Script ──

  private buildBootstrapScript(userCode: string): string {
    // The bootstrap defines secureExecute and secureExecuteBatch,
    // wraps user code in an async IIFE, and serializes the return value.
    return `
      'use strict';

      // ── Console ──
      // Args are stringified inside the isolate before crossing the boundary.
      // Non-primitive values (objects, arrays) are NOT transferable via applyIgnored.
      const __safeStr = (v) => {
        if (typeof v === 'string') return v;
        try { return JSON.stringify(v); } catch { return String(v); }
      };
      const console = {
        log: (...args) => __consoleRef.applyIgnored(undefined, ['log', JSON.stringify(args.map(__safeStr))]),
        warn: (...args) => __consoleRef.applyIgnored(undefined, ['warn', JSON.stringify(args.map(__safeStr))]),
        error: (...args) => __consoleRef.applyIgnored(undefined, ['error', JSON.stringify(args.map(__safeStr))]),
      };

      // ── secureExecute — single tool invocation surface ──
      async function secureExecute(toolName, args) {
        if (typeof toolName !== 'string') throw new TypeError('Tool name must be a string');
        const resultJson = __callToolRef.applySyncPromise(
          undefined,
          [String(toolName), JSON.stringify(args != null ? args : {})]
        );
        const result = JSON.parse(resultJson);
        if (result.status === 'error') {
          const err = new Error(result.message || result.errorCode || 'Tool call failed');
          err.toolError = true;
          throw err;
        }
        if (result.status === 'approval_required') {
          const err = new Error('Gate required: ' + (result.requiredGate || 'unknown'));
          err.gateRequired = true;
          err.requiredGate = result.requiredGate;
          throw err;
        }
        if (result.status === 'denied') {
          const err = new Error('Tool denied: ' + (result.reason || 'unknown'));
          err.toolDenied = true;
          throw err;
        }
        return result.output;
      }

      // ── secureExecuteBatch — parallel tool invocation ──
      // Returns { results: unknown[], denied: { index, tool, reason }[] }
      // Agent should check denied array for partial execution handling.
      async function secureExecuteBatch(calls) {
        if (!Array.isArray(calls)) throw new TypeError('Batch calls must be an array');
        const callsJson = JSON.stringify(
          calls.map(c => ({ tool: String(c.tool), args: c.args != null ? c.args : {} }))
        );
        const resultJson = __batchCallRef.applySyncPromise(undefined, [callsJson]);
        const batch = JSON.parse(resultJson);

        return {
          results: batch.results.map((r) => {
            if (r === null) return null;
            if (r.status === 'success') return r.output;
            if (r.status === 'error') {
              const err = new Error(r.message || r.errorCode || 'Batch tool call failed');
              err.toolError = true;
              throw err;
            }
            return null;
          }),
          denied: batch.denied || [],
        };
      }

      // ── Execute user code as async IIFE ──
      (async () => {
        try {
          const __result = await (async () => {
            ${userCode}
          })();
          return JSON.stringify(__result === undefined ? null : __result);
        } catch (err) {
          if (err && err.gateRequired) {
            return JSON.stringify({
              __codemode_error: true,
              type: 'gate_required',
              gate: err.requiredGate,
              message: err.message,
            });
          }
          if (err && err.toolDenied) {
            return JSON.stringify({
              __codemode_error: true,
              type: 'tool_denied',
              message: err.message,
            });
          }
          return JSON.stringify({
            __codemode_error: true,
            type: 'execution_error',
            message: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          });
        }
      })();
    `;
  }

  // ── Heap Memory ──

  private getPeakMemory(isolate: ivm.Isolate): number {
    try {
      const stats = isolate.getHeapStatisticsSync();
      return Math.round(stats.used_heap_size / (1024 * 1024) * 100) / 100;
    } catch {
      return 0;
    }
  }
}
