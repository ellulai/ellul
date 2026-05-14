// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { IncomingMessage, ServerResponse } from "http";

const INTERNAL_TOKEN_DIR = "/run/shield";

export const BRIDGE_ENDPOINT_ACL: Record<string, readonly string[]> = {
  "/api/internal/session-revoked": ["agent-bridge"],
  "/api/internal/gate-request": ["agent-bridge"],
  "/api/internal/gate/cross-project-scope-metrics": ["sovereign-shield", "agent-bridge"],
  "/api/internal/context-mode": ["agent-bridge"],
  "/api/internal/tool-permissions": ["agent-bridge"],
  "/api/internal/tool-permissions/reset": ["agent-bridge"],
  "/api/internal/resolve-projects": ["file-api"],
  "/api/internal/ensure-projects": ["file-api"],
  "/api/cleanup-project": ["file-api"],
  "/api/internal/daemon-restart": ["file-api"],
  "/api/internal/metadata-changed": ["file-api"],
  "/api/internal/reload-integrations": ["file-api"],
};

type ServiceTokenMap = Map<string, string>;

export function readServiceTokens(): ServiceTokenMap {
  const tokens: ServiceTokenMap = new Map();
  try {
    const files = fs.readdirSync(INTERNAL_TOKEN_DIR);
    for (const f of files) {
      const match = f.match(/^internal-(.+)\.token$/);
      if (!match) continue;
      try {
        const t = fs.readFileSync(path.join(INTERNAL_TOKEN_DIR, f), "utf8").trim();
        if (t) tokens.set(match[1]!, t);
      } catch {}
    }
  } catch {}
  return tokens;
}

export function isLocalhost(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress;
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}

export function verifyInternalTokenWithAcl(
  req: IncomingMessage,
  endpointPath: string,
): string | null {
  const authHeader = req.headers["x-internal-token"] as string | undefined;
  if (!authHeader) return null;

  const providedBuf = Buffer.from(authHeader, "utf8");
  const tokens = readServiceTokens();

  let callerService: string | null = null;
  for (const [service, token] of tokens) {
    const storedBuf = Buffer.from(token, "utf8");
    if (providedBuf.length !== storedBuf.length) continue;
    if (crypto.timingSafeEqual(providedBuf, storedBuf)) {
      callerService = service;
      break;
    }
  }

  if (!callerService) return null;

  const allowedCallers = BRIDGE_ENDPOINT_ACL[endpointPath];
  if (!allowedCallers) {
    console.warn(`[Bridge] ACL DENY: ${callerService} → ${endpointPath} (no ACL entry)`);
    return null;
  }

  if (!allowedCallers.includes(callerService)) {
    console.warn(
      `[Bridge] ACL DENY: ${callerService} → ${endpointPath} (allowed: ${allowedCallers.join(", ")})`,
    );
    return null;
  }

  return callerService;
}

export function denyNonLocalhost(res: ServerResponse): void {
  res.writeHead(403, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, reason: "Localhost only" }));
}

export function denyAclFailure(res: ServerResponse): void {
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({ ok: false, reason: "Invalid internal token or unauthorized service" }),
  );
}

export function gateInternalRoute(
  req: IncomingMessage,
  res: ServerResponse,
  endpointPath: string,
): boolean {
  if (!isLocalhost(req)) {
    denyNonLocalhost(res);
    return false;
  }
  if (!verifyInternalTokenWithAcl(req, endpointPath)) {
    denyAclFailure(res);
    return false;
  }
  return true;
}

export function gateLocalhostOnly(req: IncomingMessage, res: ServerResponse): boolean {
  if (!isLocalhost(req)) {
    denyNonLocalhost(res);
    return false;
  }
  return true;
}

export async function readJsonBody<T>(
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes = 4096,
): Promise<T | null> {
  let body = "";
  let aborted = false;
  return new Promise<T | null>((resolve) => {
    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      body += chunk.toString();
      if (body.length > maxBytes) {
        aborted = true;
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, reason: "Payload too large" }));
        req.destroy();
        resolve(null);
      }
    });
    req.on("error", () => {
      if (aborted) return;
      aborted = true;
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, reason: "Request stream error" }));
      }
      resolve(null);
    });
    req.on("end", () => {
      if (aborted) return;
      try {
        resolve(JSON.parse(body) as T);
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
        resolve(null);
      }
    });
  });
}
