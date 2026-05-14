// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// CF edge router. Zone config via PLATFORM_ZONE / APP_ZONE env vars.
// Active: resolveOverride → o-{ipTag}.{zone} → VPS Caddy (origin cert + AOP mTLS).
// KV schema: shortId → {"s":"active","o":"<ipTag>"} | "sleeping" (missing = 404).

export interface Env {
  SERVER_ROUTES: KVNamespace;
  PLATFORM_ZONE: string;
  APP_ZONE: string;
  CONSOLE_ORIGIN: string;
}

// Server subdomains follow the pattern: {8+ hex chars}-{suffix}.{zone}
// Anything else (api, www, etc.) is passed through to its own origin.
const SERVER_SUBDOMAIN = /^[0-9a-f]{8,}-/;

function getPlatformZone(env: Env): string {
  if (!env.PLATFORM_ZONE) throw new Error("PLATFORM_ZONE not configured");
  return env.PLATFORM_ZONE;
}

function getAppZone(env: Env): string {
  if (!env.APP_ZONE) throw new Error("APP_ZONE not configured");
  return env.APP_ZONE;
}

function getConsoleOrigin(env: Env): string {
  if (!env.CONSOLE_ORIGIN) throw new Error("CONSOLE_ORIGIN not configured");
  return env.CONSOLE_ORIGIN;
}

// Needed on 52x/503 during resize: without CORS, console JS sees opaque "Failed to fetch".
function withCors(response: Response, request: Request, env: Env): Response {
  const origin = request.headers.get("Origin");
  if (!origin) return response;

  const pz = getPlatformZone(env);
  const az = getAppZone(env);
  const consoleOrigin = getConsoleOrigin(env);
  const platformBase = `https://${pz}`;
  const platformSuffix = `.${pz}`;
  const appSuffix = `.${az}`;

  if (
    origin === consoleOrigin ||
    origin === platformBase ||
    (origin.startsWith("https://") && (origin.endsWith(platformSuffix) || origin.endsWith(appSuffix)))
  ) {
    const headers = new Headers(response.headers);
    // Only set if origin didn't already provide them (Caddy sets them when healthy)
    if (!headers.has("Access-Control-Allow-Origin")) {
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set("Access-Control-Allow-Credentials", "true");
    }
    // Always ensure preflight headers on OPTIONS responses
    if (request.method === "OPTIONS") {
      headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      headers.set(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, Cookie, X-Code-Token, X-PoP-Signature, X-PoP-Timestamp, X-PoP-Nonce"
      );
      headers.set("Access-Control-Max-Age", "86400");
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  return response;
}

function sleepingHtml(env: Env): string {
  const consoleOrigin = getConsoleOrigin(env);
  const consoleHost = consoleOrigin.replace(/^https?:\/\//, "");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Server Sleeping</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0a0a;color:#e5e5e5;display:flex;align-items:center;justify-content:center;min-height:100vh}
    .c{text-align:center;max-width:420px;padding:2rem}
    .m{font-size:3rem;margin-bottom:1.5rem}
    h1{font-size:1.5rem;font-weight:600;margin-bottom:.75rem}
    p{color:#a3a3a3;line-height:1.6;margin-bottom:1.5rem}
    a{color:#3b82f6;text-decoration:none;font-weight:500}
    a:hover{text-decoration:underline}
  </style>
</head>
<body>
  <div class="c">
    <div class="m">&#127769;</div>
    <h1>This server is sleeping</h1>
    <p>Visit <a href="${consoleOrigin}">${consoleHost}</a> to wake it up.</p>
  </div>
</body>
</html>`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const host = url.hostname;

    // Resolve shortId from hostname. Two paths:
    //   1. Default: {shortId}-{srv|code|dc|...}.ellul.(ai|app) → regex match
    //   2. Custom domain: arbitrary hostname → KV lookup `customHostname:{host}` → mapped shortId
    // If neither matches, pass through to the hostname's own origin (api, www, etc.).
    const sub = host.split(".")[0];
    let shortId: string | null = null;
    let isCustomHostname = false;

    if (SERVER_SUBDOMAIN.test(sub)) {
      shortId = sub.split("-")[0];
    } else {
      const mappingRaw = await env.SERVER_ROUTES.get(`customHostname:${host.toLowerCase()}`);
      if (mappingRaw) {
        try {
          const mapping = JSON.parse(mappingRaw) as { shortId: string };
          if (mapping.shortId) {
            shortId = mapping.shortId;
            isCustomHostname = true;
          }
        } catch {}
      }
    }

    if (!shortId) {
      // No server binding for this hostname — let the request fall through
      // to whatever origin Cloudflare has configured (api, www, etc.).
      return fetch(request);
    }

    // KV lookup — returns JSON {"s":"active","o":"<tag>"}, "sleeping", or null
    const raw = await env.SERVER_ROUTES.get(shortId);

    if (!raw) {
      return withCors(new Response("Not Found", { status: 404 }), request, env);
    }

    // Parse KV value: JSON {"s":"active","o":"<tag>"} or plain "sleeping"
    let status: string;
    let originTag: string | null = null;
    if (raw.startsWith("{")) {
      try {
        const data = JSON.parse(raw) as { s: string; o?: string };
        status = data.s;
        originTag = data.o ?? null;
      } catch {
        status = raw;
      }
    } else {
      status = raw;
    }

    if (status === "sleeping") {
      return withCors(
        new Response(sleepingHtml(env), {
          status: 503,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Retry-After": "30",
          },
        }),
        request,
        env
      );
    }

    if (status !== "active" || !originTag) {
      return withCors(
        new Response(sleepingHtml(env), {
          status: 503,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Retry-After": "30",
          },
        }),
        request,
        env
      );
    }

    const pz = getPlatformZone(env);
    const az = getAppZone(env);
    let zone: string;
    if (host.endsWith(`.${az}`)) {
      zone = az;
    } else if (host.endsWith(`.${pz}`)) {
      zone = pz;
    } else if (isCustomHostname) {
      zone = pz;
    } else {
      return withCors(new Response("Not Found", { status: 404 }), request, env);
    }
    const originHost = `o-${originTag}.${zone}`;

    // resolveOverride routes DNS to the origin hostname but also rewrites the HTTP
    // Host header, breaking Caddy's internal host matchers. Pass the original hostname
    // via X-Forwarded-Host so Caddy can route to the correct handler (@code/@main/@dev).
    const headers = new Headers(request.headers);
    headers.set("X-Forwarded-Host", host);
    // Request tracing: propagate or generate a unique request ID
    const requestId = request.headers.get("CF-Ray") || crypto.randomUUID();
    headers.set("X-Request-Id", requestId);
    const originRequest = new Request(request, { headers });

    const response = await fetch(originRequest, {
      cf: { resolveOverride: originHost },
    } as RequestInit);

    // WebSocket upgrades (101 Switching Protocols) carry an internal `webSocket`
    // handle that is destroyed by `new Response(body, init)` rebuild. Return the
    // raw response untouched; CORS + request-id propagation are irrelevant to a
    // WS upgrade anyway (headers after 101 are only from the origin's response
    // line + any server-set frames).
    if (response.status === 101 || (response as unknown as { webSocket?: unknown }).webSocket) {
      return response;
    }

    // If origin is unreachable or can't serve (421 = old config, 520-530 = CF origin errors)
    if (response.status === 421 || (response.status >= 520 && response.status <= 530)) {
      return withCors(
        new Response(sleepingHtml(env), {
          status: 503,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Retry-After": "30",
          },
        }),
        request,
        env
      );
    }

    const corsResponse = withCors(response, request, env);
    // Propagate request ID to client for end-to-end tracing
    const tracedResponse = new Response(corsResponse.body, corsResponse);
    tracedResponse.headers.set("X-Request-Id", requestId);
    return tracedResponse;
  },
};
