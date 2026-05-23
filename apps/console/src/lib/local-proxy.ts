// SPDX-License-Identifier: MIT
// Server-side utilities for local VPS proxy routes (Lima / BYOS).
// Runs in Node.js runtime (not Edge — middleware.ts has its own JWT impl).

import { NextRequest, NextResponse } from "next/server";
import { createHmac } from "crypto";
import { readFileSync } from "fs";
import { resolve } from "path";

// ── Env ──

let _envCache: { secret: string; serverId: string } | undefined;

export function getLocalEnv(): { secret: string | undefined; serverId: string | undefined } {
  if (_envCache) return _envCache;
  try {
    const content = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
    const s = content.match(/^LIMA_JWT_SECRET=(.+)$/m);
    const id = content.match(/^LIMA_SERVER_ID=(.+)$/m);
    if (s?.[1] && id?.[1]) {
      _envCache = { secret: s[1].trim(), serverId: id[1].trim() };
      return _envCache;
    }
  } catch {}
  return { secret: process.env.LIMA_JWT_SECRET, serverId: process.env.LIMA_SERVER_ID };
}

export function getProxyPort(): number | null {
  if (process.env.LOCAL_PROXY_PORT) return Number(process.env.LOCAL_PROXY_PORT);
  try {
    const content = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
    const m = content.match(/^LOCAL_PROXY_PORT=(.+)$/m);
    if (m?.[1]?.trim()) return Number(m[1].trim());
  } catch {}
  return null;
}

// ── JWT ──

const jwtCache: Record<string, { token: string; exp: number }> = {};

export function getLocalJwt(purpose?: string): string | null {
  const { secret, serverId } = getLocalEnv();
  if (!secret) return null;
  const key = `${serverId || ""}:${purpose || ""}`;
  const now = Math.floor(Date.now() / 1000);
  const cached = jwtCache[key];
  if (cached && cached.exp > now + 60) return cached.token;
  const payload: Record<string, unknown> = {
    sub: "local-dev", jti: `dev-${now}`, iat: now, exp: now + 86400,
  };
  if (serverId) payload.sid = serverId;
  if (purpose) payload.purpose = purpose;
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  const token = `${header}.${body}.${sig}`;
  jwtCache[key] = { token, exp: now + 86400 };
  return token;
}

// ── Port routing ──

const PORT_MAP: Record<string, number> = { api: 3002, browser: 3002 };
const SHIELD_PORT = 3005;

export function resolveUpstream(path: string): { port: number; host: string } {
  const proxyPort = getProxyPort();
  if (proxyPort) return { port: proxyPort, host: "localhost" };
  const first = path.replace(/^\//, "").split("/")[0];
  return { port: (first && PORT_MAP[first]) || SHIELD_PORT, host: "127.0.0.1" };
}

// ── Proxy ──

interface ProxyOptions {
  purpose?: string;
  stripCookiePrefix?: boolean;
}

export async function proxyToVps(
  req: NextRequest,
  upstreamPath: string,
  opts: ProxyOptions = {},
): Promise<NextResponse> {
  const { port, host } = resolveUpstream(upstreamPath);
  const qs = new URLSearchParams(req.nextUrl.searchParams);
  const extra = qs.toString();
  const url = `http://${host}:${port}${upstreamPath}${extra ? `?${extra}` : ""}`;

  const headers = new Headers();
  for (const [k, v] of req.headers.entries()) {
    if (k === "host" || k === "connection") continue;
    headers.set(k, v);
  }
  headers.delete("origin");
  headers.delete("x-forwarded-host");
  headers.delete("x-forwarded-port");
  headers.delete("x-forwarded-proto");
  headers.delete("x-forwarded-for");
  const jwt = getLocalJwt(opts.purpose);
  if (jwt) headers.set("Authorization", `Bearer ${jwt}`);

  const init: RequestInit = { method: req.method, headers, redirect: "manual" };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = req.body;
    (init as any).duplex = "half";
  }

  try {
    const upstream = await fetch(url, init);
    const respHeaders = new Headers(upstream.headers);
    respHeaders.delete("transfer-encoding");
    respHeaders.delete("content-length");
    if (opts.stripCookiePrefix) {
      const sc = upstream.headers.get("set-cookie");
      if (sc) respHeaders.set("Set-Cookie", sc.replace(/^__Host-/i, "").replace(/;\s*Secure/i, ""));
    }
    const body = await upstream.arrayBuffer();
    return new NextResponse(body, { status: upstream.status, statusText: upstream.statusText, headers: respHeaders });
  } catch {
    return NextResponse.json({ error: "Upstream unreachable" }, { status: 502 });
  }
}

// ── Config ──

export function localEllulConfig(consoleOrigin: string) {
  return {
    platformZone: "localhost",
    appZone: "localhost",
    consoleOrigin,
    wsOrigin: consoleOrigin,
    codeWsOrigin: consoleOrigin,
    codeWsPath: "/code-ws",
  };
}
