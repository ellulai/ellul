// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// Batch resolver: relative project names (e.g. "sbx-xyz/my-app") → orchestration
// ProjectId or null. file-api calls this once per /api/apps response to attach
// projectId on every ApiApp entry, letting the console hand the id straight to
// vps-ui instead of reverse-resolving from a CWD path.

import { PROJECT_NAME_RE } from "../config";
import type { IncomingMessage, ServerResponse } from "http";
import { Effect, Option } from "effect";

import type { ApplicationRuntime } from "../composition/ApplicationLayer";
import { gateInternalRoute, readJsonBody } from "./acl";
import { resolveProjectIdByWorkspaceName } from "./thread-resolver";

interface ResolveProjectsBody {
  readonly projects?: ReadonlyArray<string>;
}

const MAX_BATCH = 256;

export function makeResolveProjectsHandler(runtime: ApplicationRuntime) {
  return async function handleResolveProjects(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!gateInternalRoute(req, res, "/api/internal/resolve-projects")) return;
    const body = await readJsonBody<ResolveProjectsBody>(req, res);
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

    // Filter out anything that fails the shared project-name regex — cheaper
    // and safer than letting it hit the DB as junk.
    const valid: string[] = [];
    for (const p of body.projects) {
      if (typeof p === "string" && PROJECT_NAME_RE.test(p)) valid.push(p);
    }

    const effect = Effect.gen(function* () {
      const out: Record<string, string | null> = {};
      for (const name of valid) {
        const idOpt = yield* resolveProjectIdByWorkspaceName(name);
        out[name] = Option.isSome(idOpt) ? (idOpt.value as string) : null;
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
