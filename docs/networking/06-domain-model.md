# Domain model

Three patterns of customer-facing domains:

## Subdomain naming

Per VPS, three default subdomains under our zones:

| Subdomain | Purpose | Zone | DNS |
| --- | --- | --- | --- |
| `<shortId>-srv.ellul.ai` | Main experience: dashboard, workbench, IDE shell | platform (.ai) | proxied (CF) |
| `<shortId>-code.ellul.ai` | Code browser, file API surface | platform (.ai) | proxied |
| `<shortId>-dev.ellul.app` | Dev preview (Next, Vite, etc. running) | app (.app) | proxied |

`<shortId>` is the first 8 hex chars of the server UUID.

## Why two zones

Security isolation. Cookies on `*.ellul.ai` (auth cookies) must not leak to `*.ellul.app` (dev preview content). By using separate zones, cross-cookie risk is eliminated by browser's same-zone policy.

In practice:

- Login cookies have domain `*.ellul.ai`.
- Dev preview content has its own zone `*.ellul.app`.
- Customer's app's own cookies are scoped to its preview domain.

## Custom domains

Customers can add their own domain (e.g., `acme.com`):

1. User adds custom domain in console.
2. API checks domain ownership (TXT record verification).
3. API writes KV: `customHostname:acme.com` → `{"shortId":"abc12345"}`.
4. User configures DNS at their registrar:
   - Either CNAME to `<shortId>-srv.ellul.ai` (proxied through CF).
   - Or A record to a Cloudflare proxy IP (managed differently).
5. Worker handles requests:
   - Custom domain → KV lookup → shortId.
   - Always serves AI-zone content (main experience).
6. Caddy site block for the custom domain rewrites Host to the customer's main domain so handlers work.

**Constraint.** Custom domains can ONLY serve the main experience. They cannot serve dev preview or deployed apps. This is a security/cookie-isolation choice.

## Direct mode subdomains

In direct mode (no Cloudflare), subdomains follow `dc/dcode/ddev` convention:

| Subdomain | Purpose |
| --- | --- |
| `<shortId>-dc.ellul.ai` | Main (direct connect) |
| `<shortId>-dcode.ellul.ai` | Code |
| `<shortId>-ddev.ellul.app` | Dev preview |

DNS-only A records (no CF proxy). Caddy uses Let's Encrypt ACME for certs.

## Origin records

Per VPS IP, two records (one per zone):

```
o-<ipTag>.ellul.ai   A   <ip>   (DNS-only)
o-<ipTag>.ellul.app  A   <ip>   (DNS-only)
```

These are NOT customer-facing. Cloudflare's `resolveOverride` targets them.

For details: [03-origin-tags.md](./03-origin-tags.md).

## App-deployment domains

When the customer deploys an app, the app gets a domain:

- **Default.** `<shortId>-app.ellul.app` (subdomain of dev zone).
- **Custom.** Customer's chosen domain (e.g., `myapp.example.com`).

App's Caddy site block is in `/etc/caddy/sites-enabled/<sandboxId>.caddy` (managed by Shield via deploy gate).

## Domain to backend routing

Inside Caddy, host matchers route by hostname:

```caddy
@code host <shortId>-code.ellul.ai
@main host <shortId>-srv.ellul.ai
@app  host <shortId>-dev.ellul.app
```

Each routes to the correct upstream service.

## Dynamic preview ports

Per-project preview servers run on ports 4000-4099 (one per active project). The agent-bridge allocates and manages these.

For routing: Caddy's `@app` host matcher routes to the active preview's port (read at runtime from per-project config).

## Domain-to-app deployment example

```
1. Customer creates app "todo-app" → sandbox sbx-abc1234.
2. Customer wires DNS: todo-app.example.com CNAME <shortId>-app.ellul.app.
3. Customer requests deploy gate → user approves → Shield writes /etc/caddy/sites-enabled/sbx-abc1234.caddy:
   
     todo-app.example.com:443 {
       tls /etc/caddy/origin.crt /etc/caddy/origin.key {
         client_auth { ... }
       }
       reverse_proxy 127.0.0.1:4012
     }
   
4. Shield reloads Caddy.
5. Customer's app is now live at todo-app.example.com.
```

## Domain summary table

| Pattern | Use | Visibility |
| --- | --- | --- |
| `<shortId>-srv.ellul.ai` | Workbench main UI | Customer |
| `<shortId>-code.ellul.ai` | Code browser | Customer |
| `<shortId>-dev.ellul.app` | Dev preview | Customer |
| `<shortId>-dc.ellul.ai` (etc.) | Direct mode | Customer |
| Custom domain | Customer-branded main UI | Customer |
| `o-<ipTag>.ellul.ai/.app` | resolveOverride target | Internal (CF only) |
| Customer app deploy domain | Live customer app | Public |

## Cross-references

- Worker routing: [02-cloudflare-worker.md](./02-cloudflare-worker.md).
- Caddy site blocks: [04-caddy.md](./04-caddy.md).
- Origin tags: [03-origin-tags.md](./03-origin-tags.md).
- Deploy protection: [../security/07-deploy-protection.md](../security/07-deploy-protection.md).
