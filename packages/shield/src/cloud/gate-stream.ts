// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Gate Stream — SSE client for receiving gate events from the VPS
 *
 * Maintains one SSE connection per registered project, with automatic
 * reconnection and exponential backoff on failure.
 *
 * Uses Node.js built-in fetch() with streaming — no external dependencies.
 *
 * SSE protocol (standard):
 *   event: gate_request
 *   data: {"requestId":"abc","gate":"db_write","project":"my-api"}
 *
 *   event: ping
 *   data: {}
 */

export interface GateEvent {
  type: 'gate_request' | 'gate_granted' | 'gate_denied' | 'gate_status' | 'ping';
  data: Record<string, unknown>;
  project: string;
}

export type GateEventHandler = (event: GateEvent) => void;

/** Backoff schedule: 1s → 2s → 4s → 8s → 16s → 30s (cap). */
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const BACKOFF_MULTIPLIER = 2;

interface StreamState {
  controller: AbortController;
  backoffMs: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  /** Set to true when disconnect() is called intentionally. */
  disposed: boolean;
}

export class GateStream {
  private streams = new Map<string, StreamState>();

  constructor(
    private proxyPort: number,
    private onEvent: GateEventHandler,
    private log: (msg: string) => void,
  ) {}

  /** Connect an SSE stream for a project. No-op if already connected. */
  connect(projectName: string): void {
    if (this.streams.has(projectName)) return;

    const state: StreamState = {
      controller: new AbortController(),
      backoffMs: INITIAL_BACKOFF_MS,
      reconnectTimer: null,
      disposed: false,
    };
    this.streams.set(projectName, state);

    this.startStream(projectName, state);
  }

  /** Disconnect the SSE stream for a project. */
  disconnect(projectName: string): void {
    const state = this.streams.get(projectName);
    if (!state) return;

    state.disposed = true;
    state.controller.abort();
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    this.streams.delete(projectName);
  }

  /** Disconnect all SSE streams (graceful shutdown). */
  dispose(): void {
    for (const name of [...this.streams.keys()]) {
      this.disconnect(name);
    }
  }

  // ── Private ──

  private async startStream(projectName: string, state: StreamState): Promise<void> {
    const url = `http://127.0.0.1:${this.proxyPort}/_auth/gates/stream?project=${encodeURIComponent(projectName)}`;

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Accept: 'text/event-stream' },
        signal: state.controller.signal,
      });
    } catch (err: unknown) {
      if (state.disposed) return;
      if (isAbortError(err)) return;

      this.log(`[sse] Connection failed for ${projectName}: ${errorMessage(err)}`);
      this.scheduleReconnect(projectName, state);
      return;
    }

    if (!response.ok) {
      this.log(`[sse] HTTP ${response.status} for ${projectName}, reconnecting`);
      // Drain the body to avoid leaks
      try { await response.text(); } catch {}
      if (!state.disposed) {
        this.scheduleReconnect(projectName, state);
      }
      return;
    }

    if (!response.body) {
      this.log(`[sse] No response body for ${projectName}`);
      if (!state.disposed) {
        this.scheduleReconnect(projectName, state);
      }
      return;
    }

    // Connected — reset backoff
    state.backoffMs = INITIAL_BACKOFF_MS;
    this.log(`[sse] Connected to gate stream for ${projectName}`);

    try {
      await this.readStream(projectName, state, response.body);
    } catch (err: unknown) {
      if (state.disposed) return;
      if (isAbortError(err)) return;

      this.log(`[sse] Stream error for ${projectName}: ${errorMessage(err)}`);
    }

    // Stream ended (server closed or network drop)
    if (!state.disposed) {
      this.log(`[sse] Disconnected from gate stream for ${projectName}, reconnecting in ${state.backoffMs / 1000}s`);
      this.scheduleReconnect(projectName, state);
    }
  }

  private async readStream(
    projectName: string,
    state: StreamState,
    body: ReadableStream<Uint8Array>,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || state.disposed) break;

        buffer += decoder.decode(value, { stream: true });

        // Split on double newline (SSE event boundary)
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);

          if (block.trim().length === 0) continue;

          const event = this.parseEvent(block, projectName);
          if (event) {
            try {
              this.onEvent(event);
            } catch (err: unknown) {
              this.log(`[sse] Event handler error: ${errorMessage(err)}`);
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Parse a single SSE event block.
   *
   * Expected format:
   *   event: <type>
   *   data: <json>
   *
   * Lines starting with ':' are comments (ignored per SSE spec).
   */
  private parseEvent(block: string, projectName: string): GateEvent | null {
    let eventType: string | null = null;
    let dataLine: string | null = null;

    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue; // SSE comment

      if (line.startsWith('event:')) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        // Concatenate multiple data lines per SSE spec
        const chunk = line.slice(5).trim();
        dataLine = dataLine ? dataLine + '\n' + chunk : chunk;
      }
    }

    if (!eventType && !dataLine) return null;

    // Default event type per SSE spec is "message"
    const type = (eventType || 'message') as GateEvent['type'];

    let data: Record<string, unknown> = {};
    if (dataLine) {
      try {
        data = JSON.parse(dataLine) as Record<string, unknown>;
      } catch {
        this.log(`[sse] Failed to parse event data for ${projectName}: ${dataLine}`);
        return null;
      }
    }

    return { type, data, project: projectName };
  }

  private scheduleReconnect(projectName: string, state: StreamState): void {
    if (state.disposed) return;

    const delay = state.backoffMs;
    state.backoffMs = Math.min(state.backoffMs * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS);

    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      if (state.disposed) return;

      // Create a fresh AbortController for the new attempt
      state.controller = new AbortController();
      this.startStream(projectName, state);
    }, delay);

    // Don't prevent process exit
    state.reconnectTimer.unref();
  }
}

// ── Helpers ──

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
