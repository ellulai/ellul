# Gateway routing

End-to-end traffic flow from browser to backend service in the proxied (default) deployment.

## Request flow

```
Browser → DNS → Cloudflare Edge → Worker → resolveOverride → Origin DNS
       → Cloudflare-to-origin (mTLS) → VPS Caddy → forward_auth → backend
```

### 1. DNS

Browser resolves `<shortId>-srv.ellul.ai`. Cloudflare's DNS responds with a CNAME to Cloudflare's CDN. Browser TLS-handshakes with Cloudflare.

### 2. Cloudflare Edge

Cloudflare presents `*.ellul.ai` cert. TLS terminates here (browser ↔ Cloudflare). Cloudflare invokes the Worker (`packages/gateway/src/index.ts`).

### 3. Worker

```typescript
// Extract shortId
const match = host.match(/^([0-9a-f]{8,})-(srv|code|dc|...)\.ellul\.(ai|app)$/);
const shortId = match?.[1];

// KV lookup
const raw = await env.SERVER_ROUTES.get(shortId);
const { s: status, o: ipTag } = JSON.parse(raw);

if (status !== 'active') {
  return sleeping503Page();
}

// Construct origin host
const zone = host.endsWith('.ellul.app') ? 'ellul.app' : 'ellul.ai';
const originHost = `o-${ipTag}.${zone}`;

// Forward to origin with resolveOverride
const headers = new Headers(request.headers);
headers.set('X-Forwarded-Host', host);
headers.set('X-Request-Id', requestId);

const response = await fetch(new Request(request, { headers }), {
  cf: { resolveOverride: originHost }
});
```

The `resolveOverride` causes Cloudflare to:

1. Re-resolve DNS for `originHost` (DNS-only A record → VPS IPv4).
2. Rewrite SNI in the origin TLS handshake to `originHost`.
3. Rewrite Host header to `originHost`.

So the VPS receives a connection where:

- IP destination = VPS IP (correct).
- TLS SNI = `o-<tag>.ellul.ai` (rewritten).
- HTTP Host = `o-<tag>.ellul.ai` (rewritten).
- HTTP X-Forwarded-Host = `<shortId>-srv.ellul.ai` (preserved by Worker).

### 4. Origin DNS resolution

Cloudflare resolves `o-<tag>.ellul.ai` via standard DNS. We have a record:

```
o-c0a80001.ellul.ai  A  192.168.0.1   (proxied: false, TTL: 1)
```

Cloudflare connects to the resolved IP on port 443.

### 5. mTLS to origin (AOP)

Cloudflare presents its origin-pull client certificate. Caddy validates against `cf-origin-pull-ca.pem` (the AOP CA). Caddy presents its origin server cert (`*.ellul.ai`). Cloudflare validates.

Caddy's strict SNI matching: SNI is `o-c0a80001.ellul.ai`. This MUST be in the site block's address list. If not: 421.

### 6. Caddy receives the request

Caddy sees:
- Host header: `o-c0a80001.ellul.ai`.
- X-Forwarded-Host: `abc12345-srv.ellul.ai`.

Caddy's `@has_xfh` matcher rewrites Host back to `abc12345-srv.ellul.ai` for downstream handler matching.

### 7. Host-based routing

Caddy's matchers:

- `@code` → host is `<shortId>-code.ellul.ai` → File API
- `@main` → host is `<shortId>-srv.ellul.ai` → static + Shield + agent-bridge
- `@app` (in `.app` zone) → host is `<shortId>-dev.ellul.app` → preview server

### 8. forward_auth

For protected routes:

```caddy
@protected not path /_auth/*
forward_auth @protected 127.0.0.1:3005 {
  uri /_auth/session
  copy_headers X-Auth-User X-Auth-Tier X-Auth-Session X-Auth-Timestamp X-Auth-HMAC
}
```

Caddy makes sub-request to Shield. Shield validates the session cookie + (if web_locked) PoP signature. Returns 200 + auth headers, or 401.

### 9. Upstream proxy

Caddy injects auth headers into upstream request:

```caddy
reverse_proxy 127.0.0.1:7700 {
  flush_interval -1   # WebSocket: disable buffering
  header_up X-Forwarded-For {client_ip}
}
```

Backend (file-api, agent-bridge) reads `X-Auth-User` (decorated by Caddy) and processes the request.

## Direct mode

For customers using direct mode (no Cloudflare):

- DNS records are DNS-only (no proxying).
- Caddy uses Let's Encrypt ACME (HTTP-01 or DNS-01) to issue certs.
- No mTLS at origin.
- No `o-<tag>` records needed.

The Caddyfile is simpler:

```caddy
{shortId}-dc.ellul.ai, {shortId}-dcode.ellul.ai, {shortId}-ddev.ellul.app {
  # auto_https on
  # forward_auth, routing, etc.
}
```

`<shortId>-dc.ellul.ai` (note the `-dc-` not `-srv-`) is the convention for direct mode.

## Custom domains

For customer-specified custom domains (e.g., `acme.com`):

1. User adds custom domain in console.
2. API writes KV: `customHostname:acme.com → {"shortId":"abc12345"}`.
3. User configures CNAME or A record at their registrar (pointing to Cloudflare).
4. Worker handles requests:
   - Match isn't a `<shortId>-...` regex.
   - KV lookup: `customHostname:acme.com` → shortId.
   - Custom domains always serve `ai-zone` content (main experience only, no preview).
5. Caddy's site block for custom domain rewrites Host to the customer's main domain so handlers work.

For details: [06-domain-model.md](./06-domain-model.md).

## Routing failure modes

| Symptom | Likely cause | Diagnosis |
| --- | --- | --- |
| 503 "Sleeping" | KV says `sleeping` or no entry | Server hibernated or never provisioned. Check `servers.status`. |
| 421 Misdirected | SNI mismatch (origin tag missing in Caddy) | `cat /etc/ellul/origin-tag` then `grep o- /etc/caddy/Caddyfile`. Re-run caddy-gen. |
| 502 Bad Gateway | Origin unreachable | VPS down or Caddy not running. Check `systemctl status caddy`. |
| 521 Web server is down | CF can't reach origin | Network issue between CF and VPS. Check Hetzner firewall. |
| Timeout / hang | Routing loop (origin record proxied) | Reconciler should fix; check `apps/api/src/cron/gateway-reconciler.ts` last run. |

## Cross-references

- Worker: [02-cloudflare-worker.md](./02-cloudflare-worker.md).
- Origin tags: [03-origin-tags.md](./03-origin-tags.md).
- Caddy config: [04-caddy.md](./04-caddy.md).
- Domain model: [06-domain-model.md](./06-domain-model.md).
