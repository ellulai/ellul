// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import type { IncomingMessage, ServerResponse } from "http";

import { gateInternalRoute, readJsonBody } from "./acl";
import { closeAllSessionConnections, closeSessionConnections } from "./session-registry";

const WS_CLOSE_CODE_REVOKED = 4004;

export async function handleSessionRevoked(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!gateInternalRoute(req, res, "/api/internal/session-revoked")) return;
  const body = await readJsonBody<{ sessionId?: string; reason?: string }>(req, res);
  if (!body) return;
  const notifyReason = body.reason || "revoked";
  const sent = body.sessionId
    ? closeSessionConnections(body.sessionId, WS_CLOSE_CODE_REVOKED, notifyReason)
    : closeAllSessionConnections(WS_CLOSE_CODE_REVOKED, notifyReason);
  console.log(
    `[Bridge] Session revocation closed ${sent} connection(s), reason: ${notifyReason}`,
  );
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, sent }));
}
