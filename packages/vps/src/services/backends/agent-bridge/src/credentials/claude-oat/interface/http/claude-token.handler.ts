// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

/**
 * HTTP handlers for the workbench-facing claude credential routes.
 *
 *   POST /api/internal/auth/claude-token  — user paste, proxies to /save.
 *   POST /api/internal/auth/claude-logout — user logout, proxies to /revoke.
 *
 * Both handlers proxy through the bridge bounded-context use cases; no
 * credential ever touches bridge state. The application-layer
 * proxySaveToken / proxyRevokeToken use cases handle cache invalidation.
 */

import type { IncomingMessage, ServerResponse } from "http";
import type { ClaudeOatBridgeModule } from "../../bootstrap";

const OAT_PATTERN = /^sk-ant-oat01-[A-Za-z0-9_-]{60,200}$/;

export function makeClaudeTokenHandler(module: ClaudeOatBridgeModule) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readJsonBody(req);
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    if (!OAT_PATTERN.test(token)) {
      sendJson(res, 400, {
        error:
          "Token must be a sk-ant-oat01-… OAuth token from `claude setup-token`.",
      });
      return;
    }
    const sessionId =
      typeof body?.sessionId === "string" && body.sessionId.length > 0
        ? body.sessionId
        : "bridge-proxy";

    try {
      const result = await module.proxySaveToken({ token, sessionId });
      if (!result.ok) {
        sendJson(res, result.status, result.body);
        return;
      }
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 502, {
        error: `Failed to reach sovereign-shield: ${(err as Error).message}`,
      });
    }
  };
}

export function makeClaudeLogoutHandler(module: ClaudeOatBridgeModule) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readJsonBody(req);
    const sessionId =
      typeof body?.sessionId === "string" && body.sessionId.length > 0
        ? body.sessionId
        : "bridge-proxy";
    try {
      const result = await module.proxyRevokeToken({
        sessionId,
        reason: "user-logout",
      });
      if (!result.ok) {
        sendJson(res, result.status, result.body);
        return;
      }
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 502, {
        error: `Failed to reach sovereign-shield: ${(err as Error).message}`,
      });
    }
  };
}

async function readJsonBody(
  req: IncomingMessage,
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        if (!text) return resolve(null);
        resolve(JSON.parse(text) as Record<string, unknown>);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
