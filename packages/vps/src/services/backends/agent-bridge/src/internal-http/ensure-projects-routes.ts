// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// Batch ensure-or-create projection_projects rows. Same response shape as
// /api/internal/resolve-projects but never returns null on a real hit — any
// missing project gets a fresh `project.create` dispatched through the
// orchestration engine (proper event sourcing, so the in-memory readModel
// stays consistent with the persisted projection). Lets file-api stamp every
// ApiApp/ApiPackage with a non-null projectId, killing the path-suffix
// fallback in vps-ui.

import * as crypto from "crypto";
import * as path from "path";
import type { IncomingMessage, ServerResponse } from "http";
import { Cause, Effect, Exit, Option } from "effect";
import { CommandId, ProjectId } from "@ellul.ai/types";

import type { ApplicationRuntime } from "../composition/ApplicationLayer";
import { PROJECTS_DIR } from "../config";
import { gateInternalRoute, readJsonBody } from "./acl";
import { resolveProjectIdByWorkspaceName } from "./thread-resolver";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine";

// Accepts app paths (`sbx-XXXXXXX/foo`) and nested package paths
// (`sbx-XXXXXXX/foo/packages/bar`). Sandbox-only names are intentionally
// rejected — file-api only ever ensures app/package roots.
const ENSURE_PROJECT_NAME_RE = /^sbx-[a-z0-9]{7}(\/[A-Za-z0-9._-]+)+$/;

const MAX_BATCH = 256;
const MAX_TITLE_LEN = 256;

interface EnsureProjectEntry {
  readonly name?: string;
  readonly title?: string;
}

interface EnsureProjectsBody {
  readonly projects?: ReadonlyArray<EnsureProjectEntry>;
}

export function makeEnsureProjectsHandler(runtime: ApplicationRuntime) {
  return async function handleEnsureProjects(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!gateInternalRoute(req, res, "/api/internal/ensure-projects")) return;
    const body = await readJsonBody<EnsureProjectsBody>(req, res);
    if (!body) return;
    if (!Array.isArray(body.projects)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: "Missing projects[]" }));
      return;
    }
    if (body.projects.length > MAX_BATCH) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: `Batch too large (max ${MAX_BATCH})` }));
      return;
    }

    const valid: { name: string; title: string }[] = [];
    for (const entry of body.projects) {
      if (!entry || typeof entry.name !== "string") continue;
      if (!ENSURE_PROJECT_NAME_RE.test(entry.name)) continue;
      const rawTitle =
        typeof entry.title === "string" && entry.title.length > 0
          ? entry.title
          : entry.name.split("/").pop() || entry.name;
      valid.push({ name: entry.name, title: rawTitle.slice(0, MAX_TITLE_LEN) });
    }

    const effect = Effect.gen(function* () {
      const orchestrationEngine = yield* OrchestrationEngineService;
      const out: Record<string, string> = {};
      for (const { name, title } of valid) {
        const idOpt = yield* resolveProjectIdByWorkspaceName(name);
        if (Option.isSome(idOpt)) {
          out[name] = idOpt.value as string;
          continue;
        }
        // Mint a fresh ProjectId and dispatch project.create through the
        // engine so the readModel + projection_projects table both pick it
        // up via the canonical event projection. A concurrent ensure for
        // the same name losing the race is benign: getActiveProjectByWorkspaceRoot
        // orders by created_at and returns the earlier row.
        const newProjectId = ProjectId.make(crypto.randomUUID());
        const newCommandId = CommandId.make(`internal-ensure:${crypto.randomUUID()}`);
        const workspaceRoot = path.join(PROJECTS_DIR, name);
        const dispatchExit = yield* Effect.exit(
          orchestrationEngine.dispatch({
            type: "project.create",
            commandId: newCommandId,
            projectId: newProjectId,
            title,
            workspaceRoot,
            createWorkspaceRootIfMissing: true,
            defaultModelSelection: null,
            createdAt: new Date().toISOString(),
          }),
        );
        if (Exit.isSuccess(dispatchExit)) {
          out[name] = newProjectId as unknown as string;
          continue;
        }
        // Engine rejected (e.g. requireProjectAbsent races a concurrent
        // dispatch). Re-resolve and use whichever project ended up bound
        // to this workspace_root. Skip the entry if even that misses —
        // the apps list still renders, the row will resolve on the next
        // /api/apps tick, and we don't want to fail the whole batch.
        const retry = yield* resolveProjectIdByWorkspaceName(name);
        if (Option.isSome(retry)) {
          out[name] = retry.value as string;
          continue;
        }
        console.error(
          `[Bridge] ensure-projects: dispatch failed for ${name}: ${Cause.pretty(dispatchExit.cause)}`,
        );
      }
      return out;
    });

    try {
      const result = await runtime.runPromise(effect);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ projectIds: result }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
    }
  };
}
