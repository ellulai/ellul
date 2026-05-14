# Cloudflare Worker

Source: `packages/gateway/src/index.ts`.

The Worker is the routing brain. It looks up the destination from KV, builds the origin host, forwards via `resolveOverride`, and handles errors/CORS.

## Endpoints

The Worker handles every request to `*.ellul.ai`, `*.ellul.app`, and configured custom domains.

## Route matching

```typescript
const SERVER_SUBDOMAIN = /^([0-9a-f]{8,})-(srv|code|dc|...)\.ellul\.(ai|app)$/;

async function fetch(request: Request, env: Env): Promise<Response> {
  const host = new URL(request.url).hostname;
  
  // Path 1: regex match for default subdomain pattern
  const match = host.match(SERVER_SUBDOMAIN);
  let shortId = match?.[1];
  
  // Path 2: custom domain → KV lookup
  if (!shortId) {
    const customRaw = await env.SERVER_ROUTES.get(`customHostname:${host}`);
    if (customRaw) {
      shortId = JSON.parse(customRaw).shortId;
    }
  }
  
  // No match: pass through (unhandled hostname)
  if (!shortId) {
    return fetch(request);  // standard CF routing
  }
  
  // Continue with shortId...
}
```

## KV lookup

```typescript
const raw = await env.SERVER_ROUTES.get(shortId);

if (!raw) {
  return new Response(notFoundPage, { status: 404 });
}

let entry;
try {
  entry = JSON.parse(raw);  // {s, o, ...}
} catch {
  // Plain string for legacy: "sleeping"
  entry = { s: raw };
}

if (entry.s === 'sleeping') {
  return new Response(sleepingPage, { status: 503 });
}

if (entry.s !== 'active') {
  return new Response(notFoundPage, { status: 404 });
}

const ipTag = entry.o;  // "c0a80001"
```

## Zone selection

```typescript
let zone: string;
if (host.endsWith('.ellul.app')) {
  zone = 'ellul.app';  // app-zone (preview, deployed apps)
} else if (host.endsWith('.ellul.ai')) {
  zone = 'ellul.ai';   // ai-zone (main experience)
} else {
  // Custom domain → always ai-zone
  zone = 'ellul.ai';
}
```

Custom domains always go to ai-zone — preview/deployed app content stays on `.app`.

## Origin host construction

```typescript
const originHost = `o-${ipTag}.${zone}`;
// e.g., "o-c0a80001.ellul.ai"
```

## Forwarding

```typescript
const headers = new Headers(request.headers);
headers.set('X-Forwarded-Host', host);  // preserve original
headers.set('X-Request-Id', requestId);

const originRequest = new Request(request, { headers });

const response = await fetch(originRequest, {
  cf: { resolveOverride: originHost }
} as RequestInit);
```

The `cf: { resolveOverride: ... }` option tells Cloudflare to:

1. Re-resolve DNS for `originHost` (yielding the VPS IPv4).
2. Rewrite SNI in the TLS handshake to `originHost`.
3. Rewrite Host header to `originHost`.

So when the Worker fetches, the actual origin connection goes to the VPS IP, with SNI as the origin tag.

## CORS

```typescript
const origin = request.headers.get('Origin');
const consoleOrigin = 'https://console.ellul.ai';

if (
  origin === consoleOrigin ||
  origin === 'https://ellul.ai' ||
  /^https:\/\/[a-zA-Z0-9-]+\.ellul\.(ai|app)$/.test(origin || '')
) {
  // Reflect origin in CORS response (allow credentialed)
  response.headers.set('Access-Control-Allow-Origin', origin);
  response.headers.set('Access-Control-Allow-Credentials', 'true');
}
```

## Error handling

```typescript
if (response.status >= 521 && response.status <= 530) {
  // Origin unreachable; show sleeping page
  return new Response(sleepingPage, { status: 503 });
}

if (response.status === 421) {
  // SNI mismatch (origin tag not in Caddy site block)
  return new Response(misdirectedPage, { status: 503 });
}

if (response.status === 101) {
  // WebSocket upgrade — pass through untouched
  return response;
}

return response;
```

## KV state machine

`SERVER_ROUTES` namespace entries (managed by `gateway-reconciler.ts`):

| Key | Value | Meaning |
| --- | --- | --- |
| `<shortId>` | `{"s":"active","o":"<ipTag>"}` | Server up, route to origin |
| `<shortId>` | `"sleeping"` | Server hibernated, show sleeping page |
| `<shortId>` | (absent) | 404 |
| `customHostname:<host>` | `{"shortId":"<shortId>"}` | Custom domain mapping |

## Reconciler interaction

The Worker is read-only on KV. The control plane reconciler (`apps/api/src/cron/gateway-reconciler.ts`) writes:

- On wake: KV `<shortId>` → `{"s":"active","o":"<tag>"}`.
- On hibernate: KV `<shortId>` → `"sleeping"`.
- On delete: KV entry removed.
- Custom domain add/remove: customHostname entry CRUD.

Reconciler runs every 10 min. Drift detection: read KV, compare to desired state from DB, write only on divergence.

## Throughput considerations

KV reads are global, low-latency (<10 ms typically). The Worker reads once per request; no caching needed.

If KV becomes a bottleneck (high-throughput single VPS), add edge caching with short TTL (e.g., 30s). Not implemented currently — KV reads are fast enough.

## Cross-references

- Reconciler: `apps/api/src/cron/gateway-reconciler.ts`.
- Origin tags: [03-origin-tags.md](./03-origin-tags.md).
- Domain model: [06-domain-model.md](./06-domain-model.md).
