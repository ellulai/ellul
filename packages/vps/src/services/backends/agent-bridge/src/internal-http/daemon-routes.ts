// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.
//
// Internal HTTP routes that expose the ZeroClaw daemon pool to other
// VPS services (watchdog, file-api). Plain Node http handlers — the
// pool itself is Effect-based but we resolve it through the
// AdapterRuntime helpers (`getZeroClawDaemonHealth`,
// `forceRestartZeroClawDaemon`) so this module stays sync at its API
// boundary.
//
// ACL is enforced by the existing `gateInternalRoute` /
// `gateLocalhostOnly` guards — the pool is not exposed to user
// traffic, only to other internal services on the loopback.

import type { IncomingMessage, ServerResponse } from "http";

import {
  forceRestartZeroClawDaemon,
  getZeroClawDaemonHealth,
} from "../adapters/runtime";

import { gateInternalRoute, gateLocalhostOnly, readJsonBody } from "./acl";

export async function handleDaemonHealth(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!gateLocalhostOnly(req, res)) return;
  const daemons = await getZeroClawDaemonHealth();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ daemons }));
}

export async function handleDaemonRestart(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!gateInternalRoute(req, res, "/api/internal/daemon-restart")) return;
  const body = await readJsonBody<{ project?: string; reason?: string }>(
    req,
    res,
  );
  if (!body) return;
  if (!body.project) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Missing project" }));
    return;
  }
  try {
    await forceRestartZeroClawDaemon({
      project: body.project,
      ...(body.reason ? { reason: body.reason } : {}),
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, project: body.project }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
  }
}
