// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { ELLUL_ACTIVITY_KINDS, ThreadId } from "@ellul.ai/types";
import { Effect } from "effect";
import type { IncomingMessage, ServerResponse } from "http";

import { getScopeConfusionDenialStats } from "@vps/shared/cross-project-scope";
import { callShieldInternal } from "@vps/shared/shield-client";

import type { ApplicationRuntime } from "../composition/ApplicationLayer";
import { appendActivity } from "./dispatch-activity";
import { gateInternalRoute, gateLocalhostOnly, readJsonBody } from "./acl";
import { broadcastToAllSessions } from "./session-registry";

export async function handleGateMetrics(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!gateInternalRoute(req, res, "/api/internal/gate/cross-project-scope-metrics")) return;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ service: "agent-bridge", ...getScopeConfusionDenialStats() }));
}

export async function handleGateStatus(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  if (!gateLocalhostOnly(req, res)) return;
  const threadId = url.searchParams.get("threadId");
  if (!threadId) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, reason: "Missing threadId" }));
    return;
  }
  try {
    const statusRes = await callShieldInternal(
      `/api/internal/gate/status?threadId=${encodeURIComponent(threadId)}`,
    );
    const status = await statusRes.json();
    res.writeHead(statusRes.ok ? 200 : 502, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status));
  } catch (err) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
  }
}

export async function handleSecretNames(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  if (!gateLocalhostOnly(req, res)) return;
  const sandboxId = url.searchParams.get("sandboxId") || "";
  try {
    const query = sandboxId ? `?sandboxId=${encodeURIComponent(sandboxId)}` : "";
    const namesRes = await callShieldInternal(`/api/internal/secret-names${query}`);
    const data = await namesRes.json();
    res.writeHead(namesRes.ok ? 200 : 502, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  } catch (err) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
  }
}

interface GateRequestBody {
  readonly gate?: string;
  readonly reason?: string;
  readonly threadId?: string;
  readonly sandboxId?: string;
  readonly requestedBy?: {
    readonly agentId?: string;
    readonly cliKind?: string;
    readonly toolName?: string;
    readonly argsHash?: string;
  };
  readonly scope?: Record<string, unknown>;
}

interface AutoGrantResponse {
  readonly granted?: boolean;
  readonly denied?: boolean;
  readonly ask?: boolean;
  readonly grant?: { readonly expiresAt: number };
}

interface AutoAuthorizeResponse {
  readonly token?: string;
  readonly credentialSession?: string;
  readonly expiresAt?: number;
  readonly error?: string;
}

// In-flight action gates waiting for user click (git/deploy). TTL 10 min.
export interface PendingActionGate {
  readonly threadId: string;
  readonly gate: string;
  readonly sandboxId: string;
  readonly timestamp: number;
}

const pendingActionGates = new Map<string, PendingActionGate>();

export function consumePendingActionGate(
  threadId: string,
  gate: string,
): PendingActionGate | null {
  const key = `${threadId}:${gate}`;
  const entry = pendingActionGates.get(key);
  if (!entry) return null;
  pendingActionGates.delete(key);
  return entry;
}

setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [key, entry] of pendingActionGates) {
    if (entry.timestamp < cutoff) pendingActionGates.delete(key);
  }
}, 60_000).unref?.();

const SANDBOX_ID_RE = /^sbx-[a-z0-9]{7}$/;

export function makeGateResolvedHandler(runtime: ApplicationRuntime) {
  return async function handleGateResolved(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!gateInternalRoute(req, res, "/api/internal/gate-resolved")) return;
    const body = await readJsonBody<{
      threadId?: string;
      gate?: string;
      sandboxId?: string;
      requestId?: string;
      action?: string;
      expiresAt?: number;
    }>(req, res);
    if (!body) return;
    if (!body.threadId || !body.gate || !body.action) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: "Missing threadId, gate, or action" }));
      return;
    }
    const threadId = ThreadId.make(body.threadId);
    const granted = body.action !== "deny";
    try {
      await runtime.runPromise(
        appendActivity({
          threadId,
          tone: "approval",
          kind: granted ? ELLUL_ACTIVITY_KINDS.gateGranted : ELLUL_ACTIVITY_KINDS.gateDenied,
          summary: `${body.gate} access ${granted ? "granted" : "denied"}`,
          payload: {
            gate: body.gate,
            sandboxId: body.sandboxId ?? null,
            requestId: body.requestId ?? null,
            ...(granted && body.expiresAt ? { expiresAt: body.expiresAt } : {}),
          },
        }),
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
    }
  };
}

export function makeGateRequestHandler(runtime: ApplicationRuntime) {
  return async function handleGateRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!gateInternalRoute(req, res, "/api/internal/gate-request")) return;
    const body = await readJsonBody<GateRequestBody>(req, res);
    if (!body) return;
    if (!body.gate || !body.threadId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: "Missing gate or threadId" }));
      return;
    }

    const gate = body.gate;
    const threadId = ThreadId.make(body.threadId);
    const sandboxId = body.sandboxId || null;

    if (sandboxId && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(sandboxId)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: "Invalid sandboxId format" }));
      return;
    }

    if (sandboxId) {
      try {
        const autoRes = await callShieldInternal("/api/internal/gate/auto-grant", {
          method: "POST",
          body: { gate, sandboxId, threadId: body.threadId, reason: body.reason },
          timeout: 3000,
        });
        if (!autoRes.ok) {
          throw new Error(`auto-grant HTTP ${autoRes.status}`);
        }
        const autoData = (await autoRes.json()) as AutoGrantResponse;

        if (autoData.denied) {
          await runtime.runPromise(
            appendActivity({
              threadId,
              tone: "approval",
              kind: ELLUL_ACTIVITY_KINDS.gateDenied,
              summary: `${gate} access auto-denied (permission: never)`,
              payload: { gate, sandboxId, autoDenied: true },
            }),
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              autoDenied: true,
              reason:
                "Gate blocked by user — permission set to never. Do not retry, continue without this resource.",
            }),
          );
          return;
        }

        if (autoData.granted && autoData.grant) {
          if (gate === "git" || gate === "deploy") {
            const authEndpoint =
              gate === "deploy"
                ? "/api/internal/deploy-auto-authorize"
                : "/api/internal/git-auto-authorize";
            const authRes = await callShieldInternal(authEndpoint, {
              method: "POST",
              body: { sandboxId, threadId: body.threadId },
              timeout: 3000,
            });
            const authData = (await authRes.json()) as AutoAuthorizeResponse;
            if (authData.token) {
              await runtime.runPromise(
                appendActivity({
                  threadId,
                  tone: "approval",
                  kind: ELLUL_ACTIVITY_KINDS.gateGranted,
                  summary: `${gate} access auto-granted`,
                  payload: {
                    gate,
                    sandboxId,
                    autoGranted: true,
                    expiresAt: authData.expiresAt ?? null,
                    actionToken: authData.token,
                  },
                }),
              );
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: true, autoGranted: true, token: authData.token }));
              return;
            }
          }

          await runtime.runPromise(
            appendActivity({
              threadId,
              tone: "approval",
              kind: ELLUL_ACTIVITY_KINDS.gateGranted,
              summary: `${gate} access auto-granted`,
              payload: {
                gate,
                sandboxId,
                autoGranted: true,
                expiresAt: autoData.grant.expiresAt,
              },
            }),
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, autoGranted: true }));
          return;
        }
      } catch (err) {
        console.error(
          `[Bridge] Auto-grant check failed, falling back to popup:`,
          (err as Error).message,
        );
      }
    }

    let requestId: string | null = null;
    try {
      const reqRes = await callShieldInternal("/api/internal/permissions/request", {
        method: "POST",
        body: {
          gate,
          threadId: body.threadId,
          sandboxId,
          reason: body.reason || "",
          scope: body.scope || undefined,
          requestedBy: body.requestedBy || {},
        },
        timeout: 3000,
      });
      if (reqRes.ok) {
        const reqData = (await reqRes.json()) as { id?: string };
        requestId = reqData.id || null;
      }
    } catch (permErr) {
      // permission request failed — continue to popup fallback
    }

    const activityKind =
      gate === "git" || gate === "deploy"
        ? gate === "git"
          ? ELLUL_ACTIVITY_KINDS.gitPushRequested
          : ELLUL_ACTIVITY_KINDS.deployRequested
        : ELLUL_ACTIVITY_KINDS.gateRequested;

    if (gate === "git" || gate === "deploy") {
      pendingActionGates.set(`${body.threadId}:${gate}`, {
        threadId: body.threadId,
        gate,
        sandboxId: sandboxId || "",
        timestamp: Date.now(),
      });
    }

    try {
      await runtime.runPromise(
        appendActivity({
          threadId,
          tone: "approval",
          kind: activityKind,
          summary: `${gate} access requested`,
          payload: {
            gate,
            reason: body.reason || "",
            sandboxId,
            requestId,
          },
        }),
      );
      broadcastToAllSessions({
        event: "gate_request",
        gate,
        reason: body.reason || "",
        threadId: body.threadId,
        sandboxId,
        requestId,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          gate === "git" || gate === "deploy"
            ? { ok: true, actionPending: true, requestId }
            : { ok: true, requestId },
        ),
      );
    } catch (err) {
      console.error(`[Bridge] gate-request appendActivity failed:`, (err as Error).message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
    }
  };
}
