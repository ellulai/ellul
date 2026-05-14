// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

/**
 * Production ShieldOatGateway adapter.
 *
 * Wraps callShieldInternal — the shared bridge → shield HTTP client that
 * authenticates with the per-service shield-ipc token. This is the only
 * file in the bridge bounded context that knows about the HTTP transport.
 */

import { callShieldInternal } from "@vps/shared/shield-client";
import {
  CLAUDE_OAT_ROUTES,
  type IssueRequest,
  type IssueResponse,
  type RedeemRequest,
  type RedeemResponse,
  type Report401Request,
  type Report401Response,
  type RevokeRequest,
  type RevokeResponse,
  type SafePeekResponse,
  type SaveRequest,
  type SaveResponse,
} from "@vps/shared/claude-oat";
import type { ShieldHttpResult, ShieldOatGateway } from "../application/ports";

const ISSUE_TIMEOUT_MS = 5_000;
const PEEK_TIMEOUT_MS = 6_000;
const REPORT_TIMEOUT_MS = 3_000;
const SAVE_TIMEOUT_MS = 8_000;
const SAVE_RETRY_COUNT = 1;
const REVOKE_TIMEOUT_MS = 8_000;

export class HttpShieldOatGateway implements ShieldOatGateway {
  async issue(req: IssueRequest): Promise<IssueResponse | null> {
    try {
      const res = await callShieldInternal(CLAUDE_OAT_ROUTES.issue, {
        method: "POST",
        body: req,
        timeout: ISSUE_TIMEOUT_MS,
      });
      if (!res.ok) return null;
      return (await res.json()) as IssueResponse;
    } catch {
      return null;
    }
  }

  async redeem(req: RedeemRequest): Promise<RedeemResponse | null> {
    try {
      const res = await callShieldInternal(CLAUDE_OAT_ROUTES.redeem, {
        method: "POST",
        body: req,
        timeout: ISSUE_TIMEOUT_MS,
      });
      if (!res.ok) return null;
      return (await res.json()) as RedeemResponse;
    } catch {
      return null;
    }
  }

  async peek(): Promise<SafePeekResponse | null> {
    try {
      const res = await callShieldInternal(CLAUDE_OAT_ROUTES.peek, {
        method: "GET",
        timeout: PEEK_TIMEOUT_MS,
      });
      if (!res.ok) return null;
      return (await res.json()) as SafePeekResponse;
    } catch {
      return null;
    }
  }

  async reportUnauth(req: Report401Request): Promise<Report401Response | null> {
    try {
      const res = await callShieldInternal(CLAUDE_OAT_ROUTES.report401, {
        method: "POST",
        body: req,
        timeout: REPORT_TIMEOUT_MS,
      });
      if (!res.ok) return null;
      return (await res.json()) as Report401Response;
    } catch {
      return null;
    }
  }

  async save(req: SaveRequest): Promise<ShieldHttpResult<SaveResponse>> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= SAVE_RETRY_COUNT; attempt++) {
      try {
        const res = await callShieldInternal(CLAUDE_OAT_ROUTES.save, {
          method: "POST",
          body: req,
          timeout: SAVE_TIMEOUT_MS,
        });
        let body: unknown = null;
        try {
          body = await res.json();
        } catch {}
        // 4xx is an authoritative shield rejection; retry only 5xx.
        if (!res.ok && res.status >= 500 && attempt < SAVE_RETRY_COUNT) {
          continue;
        }
        return {
          ok: res.ok,
          status: res.status,
          body: body as SaveResponse | { error?: string; code?: string },
        };
      } catch (err) {
        lastError = err;
        if (attempt < SAVE_RETRY_COUNT) continue;
        throw err;
      }
    }
    throw lastError ?? new Error("save: exhausted retries");
  }

  async revoke(req: RevokeRequest): Promise<ShieldHttpResult<RevokeResponse>> {
    const res = await callShieldInternal(CLAUDE_OAT_ROUTES.revoke, {
      method: "POST",
      body: req,
      timeout: REVOKE_TIMEOUT_MS,
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {}
    return {
      ok: res.ok,
      status: res.status,
      body: body as RevokeResponse | { error?: string; code?: string },
    };
  }
}
