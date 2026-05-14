// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { ELLUL_ACTIVITY_KINDS, type OrchestrationThreadActivityTone } from "@ellul.ai/types";
import { Effect, Option } from "effect";
import { execFile } from "child_process";
import { promisify } from "util";
import type { IncomingMessage, ServerResponse } from "http";

import type { ApplicationRuntime } from "../composition/ApplicationLayer";
import { appendActivity, startContinuationTurn } from "./dispatch-activity";
import { gateLocalhostOnly, readJsonBody } from "./acl";
import { consumePendingActionGate } from "./gate-routes";
import { resolveFirstThreadIdForProject } from "./thread-resolver";

const execFileAsync = promisify(execFile);
const MAX_BODY = 4096;

// UX copy: continuation prompts injected as follow-up turns after the user
// approves a deploy / git-push from the dashboard. Keeping them here (not in
// @ellul.ai/types) so the product can tweak voice without a types migration.
const DEPLOY_CONTINUATION = (success: boolean, detail: string): string =>
  success
    ? `The user deployed the application from the dashboard. Deployment result: ${detail.slice(0, 500) || "Success"}. Continue with your original task.`
    : `The user attempted to deploy but it failed: ${detail.slice(0, 500) || "Unknown error"}. Address the issue or continue your task.`;

const GIT_PUSH_CONTINUATION = (success: boolean, detail: string): string =>
  success
    ? `The user pushed code from the dashboard. Result: ${detail.slice(0, 500)}. Continue with your original task.`
    : `${detail.slice(0, 500)}. Address the issue or continue your task.`;

const isValidProjectPath = (project: string): boolean =>
  /^[a-z0-9][a-z0-9._/-]{0,128}$/.test(project) &&
  !project.includes("/.shared/") &&
  !project.startsWith(".shared/");

const isValidSandboxId = (sandboxId: string): boolean =>
  /^[a-z0-9][a-z0-9._-]{0,63}$/.test(sandboxId);

export function makeDeployAuthorizedHandler(runtime: ApplicationRuntime) {
  return async function handleDeployAuthorized(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!gateLocalhostOnly(req, res)) return;
    const body = await readJsonBody<{
      project?: string;
      token?: string;
      sandboxId?: string;
      port?: number;
    }>(req, res, MAX_BODY);
    if (!body) return;
    if (!body.project || !body.token) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: "Missing project or token" }));
      return;
    }
    if (!isValidProjectPath(body.project)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: "Invalid project path" }));
      return;
    }
    if (body.sandboxId && !isValidSandboxId(body.sandboxId)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: "Invalid sandboxId format" }));
      return;
    }

    const project = body.project;
    const topLevelProject = project.includes("/") ? project.split("/")[0]! : project;
    const packageName = body.sandboxId || project.split("/").pop() || project;
    const nameArg = project.includes("/")
      ? `${topLevelProject}-${packageName}`.toLowerCase().replace(/[^a-z0-9-]/g, "")
      : packageName;
    const portArg = body.port || 3001;
    const deployToken = body.token;

    const threadIdOpt = await runtime.runPromise(
      resolveFirstThreadIdForProject(topLevelProject),
    );
    if (Option.isNone(threadIdOpt)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: "No active thread for project" }));
      return;
    }
    const threadId = threadIdOpt.value;

    await runtime.runPromise(
      appendActivity({
        threadId,
        tone: "info",
        kind: ELLUL_ACTIVITY_KINDS.deployProgress,
        summary: `Deploying ${nameArg}...`,
        payload: { project, nameArg, port: portArg },
      }),
    );

    void (async () => {
      let success = false;
      let detail = "";
      let resultTone: OrchestrationThreadActivityTone = "info";
      try {
        const result = await execFileAsync("ellul-expose", [nameArg, String(portArg)], {
          cwd: `/home/dev/projects/${project}`,
          timeout: 900_000,
          env: { ...process.env, DEPLOY_TOKEN: deployToken },
        });
        detail = ((result.stdout || "").trim().replace(/\n*IMPORTANT:.*$/s, "").trim()) ||
          `Deployed ${nameArg} successfully.`;
        success = true;
      } catch (err) {
        const stdout = ((err as { stdout?: unknown }).stdout || "").toString().trim();
        const stderr = ((err as { stderr?: unknown }).stderr || "").toString().trim();
        detail = stderr || stdout || (err as Error).message;
        resultTone = "error";
      }

      const activityKind = success
        ? ELLUL_ACTIVITY_KINDS.deployResult
        : ELLUL_ACTIVITY_KINDS.deployResult;

      await runtime
        .runPromise(
          Effect.gen(function* () {
            yield* appendActivity({
              threadId,
              tone: resultTone,
              kind: activityKind,
              summary: success
                ? `Deployment succeeded: ${nameArg}`
                : `Deployment failed: ${detail.slice(0, 140)}`,
              payload: { project, nameArg, success, detail },
            });
            if (consumePendingActionGate(threadId, "deploy")) {
              yield* startContinuationTurn({
                threadId,
                text: DEPLOY_CONTINUATION(success, detail),
              });
            }
          }),
        )
        .catch((err) => {
          console.error(
            `[Bridge] Deploy result dispatch failed:`,
            (err as Error).message,
          );
        });
    })();

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, threadId }));
  };
}

export function makeGitPushAuthorizedHandler(runtime: ApplicationRuntime) {
  return async function handleGitPushAuthorized(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!gateLocalhostOnly(req, res)) return;
    const body = await readJsonBody<{ project?: string; token?: string }>(req, res, MAX_BODY);
    if (!body) return;
    if (!body.project || !body.token) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: "Missing project or token" }));
      return;
    }
    if (!isValidProjectPath(body.project)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: "Invalid project path" }));
      return;
    }
    const project = body.project;
    const pushToken = body.token;

    const threadIdOpt = await runtime.runPromise(resolveFirstThreadIdForProject(project));
    if (Option.isNone(threadIdOpt)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: "No active thread for project" }));
      return;
    }
    const threadId = threadIdOpt.value;

    await runtime.runPromise(
      appendActivity({
        threadId,
        tone: "info",
        kind: ELLUL_ACTIVITY_KINDS.gitPushProgress,
        summary: "Pushing to remote...",
        payload: { project },
      }),
    );

    void (async () => {
      let success = false;
      let detail = "";
      let resultTone: OrchestrationThreadActivityTone = "info";
      try {
        const result = await execFileAsync("ellul-git-flow", ["backup"], {
          cwd: `/home/dev/projects/${project}`,
          timeout: 60_000,
          env: {
            ...process.env,
            GIT_PUSH_TOKEN: pushToken,
            ELLUL_GIT_PROJECT: project,
          },
        });
        detail = (result.stdout || "").trim() || "Pushed to remote successfully.";
        success = true;
      } catch (err) {
        const stderr = ((err as { stderr?: unknown }).stderr || "").toString().trim();
        detail = stderr || (err as Error).message;
        resultTone = "error";
      }

      await runtime
        .runPromise(
          Effect.gen(function* () {
            yield* appendActivity({
              threadId,
              tone: resultTone,
              kind: ELLUL_ACTIVITY_KINDS.gitPushResult,
              summary: success
                ? "Git push succeeded"
                : `Git push failed: ${detail.slice(0, 140)}`,
              payload: { project, success, detail },
            });
            if (consumePendingActionGate(threadId, "git")) {
              yield* startContinuationTurn({
                threadId,
                text: GIT_PUSH_CONTINUATION(success, detail),
              });
            }
          }),
        )
        .catch((err) => {
          console.error(
            `[Bridge] Git push result dispatch failed:`,
            (err as Error).message,
          );
        });
    })();

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, threadId }));
  };
}
