// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// Per-tool permission set/reset. Sovereign-shield proxies here after verifying
// the operator signature; we mutate the in-memory mcpGateway override map so
// the next agent turn picks up the new policy. Mirrors the context-mode shape
// (caller is agent-bridge service token via shield).

import type { IncomingMessage, ServerResponse } from "http";

import { mcpGateway } from "../application/mcp-tool/governance/McpGateway";
import type { ToolPermissionLevel } from "../application/mcp-tool/governance/Types";
import { gateInternalRoute, readJsonBody } from "./acl";

const VALID_LEVELS: ReadonlySet<ToolPermissionLevel> = new Set([
  "ask",
  "allow_session",
  "allow_always",
  "never",
]);

interface ToolPermissionSetBody {
  readonly connectionId?: string;
  readonly toolName?: string;
  readonly permission?: string;
}

interface ToolPermissionResetBody {
  readonly connectionId?: string;
  readonly toolName?: string;
}

function badRequest(res: ServerResponse, reason: string): void {
  res.writeHead(400, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, reason }));
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 256;
}

export async function handleToolPermissionSet(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!gateInternalRoute(req, res, "/api/internal/tool-permissions")) return;
  const body = await readJsonBody<ToolPermissionSetBody>(req, res);
  if (!body) return;
  if (!isNonEmptyString(body.connectionId)) return badRequest(res, "Missing connectionId");
  if (!isNonEmptyString(body.toolName)) return badRequest(res, "Missing toolName");
  if (!isNonEmptyString(body.permission)) return badRequest(res, "Missing permission");
  if (!VALID_LEVELS.has(body.permission as ToolPermissionLevel)) {
    return badRequest(res, "Invalid permission");
  }
  mcpGateway.setToolPermission(
    body.connectionId,
    body.toolName,
    body.permission as ToolPermissionLevel,
  );
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

export async function handleToolPermissionReset(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!gateInternalRoute(req, res, "/api/internal/tool-permissions/reset")) return;
  const body = await readJsonBody<ToolPermissionResetBody>(req, res);
  if (!body) return;
  if (!isNonEmptyString(body.connectionId)) return badRequest(res, "Missing connectionId");
  if (!isNonEmptyString(body.toolName)) return badRequest(res, "Missing toolName");
  mcpGateway.resetToolPermission(body.connectionId, body.toolName);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}
