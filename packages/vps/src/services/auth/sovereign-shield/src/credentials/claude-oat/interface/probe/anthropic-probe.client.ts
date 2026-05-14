// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

/**
 * Anthropic API probe client.
 *
 * Performs the cheapest possible authenticated call to verify an OAT.
 * Maps HTTP status codes onto the domain's ClaudeOatProbeOutcome union.
 */

import {
  ANTHROPIC_API_BASE,
  ANTHROPIC_API_VERSION,
  PROBE_MODEL,
  PROBE_TIMEOUT_MS,
  type ClaudeOatProbeOutcome,
  type ProbeRecord,
} from "@vps/shared/claude-oat";

export interface AnthropicProbeClient {
  probe(token: string, ts: string, startedAt: number): Promise<ProbeRecord>;
}

export class HttpAnthropicProbeClient implements AnthropicProbeClient {
  async probe(
    token: string,
    ts: string,
    startedAt: number,
  ): Promise<ProbeRecord> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

    try {
      const res = await fetch(`${ANTHROPIC_API_BASE}/v1/messages`, {
        method: "POST",
        headers: {
          "anthropic-version": ANTHROPIC_API_VERSION,
          authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
          "content-type": "application/json",
          "x-api-key": "",
          "user-agent": "claude-code/probe",
        },
        body: JSON.stringify({
          model: PROBE_MODEL,
          max_tokens: 1,
          messages: [{ role: "user", content: "ok" }],
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const latencyMs = Date.now() - startedAt;
      const requestId = res.headers.get("request-id");
      try {
        await res.text();
      } catch {}

      const outcome: ClaudeOatProbeOutcome =
        res.status === 200
          ? "ok"
          : res.status === 401
            ? "auth-failed"
            : res.status === 429
              ? "rate-limited"
              : res.status >= 500
                ? "anthropic-error"
                : "anthropic-error";

      return {
        ts,
        outcome,
        latencyMs,
        httpStatus: res.status,
        anthropicRequestId: requestId,
      };
    } catch {
      clearTimeout(timer);
      const latencyMs = Date.now() - startedAt;
      return {
        ts,
        outcome: "network-error",
        latencyMs,
        httpStatus: null,
        anthropicRequestId: null,
      };
    }
  }
}
