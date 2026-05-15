// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Caddy route handlers (CORS, auth gates, proxies). Shared by provisioning + runtime CLI.
// Placeholders MAIN_DOMAIN / CODE_DOMAIN_PLACEHOLDER / DEV_DOMAIN_PLACEHOLDER replaced by caller.

import { PREVIEW_PORT_MIN } from '@vps/shared/constants';
import { PORT_REGISTRY } from '@vps/shared/ports';
import { FRAMEWORK_DEV_PATHS } from '@vps/shared/framework';

// ── Constants ──

const SHIELD_PORT = PORT_REGISTRY.SOVEREIGN_SHIELD.port;
const TERM_PROXY_PORT = PORT_REGISTRY.TERM_PROXY.port;
const FILE_API_PORT = PORT_REGISTRY.FILE_API.port;
const AGENT_BRIDGE_PORT = PORT_REGISTRY.AGENT_BRIDGE.port;
// 127.0.0.1 literal — `localhost` resolves IPv6-first via Go, internal services IPv4-only → 502.
const UPSTREAM_HOST = "127.0.0.1";

interface CorsConfig {
  methods: string;
  headers: string;
}

const SHIELD_CORS: CorsConfig = {
  methods: "GET, POST, PUT, DELETE, OPTIONS",
  headers: "Content-Type, Authorization, Cookie, X-Code-Token, X-PoP-Signature, X-PoP-Timestamp, X-PoP-Nonce, X-STS-Token",
};

const CODE_CORS: CorsConfig = {
  methods: "GET, POST, PUT, DELETE, OPTIONS",
  headers: "Content-Type, Authorization, Cookie, X-Code-Token",
};

const STRIP_CORS_DOWNSTREAM = [
  "Access-Control-Allow-Origin",
  "Access-Control-Allow-Methods",
  "Access-Control-Allow-Headers",
  "Access-Control-Allow-Credentials",
  "Access-Control-Max-Age",
  "Access-Control-Expose-Headers",
];

// Direct-to-shield (no forward_auth): login mechanism + public endpoints. Others go through forward_auth.
const SHIELD_DIRECT_PATHS = [
  "/_auth/login*",
  "/_auth/register*",
  "/_auth/recovery*",
  "/_auth/standard-upgrade*",
  "/_auth/bridge",            // exact: bootstrap iframe HTML
  "/_auth/bridge/tier",       // exact: tier discovery
  "/_auth/bridge/session",    // exact: session check
  "/_auth/code/redirect",     // exact: code session redirect
  "/_auth/code/session",      // exact: code session create (JWT auth, cross-origin)
  "/_auth/terminal/authorize",// exact: terminal token (session auth, cross-origin)
  "/_auth/agent/authorize",   // exact: agent token (session auth, cross-origin)
  "/_auth/code/authorize",    // exact: code token (session auth, cross-origin)
  "/_auth/pop/*",             // PoP setup endpoints (cross-origin)
  "/_auth/static/*",          // PUBLIC: static assets
  "/_auth/capabilities",      // PUBLIC: capability discovery
  // Server-to-server (no cookies). Token auth: HMAC+nonce+TTL (verify-confirmation), 256-bit random (git).
  "/_auth/verify-confirmation",
  "/_auth/git/verify-link-token",
  "/_auth/git/verify-unlink-token",
  // Wake-enforcer: server-to-server SIGUSR1 push from API (Cloud Run).
  // Auth: server ID in body (UUID, unguessable). SIGUSR1 is harmless.
  "/_auth/wake-enforcer",
];

// Routes behind forward_auth gate to sovereign-shield
interface AuthedRoute {
  path: string;
  backend: number;
  cors?: { methods: string; headers: string };
  /** Enable streaming mode (flush_interval -1) for WebSocket/SSE backends */
  streaming?: boolean;
  /** Use handle_path (strip prefix) instead of handle. */
  stripPrefix?: boolean;
}

// Build route list based on which services are provisioned.
// On governance tier, agent-bridge/term-proxy don't exist — their routes are omitted.
// Evaluated lazily (not at import time) because caddy-gen is bundled at provisioning
// but also runs as a CLI on the VPS. The fs check only makes sense on the VPS.
import { existsSync } from 'fs';

function getAuthedRoutes(): AuthedRoute[] {
  // Only filter routes on VPS (where /etc/ellul exists). During provisioning
  // bundle or dev, include all routes — the Caddyfile gets regenerated on the VPS.
  const isVps = existsSync('/etc/ellul-bootstrap/server-id');
  const hasTermProxy = !isVps || existsSync('/etc/systemd/system/ellul-term-proxy.service');
  const hasAgentBridge = !isVps || existsSync('/etc/systemd/system/ellul-agent-bridge.service');
  const hasFileApi = !isVps || existsSync('/etc/systemd/system/ellul-file-api.service');

  return [
    ...(hasTermProxy ? [
      { path: "/terminal/sessions", backend: TERM_PROXY_PORT, cors: { methods: "GET, OPTIONS", headers: "Content-Type" } },
      { path: "/terminal/session/*", backend: TERM_PROXY_PORT },
      { path: "/term/*", backend: TERM_PROXY_PORT },
      { path: "/ttyd/*", backend: TERM_PROXY_PORT },
    ] as AuthedRoute[] : []),
    ...(hasAgentBridge ? [
      { path: "/ws", backend: AGENT_BRIDGE_PORT, streaming: true },
    ] as AuthedRoute[] : []),
    // Same-origin read-path for chat SPA: CF %2F normalization breaks PoP on -code paths.
    // forward_auth + resolveProjectDir enforce safety.
    ...(hasFileApi ? [
      { path: "/api/app-integrations", backend: FILE_API_PORT },
    ] as AuthedRoute[] : []),
  ];
}

// ── Line builder helpers ──

type Lines = string[];

function indent(lines: Lines, depth: number): Lines {
  const pad = "    ".repeat(depth);
  return lines.map(l => (l === "" ? "" : pad + l));
}

function corsHeaders(cors: CorsConfig, depth: number, consoleOrigin: string): Lines {
  return indent([
    `header Access-Control-Allow-Origin "${consoleOrigin}"`,
    `header Access-Control-Allow-Methods "${cors.methods}"`,
    `header Access-Control-Allow-Headers "${cors.headers}"`,
    `header Access-Control-Allow-Credentials "true"`,
  ], depth);
}

function corsPreflightBlock(matcherName: string, cors: CorsConfig, depth: number, consoleOrigin: string): Lines {
  return [
    ...indent([`@${matcherName} method OPTIONS`], depth),
    ...indent([`handle @${matcherName} {`], depth),
    ...corsHeaders(cors, depth + 1, consoleOrigin),
    ...indent([`respond "" 204`], depth + 1),
    ...indent([`}`], depth),
  ];
}

function forwardAuthBlock(depth: number, extraHeaders?: string[]): Lines {
  return indent([
    `forward_auth ${UPSTREAM_HOST}:${SHIELD_PORT} {`,
    `    uri /api/auth/session`,
    `    header_up Cookie {http.request.header.Cookie}`,
    `    header_up Accept {http.request.header.Accept}`,
    `    header_up X-PoP-Signature {http.request.header.X-PoP-Signature}`,
    `    header_up X-PoP-Timestamp {http.request.header.X-PoP-Timestamp}`,
    `    header_up X-PoP-Nonce {http.request.header.X-PoP-Nonce}`,
    // Body-hash is part of the signed PoP payload. Forward it so shield can
    // reconstruct the payload without reading the original body (which the
    // forward_auth sub-request does not carry).
    `    header_up X-PoP-BodyHash {http.request.header.X-PoP-BodyHash}`,
    // Original request method — forward_auth sub-request is always GET,
    // but the signed PoP payload includes the original method.
    `    header_up X-Forwarded-Method {method}`,
    `    header_up User-Agent {http.request.header.User-Agent}`,
    `    header_up Sec-Ch-Ua {http.request.header.Sec-Ch-Ua}`,
    `    header_up Sec-Ch-Ua-Mobile {http.request.header.Sec-Ch-Ua-Mobile}`,
    `    header_up Sec-Ch-Ua-Platform {http.request.header.Sec-Ch-Ua-Platform}`,
    `    header_up Sec-Fetch-Dest {http.request.header.Sec-Fetch-Dest}`,
    `    header_up Sec-Fetch-Mode {http.request.header.Sec-Fetch-Mode}`,
    `    header_up Sec-Fetch-Site {http.request.header.Sec-Fetch-Site}`,
    ...(extraHeaders ?? []).map(h => `    header_up ${h}`),
    `    header_up X-Forwarded-Uri {uri}`,
    `    header_up X-Forwarded-Host {host}`,
    `    header_up -X-Auth-User`,
    `    header_up -X-Auth-Tier`,
    `    header_up -X-Auth-Session`,
    `    copy_headers X-Auth-User X-Auth-Tier X-Auth-Session X-Auth-Timestamp X-Auth-HMAC`,
    `}`,
  ], depth);
}

function stripCorsDownstream(depth: number): Lines {
  return indent(STRIP_CORS_DOWNSTREAM.map(h => `header_down -${h}`), depth);
}

// ── Route builders ──

function shieldAuthRoute(path: string, consoleOrigin: string): Lines {
  return [
    `        handle ${path} {`,
    ...corsPreflightBlock("options", SHIELD_CORS, 3, consoleOrigin),
    "",
    ...corsHeaders(SHIELD_CORS, 3, consoleOrigin),
    ...indent([`reverse_proxy ${UPSTREAM_HOST}:${SHIELD_PORT} {`], 3),
    ...stripCorsDownstream(4),
    ...indent([`}`], 3),
    `        }`,
  ];
}

// forward_auth validates session at perimeter; PoP verified by tier-gate middleware.
function shieldGatedRoute(path: string, consoleOrigin: string): Lines {
  // OPTIONS preflight must be handled BEFORE forward_auth.
  // Caddy's directive ordering runs forward_auth before handle blocks,
  // so we must wrap forward_auth in handle @notOptions to prevent
  // OPTIONS requests from hitting the auth check (they have no cookies).
  return [
    `        handle ${path} {`,
    ...corsPreflightBlock("options", SHIELD_CORS, 3, consoleOrigin),
    "",
    ...indent([`@notOptions not method OPTIONS`], 3),
    ...indent([`handle @notOptions {`], 3),
    ...corsHeaders(SHIELD_CORS, 4, consoleOrigin),
    ...forwardAuthBlock(4),
    ...indent([`reverse_proxy ${UPSTREAM_HOST}:${SHIELD_PORT} {`], 4),
    ...indent([`flush_interval -1`], 5),
    ...stripCorsDownstream(5),
    ...indent([`}`], 4),
    ...indent([`}`], 3),
    `        }`,
  ];
}

// OPTIONS preflight must precede forward_auth (Caddy directive ordering).
function authedRoute(route: AuthedRoute, consoleOrigin: string): Lines {
  const directive = route.stripPrefix ? "handle_path" : "handle";
  const lines: Lines = [`        ${directive} ${route.path} {`];

  // reverse_proxy block — with optional streaming (flush_interval -1 disables
  // response buffering, required for WebSocket terminals and SSE streams)
  const proxyBlock = route.streaming
    ? [
        `reverse_proxy ${UPSTREAM_HOST}:${route.backend} {`,
        `    flush_interval -1`,
        `}`,
      ]
    : [`reverse_proxy ${UPSTREAM_HOST}:${route.backend}`];

  if (route.cors) {
    lines.push(...corsPreflightBlock("cors", route.cors, 3, consoleOrigin));
    lines.push("");
    lines.push(...indent([`@notOptions not method OPTIONS`], 3));
    lines.push(...indent([`handle @notOptions {`], 3));
    lines.push(...forwardAuthBlock(4));
    lines.push(
      ...indent([`header Access-Control-Allow-Origin "${consoleOrigin}"`], 4),
      ...indent([`header Access-Control-Allow-Credentials "true"`], 4),
    );
    lines.push(...indent(proxyBlock, 4));
    lines.push(...indent([`}`], 3));
  } else {
    lines.push(...forwardAuthBlock(3));
    lines.push(...indent(proxyBlock, 3));
  }

  lines.push(`        }`);
  return lines;
}

// ── Public API ──

export interface HandlerOptions {
  consoleOrigin: string;
  extraFrameAncestors?: string[];
  forceXForwardedHostRewrite?: boolean;
}

/** Build the `frame-ancestors` value: always 'self' + console + extras (dedup). */
function frameAncestorsDirective(consoleOrigin: string, extra?: string[]): string {
  const ancestors = new Set<string>(["'self'", consoleOrigin]);
  for (const a of extra ?? []) if (a) ancestors.add(a);
  return `frame-ancestors ${Array.from(ancestors).join(" ")}`;
}

// scope: "ai" (code+main), "app" (dev only), "all" (direct/LE).
export function generateCaddyHandlers(scope: "ai" | "app" | "all", opts: HandlerOptions): string {
  const { consoleOrigin, extraFrameAncestors } = opts;
  const CONSOLE_ORIGIN = consoleOrigin;
  const lines: Lines = [];

  // Base CORS safety net — applies to ALL responses in this site block.
  // Uses "?" (conditional set) so it only adds headers when not already present:
  //   - 502/503 from downed backends → Caddy adds console origin → console can read error
  //   - User's deployed app sets its own CORS → already present → Caddy skips → app CORS preserved
  //   - Internal handlers set explicit CORS → already present → Caddy skips → no duplicates
  // Without this, bare error responses (502, 404) lack CORS and browsers block them.
  lines.push(...indent([
    `# Base CORS for dashboard — ensure allow-origin on all responses`,
    `header ?Access-Control-Allow-Origin "${CONSOLE_ORIGIN}"`,
    `header ?Access-Control-Allow-Credentials "true"`,
  ], 1));

  // Gateway Worker uses resolveOverride which changes the TLS SNI (and Host header)
  // to the origin hostname (o-{ipTag}.{zone}). Caddy's strict SNI-Host enforcement
  // (auto-enabled by mTLS) accepts the connection because the origin hostname is in
  // the site block addresses, but the internal @code/@main/@dev host matchers won't
  // match the rewritten Host. Restore the original hostname from X-Forwarded-Host
  // (set by the Worker) so the existing host matchers work unchanged.
  if (scope !== "all" || opts.forceXForwardedHostRewrite) {
    lines.push(...indent([
      `@has_xfh header X-Forwarded-Host *`,
      `request_header @has_xfh Host {http.request.header.X-Forwarded-Host}`,
    ], 1));
  }

  if (scope === "ai" || scope === "all") {
    lines.push(...codeHandler(consoleOrigin, extraFrameAncestors));
    lines.push(...mainHandler(consoleOrigin, extraFrameAncestors));
  }

  if (scope === "app" || scope === "all") {
    // Per-app routes (host-matched handlers written by ellul-expose)
    // Also imports dev.caddy which is dynamically written by preview.service.ts
    lines.push(...indent([`import /etc/caddy/app-routes.d/*.caddy`], 1));
  }

  lines.push(...indent([
    `log {`,
    `    output file /var/log/caddy/access.log`,
    `    format json`,
    `}`,
  ], 1));

  return lines.join("\n");
}

function codeHandler(consoleOrigin: string, extraFrameAncestors?: string[]): Lines {
  const csp = frameAncestorsDirective(consoleOrigin, extraFrameAncestors);
  return [
    "",
    `    @code host CODE_DOMAIN_PLACEHOLDER`,
    `    handle @code {`,
    ...indent([`header Content-Security-Policy "${csp}"`], 2),
    "",
    `        # Shield auth endpoints on code domain (e.g. /_auth/code/establish sets __Host- cookie)`,
    ...indent([`handle /_auth/* {`], 2),
    ...corsPreflightBlock("authOptions", SHIELD_CORS, 3, consoleOrigin),
    "",
    ...corsHeaders(SHIELD_CORS, 3, consoleOrigin),
    ...indent([`reverse_proxy ${UPSTREAM_HOST}:${SHIELD_PORT} {`], 3),
    ...indent([`flush_interval -1`], 4),
    ...stripCorsDownstream(4),
    ...indent([`}`], 3),
    ...indent([`}`], 2),
    "",
    `        # Handle OPTIONS preflight BEFORE auth (no cookies on preflight)`,
    ...corsPreflightBlock("options", CODE_CORS, 2, consoleOrigin),
    "",
    `        # Non-OPTIONS requests go through auth gate`,
    ...indent([`@notOptions not method OPTIONS`], 2),
    ...indent([`handle @notOptions {`], 2),
    `            # CORS headers on ALL responses (including 502 when backends aren't ready)`,
    ...corsHeaders(CODE_CORS, 3, consoleOrigin),
    "",
    `            # Auth gate - sovereign-shield checks session/tier before allowing access`,
    ...forwardAuthBlock(3, [
      `X-Requested-With {http.request.header.X-Requested-With}`,
      `X-Code-Token {http.request.header.X-Code-Token}`,
    ]),
    "",
    ...indent([`reverse_proxy ${UPSTREAM_HOST}:${FILE_API_PORT}`], 3),
    ...indent([`}`], 2),
    `    }`,
  ];
}

// /etc/caddy/app-routes.d/dev.caddy — rewritten at runtime by preview.service.ts.
export function generateInitialDevRoute(
  devDomain: string,
  consoleOrigin: string,
  extraFrameAncestors?: string[],
): string {
  const port = PREVIEW_PORT_MIN; // Default first preview port
  const csp = frameAncestorsDirective(consoleOrigin, extraFrameAncestors);
  // `request_header @framework Origin "..."` rewrites the Origin header on
  // framework-reserved dev-resource paths ONLY. User app routes (their own
  // /api/*, page routes) keep the original Origin so their CSRF protections
  // remain intact. See FRAMEWORK_DEV_PATHS for the canonical path list.
  //
  // IMPORTANT: use top-level `request_header` with the named matcher — NOT
  // `header_up @framework` inside reverse_proxy. Caddy silently ignores
  // matchers inside reverse_proxy's header_up directives, which would
  // collapse the scope and rewrite Origin on EVERY upstream request
  // (including user-app routes). The integration test catches regressions.
  return `@dev host ${devDomain}
handle @dev {
    @notAuth not path /_auth/*
    header @notAuth Content-Security-Policy "${csp}"

    route {
        forward_auth ${UPSTREAM_HOST}:${SHIELD_PORT} {
            uri /api/auth/session
            header_up Cookie {http.request.header.Cookie}
            header_up Accept {http.request.header.Accept}
            header_up X-PoP-Signature {http.request.header.X-PoP-Signature}
            header_up X-PoP-Timestamp {http.request.header.X-PoP-Timestamp}
            header_up X-PoP-Nonce {http.request.header.X-PoP-Nonce}
            header_up X-PoP-BodyHash {http.request.header.X-PoP-BodyHash}
            header_up X-Forwarded-Method {method}
            header_up User-Agent {http.request.header.User-Agent}
            header_up Sec-Ch-Ua {http.request.header.Sec-Ch-Ua}
            header_up Sec-Ch-Ua-Mobile {http.request.header.Sec-Ch-Ua-Mobile}
            header_up Sec-Ch-Ua-Platform {http.request.header.Sec-Ch-Ua-Platform}
            header_up Sec-Fetch-Dest {http.request.header.Sec-Fetch-Dest}
            header_up Sec-Fetch-Mode {http.request.header.Sec-Fetch-Mode}
            header_up Sec-Fetch-Site {http.request.header.Sec-Fetch-Site}
            header_up X-Forwarded-Uri {uri}
            header_up X-Forwarded-Host {host}
            header_up -X-Auth-User
            header_up -X-Auth-Tier
            header_up -X-Auth-Session
            copy_headers X-Auth-User X-Auth-Tier X-Auth-Session X-Auth-Timestamp X-Auth-HMAC
        }
        uri query -_shield_session
        uri query -_preview_token
        @framework path ${FRAMEWORK_DEV_PATHS.join(" ")}
        # Next.js/Vite/etc. allowedDevOrigins accepts "localhost" but REJECTS
        # "127.0.0.1" — so rewrite to the hostname the framework trusts.
        request_header @framework Origin "http://localhost:${port}"
        reverse_proxy ${UPSTREAM_HOST}:${port} {
            header_up X-Real-IP {remote_host}
            flush_interval -1
            # Same warmup semantics as the runtime preview.service
            # caddy generator: mark upstream unhealthy on connect
            # failure so handle_errors fires the "Starting your
            # preview…" page instead of a raw 502 / timeout. Prevents
            # the full-screen-click-mid-compile UX bug the file-api
            # runtime generator already addresses. Kept identical in
            # both places so users see the same page whether their
            # dev server was started from provisioning or from
            # file-api's normal flow.
            fail_duration 10s
            max_fails 2
        }
    }
}
# handle_errors is a site-level directive — Caddy rejects it inside
# handle/route/handle_path ("not an ordered HTTP handler"), and its first
# positional argument is a status-code list, not a matcher. So we live at
# the site level and scope the warming response via the @warming expression
# (host + status), letting other matchers sharing *.ellul.app fall through
# to Caddy's default error handling.
handle_errors {
    @warming expression \`{http.request.host} == "${devDomain}" && ({err.status_code} >= 502 || {err.status_code} == 500)\`
    respond @warming 200 {
        body \`<!doctype html><html lang=en><head><meta charset=utf-8><title>Starting your preview…</title><meta http-equiv=refresh content=2><style>html,body{height:100%;margin:0;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#666;background:#fafafa}.box{text-align:center}.spin{display:inline-block;width:24px;height:24px;border:3px solid #ddd;border-top-color:#666;border-radius:50%;animation:s 0.7s linear infinite}@keyframes s{to{transform:rotate(360deg)}}</style></head><body><div class=box><div class=spin></div><p>Starting your preview…<br><small>First compile can take up to 90s. This page refreshes automatically.</small></p></div></body></html>\`
        close
    }
}
`;
}

function mainHandler(consoleOrigin: string, extraFrameAncestors?: string[]): Lines {
  const csp = frameAncestorsDirective(consoleOrigin, extraFrameAncestors);
  const lines: Lines = [
    "",
    `    @main host MAIN_DOMAIN`,
    `    handle @main {`,
    ...indent([`@notAuth not path /_auth/*`], 2),
    ...indent([`header @notAuth Content-Security-Policy "${csp}"`], 2),
    "",
    `        # Sovereign Shield auth flow endpoints — direct, no forward_auth`,
    `        # (these ARE the auth mechanism — requiring auth would be circular)`,
  ];

  for (const path of SHIELD_DIRECT_PATHS) {
    lines.push(...shieldAuthRoute(path, consoleOrigin));
    lines.push("");
  }

  // All remaining /_auth/* paths go through forward_auth for 3-layer defense:
  //   Layer 1 (Caddy forward_auth): Session validation at network perimeter
  //   Layer 2 (tier-gate middleware): Session + PoP verification at app boundary
  //   Layer 3 (route handler): Business logic
  lines.push("");
  lines.push(`        # Sovereign Shield session endpoints — forward_auth gated`);
  lines.push(...shieldGatedRoute("/_auth/*", consoleOrigin));
  lines.push("");


  for (const route of getAuthedRoutes()) {
    lines.push(...authedRoute(route, consoleOrigin));
  }

  // Per-agent ZeroClaw gateway routes (dynamically written by agent wrapper)
  lines.push(...indent([`import /etc/caddy/agents.d/*.caddy`], 2));
  lines.push("");

  // Catch-all: auth gate + static landing page.
  // web_locked: sovereign-shield redirects to passkey login
  // standard: sovereign-shield allows navigation through (landing page is public)
  lines.push(
    ...indent([`handle {`], 2),
    ...forwardAuthBlock(3),
    ...indent([`root * /var/www/ellul`], 3),
    ...indent([`rewrite * /index.html`], 3),
    ...indent([`file_server`], 3),
    ...indent([`}`], 2),
    `    }`,
  );

  return lines;
}
