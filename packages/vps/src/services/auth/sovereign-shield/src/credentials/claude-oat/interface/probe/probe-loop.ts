// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

/**
 * The probe loop. Runs every PROBE_INTERVAL_MS, asks the application
 * layer for the active token, calls the Anthropic probe client, hands
 * the result back to record-probe-outcome.
 *
 * Backoff state is process-local: rate-limits and 5xx errors push the
 * next probe out 30s/60s/120s/300s. Auth failures and successes are not
 * subject to backoff — they're the load-bearing signals.
 */

import {
  PROBE_INTERVAL_MS,
  RATE_LIMIT_BACKOFF_MS,
} from "@vps/shared/claude-oat";
import type { ClaudeOatModule } from "../../bootstrap";
import type { AnthropicProbeClient } from "./anthropic-probe.client";

export class ProbeLoop {
  private timer: NodeJS.Timeout | null = null;
  private backoffUntil = 0;
  private consecutiveBackoffCount = 0;
  private inflight = false;

  constructor(
    private readonly module: ClaudeOatModule,
    private readonly client: AnthropicProbeClient,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, PROBE_INTERVAL_MS);
    if (this.timer.unref) this.timer.unref();
    setImmediate(() => {
      void this.tick();
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.inflight) return;
    const now = Date.now();
    const immediate = this.module.consumeImmediateProbeFlag();
    if (now < this.backoffUntil && !immediate) return;

    this.module.sweepExpiredIssuances();

    const token = this.module.getTokenForProbe();
    if (!token) {
      this.backoffUntil = 0;
      this.consecutiveBackoffCount = 0;
      return;
    }

    this.inflight = true;
    try {
      const startedAt = Date.now();
      const ts = new Date(startedAt).toISOString();
      const result = await this.client.probe(token, ts, startedAt);
      this.module.recordProbeOutcome(result);

      if (
        result.outcome === "rate-limited" ||
        result.outcome === "anthropic-error" ||
        result.outcome === "network-error"
      ) {
        const idx = Math.min(
          this.consecutiveBackoffCount,
          RATE_LIMIT_BACKOFF_MS.length - 1,
        );
        this.backoffUntil = Date.now() + RATE_LIMIT_BACKOFF_MS[idx]!;
        this.consecutiveBackoffCount++;
      } else {
        this.backoffUntil = 0;
        this.consecutiveBackoffCount = 0;
      }
    } catch (err) {
      console.error(
        "[claude-oat-probe] unexpected error:",
        (err as Error).message,
      );
    } finally {
      this.inflight = false;
    }
  }
}
