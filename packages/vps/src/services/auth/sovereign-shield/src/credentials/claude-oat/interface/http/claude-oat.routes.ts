// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

/**
 * HTTP route handlers — thin adapters over application commands.
 *
 * All routes are gated by:
 *   - tierGateMiddleware
 *   - productGateMiddleware
 *   - originAllowlistMiddleware
 *   - requireInternalTokenMiddleware
 *
 * The ACL in middleware/internal-auth.middleware.ts must include the
 * /api/internal/claude-oat/ prefix with allow=[BRIDGE]. Launcher inherits
 * BRIDGE shield-ipc identity (via supplementary group propagation).
 */

import type { Hono } from "hono";
import {
  CLAUDE_OAT_ROUTES,
  OAT_TOKEN_PATTERN,
} from "@vps/shared/claude-oat";
import type { ClaudeOatModule } from "../../bootstrap";
import { ClaudeOatError } from "../../domain/errors";

export function registerClaudeOatRoutes(
  app: Hono,
  module: ClaudeOatModule,
): void {
  // ── /save — user pasted a new OAT in the workbench login modal ────────
  app.post(CLAUDE_OAT_ROUTES.save, async (c) => {
    const body = await safeJson(c);
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    const sessionId =
      typeof body?.sessionId === "string" ? body.sessionId : "";
    if (!OAT_TOKEN_PATTERN.test(token)) {
      return c.json(
        {
          error:
            "Token must be a sk-ant-oat01-… OAuth token from `claude setup-token`.",
        },
        400,
      );
    }
    if (!sessionId) {
      return c.json({ error: "sessionId required" }, 400);
    }
    try {
      const result = module.saveToken({ token, sessionId });
      return c.json({ ok: true, ...result }, 200);
    } catch (err) {
      if (err instanceof ClaudeOatError) {
        return c.json({ error: err.message, code: err.code }, 400);
      }
      console.error("[claude-oat] save failed:", (err as Error).message);
      return c.json({ error: "Save failed" }, 500);
    }
  });

  // ── /peek — UI status query (never returns the token itself) ──────────
  app.get(CLAUDE_OAT_ROUTES.peek, (c) => {
    try {
      return c.json(module.peek(), 200);
    } catch (err) {
      console.error("[claude-oat] peek failed:", (err as Error).message);
      return c.json({ error: "Peek failed" }, 500);
    }
  });

  // ── /issue — bridge mints a one-time issuance token ───────────────────
  app.post(CLAUDE_OAT_ROUTES.issue, async (c) => {
    const body = await safeJson(c);
    const threadId =
      typeof body?.threadId === "string" ? body.threadId : "";
    const project =
      typeof body?.project === "string" && body.project.length > 0
        ? body.project
        : null;
    if (!threadId) {
      return c.json({ error: "threadId required" }, 400);
    }
    try {
      const result = module.issueOat({ threadId, project });
      return c.json(result, 200);
    } catch (err) {
      console.error("[claude-oat] issue failed:", (err as Error).message);
      return c.json({ error: "Issue failed" }, 500);
    }
  });

  // ── /redeem — launcher exchanges issuance token for actual OAT ────────
  app.post(CLAUDE_OAT_ROUTES.redeem, async (c) => {
    const body = await safeJson(c);
    const issuanceToken =
      typeof body?.issuanceToken === "string" ? body.issuanceToken : "";
    if (!issuanceToken) {
      return c.json({ error: "issuanceToken required" }, 400);
    }
    const result = module.redeemOat({ issuanceToken });
    if (!result.ok) {
      const status = result.code === "credential-not-active" ? 423 : 410;
      return c.json({ error: result.error, code: result.code }, status);
    }
    return c.json({ token: result.token }, 200);
  });

  // ── /report-401 — bridge audit-only signal ────────────────────────────
  app.post(CLAUDE_OAT_ROUTES.report401, async (c) => {
    const body = await safeJson(c);
    const threadId =
      typeof body?.threadId === "string" ? body.threadId : "";
    if (!threadId) {
      return c.json({ error: "threadId required" }, 400);
    }
    const turnId = typeof body?.turnId === "string" ? body.turnId : null;
    const anthropicRequestId =
      typeof body?.anthropicRequestId === "string"
        ? body.anthropicRequestId
        : null;
    const model = typeof body?.model === "string" ? body.model : null;
    try {
      const result = module.reportUnauth({
        threadId,
        turnId,
        anthropicRequestId,
        model,
      });
      return c.json({ ok: true, ...result }, 200);
    } catch (err) {
      console.error(
        "[claude-oat] report-401 failed:",
        (err as Error).message,
      );
      return c.json({ error: "Report failed" }, 500);
    }
  });

  // ── /revoke — user clicked logout ─────────────────────────────────────
  app.post(CLAUDE_OAT_ROUTES.revoke, async (c) => {
    const body = await safeJson(c);
    const sessionId =
      typeof body?.sessionId === "string" ? body.sessionId : "";
    const reason: "user-logout" | "user-rotation" =
      body?.reason === "user-rotation" ? "user-rotation" : "user-logout";
    if (!sessionId) {
      return c.json({ error: "sessionId required" }, 400);
    }
    try {
      const result = module.revokeOat({ sessionId, reason });
      return c.json({ ok: true, ...result }, 200);
    } catch (err) {
      console.error("[claude-oat] revoke failed:", (err as Error).message);
      return c.json({ error: "Revoke failed" }, 500);
    }
  });
}

async function safeJson(
  c: import("hono").Context,
): Promise<Record<string, unknown> | null> {
  try {
    return (await c.req.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}
