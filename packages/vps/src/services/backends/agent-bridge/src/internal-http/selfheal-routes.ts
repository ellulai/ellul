// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { ELLUL_ACTIVITY_KINDS } from "@ellul.ai/types";
import { Effect, Option } from "effect";
import type { IncomingMessage, ServerResponse } from "http";

import type { ApplicationRuntime } from "../composition/ApplicationLayer";
import { scaffoldProjectDirect } from "../application/code-mode/PlatformTools";
import { appendActivity, startContinuationTurn } from "./dispatch-activity";
import { gateLocalhostOnly, readJsonBody } from "./acl";
import { resolveFirstThreadIdForProject } from "./thread-resolver";

export function makePreviewErrorHandler(runtime: ApplicationRuntime) {
  return async function handlePreviewError(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!gateLocalhostOnly(req, res)) return;
    const body = await readJsonBody<{
      projectName?: string;
      error?: string;
      logTail?: string;
    }>(req, res);
    if (!body) return;
    if (!body.projectName || !body.error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: "Missing projectName or error" }));
      return;
    }
    const logSection = body.logTail ? `\n\nRelevant logs:\n${body.logTail.slice(-2048)}` : "";
    const prompt =
      `[Preview Build Error]\nThe dev server for this project failed to start. Here is the error output:\n\n${body.error}${logSection}\n\nPlease fix the code issue causing this build failure. After fixing, the dev server will automatically restart.`;

    const effect = Effect.gen(function* () {
      const threadIdOpt = yield* resolveFirstThreadIdForProject(body.projectName!);
      if (Option.isNone(threadIdOpt)) return null;
      const threadId = threadIdOpt.value;
      yield* appendActivity({
        threadId,
        tone: "error",
        kind: ELLUL_ACTIVITY_KINDS.previewError,
        summary: `Preview build error: ${body.error!.slice(0, 140)}`,
        payload: { error: body.error, logTail: body.logTail ?? null },
      });
      yield* startContinuationTurn({ threadId, text: prompt });
      return threadId;
    });

    try {
      const threadId = await runtime.runPromise(effect);
      if (!threadId) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, reason: "No active thread for project" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, threadId }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
    }
  };
}

export function makeOpenapiMissingHandler(runtime: ApplicationRuntime) {
  return async function handleOpenapiMissing(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!gateLocalhostOnly(req, res)) return;
    const body = await readJsonBody<{ projectName?: string; framework?: string }>(req, res);
    if (!body) return;
    if (!body.projectName) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: "Missing projectName" }));
      return;
    }
    const frameworkHint =
      body.framework && body.framework !== "unknown" ? `\nDetected framework: ${body.framework}` : "";
    const prompt =
      `[OpenAPI Spec Missing]\nYour backend API is running but has no OpenAPI specification endpoint.${frameworkHint}\nPlease add a GET /openapi.json route that returns a valid OpenAPI 3.0 JSON spec describing all your API routes.\n\nRequirements:\n- Add a GET /openapi.json endpoint\n- Response must be valid OpenAPI 3.0 JSON\n- Include all existing routes with methods and paths\n- Do NOT install heavyweight swagger UI packages — just serve the raw JSON spec`;

    const effect = Effect.gen(function* () {
      const threadIdOpt = yield* resolveFirstThreadIdForProject(body.projectName!);
      if (Option.isNone(threadIdOpt)) return null;
      const threadId = threadIdOpt.value;
      yield* appendActivity({
        threadId,
        tone: "info",
        kind: ELLUL_ACTIVITY_KINDS.openapiMissing,
        summary: "OpenAPI spec endpoint missing",
        payload: { framework: body.framework ?? null },
      });
      yield* startContinuationTurn({ threadId, text: prompt });
      return threadId;
    });

    try {
      const threadId = await runtime.runPromise(effect);
      if (!threadId) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, reason: "No active thread for project" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, threadId }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
    }
  };
}

const SCAFFOLD_MAX_BODY = 4096;

export async function handleScaffold(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!gateLocalhostOnly(req, res)) return;
  const body = await readJsonBody<{
    sandboxId?: string;
    framework?: string;
    project?: string;
  }>(req, res, SCAFFOLD_MAX_BODY);
  if (!body) return;
  if (!body.sandboxId) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, reason: "sandboxId required" }));
    return;
  }
  try {
    const result = await scaffoldProjectDirect(body.sandboxId, {
      framework: body.framework,
      project: body.project,
    });
    if (result.status === "success") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, output: result.output }));
    } else if (result.status === "error") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ ok: false, errorCode: result.errorCode, message: result.message }),
      );
    } else {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          errorCode: result.status,
          message: "reason" in result ? result.reason : "scaffold was not approved",
        }),
      );
    }
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
  }
}
