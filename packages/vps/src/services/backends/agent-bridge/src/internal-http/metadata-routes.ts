// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import type { IncomingMessage, ServerResponse } from "http";
import * as path from "path";

import { PROJECT_NAME_RE, PROJECTS_DIR } from "../config";
import { reloadIntegrations } from "../application/mcp-tool/IntegrationLoader";
import { mcpGateway } from "../application/mcp-tool/governance/McpGateway";
import { refreshProjectContext } from "../application/reconciliation/ZeroclawAgent";
import { gateInternalRoute, readJsonBody } from "./acl";

export async function handleMetadataChanged(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!gateInternalRoute(req, res, "/api/internal/metadata-changed")) return;
  const body = await readJsonBody<{ project?: string }>(req, res);
  if (!body) return;
  if (!body.project || !PROJECT_NAME_RE.test(body.project)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Invalid project name" }));
    return;
  }
  try {
    refreshProjectContext(path.join(PROJECTS_DIR, body.project));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, project: body.project }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
  }
}

export async function handleReloadIntegrations(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!gateInternalRoute(req, res, "/api/internal/reload-integrations")) return;
  try {
    await reloadIntegrations();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        toolCount: mcpGateway.getAllApprovedTools().length,
        connectionCount: mcpGateway.getActiveConnectionIds().length,
      }),
    );
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
  }
}
