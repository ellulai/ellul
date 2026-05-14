// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// Per-project context-mode read/write. Sovereign-shield proxies here after
// verifying the operator signature; we are the authoritative store for
// project_settings.context_mode. Callers reach this via the internal-HTTP
// token + localhost gate (see acl.ts).

import { parseSandboxId } from "@ellul.ai/types";
import type { IncomingMessage, ServerResponse } from "http";

import { db } from "../database";
import { refreshProjectContext } from "../application/reconciliation/ZeroclawAgent";
import { PROJECTS_DIR } from "../config";
import { join } from "path";
import { gateInternalRoute, readJsonBody } from "./acl";

type ContextMode = "base" | "preview" | "deploy";
const VALID_MODES: ReadonlySet<ContextMode> = new Set(["base", "preview", "deploy"]);

function readContextMode(project: string): ContextMode {
  const row = db
    .prepare("SELECT context_mode FROM project_settings WHERE project = ?")
    .get(project) as { context_mode: string } | undefined;
  const raw = row?.context_mode ?? "base";
  return VALID_MODES.has(raw as ContextMode) ? (raw as ContextMode) : "base";
}

function writeContextMode(project: string, mode: ContextMode): void {
  db.prepare(
    `INSERT INTO project_settings (project, context_mode, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(project) DO UPDATE SET
       context_mode = excluded.context_mode,
       updated_at = excluded.updated_at`,
  ).run(project, mode, Date.now());
}

export async function handleContextModeGet(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  if (!gateInternalRoute(req, res, "/api/internal/context-mode")) return;
  const projectRaw = url.searchParams.get("project") || "";
  let project: string;
  try {
    project = parseSandboxId(projectRaw);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, reason: "Invalid sandbox id" }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ mode: readContextMode(project) }));
}

export async function handleContextModeSet(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!gateInternalRoute(req, res, "/api/internal/context-mode")) return;
  const body = await readJsonBody<{ project?: string; mode?: string }>(req, res);
  if (!body) return;
  if (!body.project || !body.mode) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, reason: "Missing project or mode" }));
    return;
  }
  if (!VALID_MODES.has(body.mode as ContextMode)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, reason: "Invalid mode" }));
    return;
  }
  let project: string;
  try {
    project = parseSandboxId(body.project);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, reason: "Invalid sandbox id" }));
    return;
  }
  const mode = body.mode as ContextMode;
  try {
    writeContextMode(project, mode);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
    return;
  }

  // Rewrite CLI context files (CLAUDE.md / AGENTS.md / GEMINI.md) so the next
  // agent turn picks up the new mode's prompt layers. Best-effort — storing
  // the setting is the source of truth; context refresh is a downstream render.
  try {
    refreshProjectContext(join(PROJECTS_DIR, project), mode);
  } catch {
    /* already warned inside refreshProjectContext */
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ mode }));
}
