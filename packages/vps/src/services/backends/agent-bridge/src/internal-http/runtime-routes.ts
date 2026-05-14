// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import type { IncomingMessage, ServerResponse } from "http";
import type { RuntimeServices } from "../composition/runtime-control/RuntimeControlLayer";

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

export function makeRuntimeRoutes(svc: RuntimeServices): Array<{ method: "GET" | "POST"; path: string; handler: Handler }> {
  return [
    {
      method: "GET",
      path: "/api/internal/health",
      handler: async (_req, res) => json(res, 200, svc.health.snapshot()),
    },
    {
      method: "GET",
      path: "/api/internal/queue/snapshot",
      handler: async (_req, res) => json(res, 200, svc.queue.snapshot()),
    },
    {
      method: "GET",
      path: "/api/internal/pro-slot/snapshot",
      handler: async (_req, res) => json(res, 200, svc.proSlots.snapshot()),
    },
    {
      method: "POST",
      path: "/api/internal/pro-slot/bind",
      handler: async (req, res) => {
        const body = await readJson(req);
        const threadId = typeof body?.threadId === "string" ? body.threadId : null;
        if (!threadId) return json(res, 400, { ok: false, reason: "threadId required" });
        const r = await svc.proSlots.bind(threadId);
        json(res, r.ok ? 200 : 409, r);
      },
    },
    {
      method: "POST",
      path: "/api/internal/bridge/drain",
      handler: async (_req, res) => {
        const r = await svc.drain.drain("api_drain");
        json(res, 200, r);
      },
    },
    {
      method: "GET",
      path: "/api/internal/runtime/budget",
      handler: async (_req, res) => json(res, 200, svc.budget),
    },
  ];
}

async function readJson(req: IncomingMessage): Promise<{ [k: string]: unknown } | null> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return null;
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { return null; }
}
