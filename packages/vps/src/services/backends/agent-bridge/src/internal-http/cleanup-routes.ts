// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { CommandId } from "@ellul.ai/types";
import { Effect, Option } from "effect";
import type { IncomingMessage, ServerResponse } from "http";

import type { ApplicationRuntime } from "../composition/ApplicationLayer";
import { PROJECT_NAME_RE } from "../config";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine";
import { gateInternalRoute, readJsonBody } from "./acl";
import { resolveProjectIdByWorkspaceName } from "./thread-resolver";

export function makeCleanupProjectHandler(runtime: ApplicationRuntime) {
  return async function handleCleanupProject(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!gateInternalRoute(req, res, "/api/cleanup-project")) return;
    const body = await readJsonBody<{ project?: string }>(req, res);
    if (!body) return;
    if (!body.project || !PROJECT_NAME_RE.test(body.project)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Invalid project name" }));
      return;
    }
    const projectName = body.project;
    const effect = Effect.gen(function* () {
      const projectIdOpt = yield* resolveProjectIdByWorkspaceName(projectName);
      if (Option.isNone(projectIdOpt)) return { deleted: 0 };
      const engine = yield* OrchestrationEngineService;
      yield* engine.dispatch({
        type: "project.delete",
        commandId: CommandId.make(`server:cleanup-project:${crypto.randomUUID()}`),
        projectId: projectIdOpt.value,
        force: true,
      });
      return { deleted: 1 };
    });
    try {
      const result = await runtime.runPromise(effect);
      console.log(`[Bridge] Cleaned up project "${projectName}" (dispatched=${result.deleted})`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, deleted: result.deleted }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: (err as Error).message }));
    }
  };
}
