# Port registry

Every port used on a VPS, with bind address, owner, and reachability.

Source of truth: `packages/vps/src/services/shared/ports.ts`. Build-time `assertNoPortCollisions()` enforces uniqueness.

## Public-facing

| Port | Service | Notes |
| --- | --- | --- |
| 443 | Caddy | mTLS in proxied mode, ACME in direct mode |
| 80 | Caddy | ACME HTTP-01 challenge in direct mode |
| 22 | sshd | Optional (tier-controlled, off by default in web_locked) |

## Localhost-only

| Port | Service | Bind | Auth |
| --- | --- | --- | --- |
| 3002 | File API | 127.0.0.1 | Caddy forward_auth + HMAC headers |
| 3003 | IDE | 127.0.0.1 | Caddy forward_auth (governance tier only) |
| 3005 | Sovereign Shield | 127.0.0.1 | Caddy forward_auth |
| 4096 | OpenCode API | 127.0.0.1 | per-namespace |
| 7700 | Agent Bridge | 127.0.0.1 | Caddy forward_auth |
| 7701 | Term Proxy | 127.0.0.1 | Caddy forward_auth |
| 7710 | Watchdog | 127.0.0.1 | local |
| 5432 | PostgreSQL | 127.0.0.1 | scram-sha-256 (TCP) or peer (Unix socket) |
| 18790 | File API terminal socket | 127.0.0.1 | internal |
| 8080 | Warden proxy | 127.0.0.1 | iptables-redirected only |
| 5353 | Warden DNS | 127.0.0.1 | iptables-redirected only |

## Namespace-only

| Port | Service | Bind | Reachable |
| --- | --- | --- | --- |
| 7702 | MCP relay | 0.0.0.0 | per-project namespace veths only (iptables `ELLUL-NS-IN`) |
| 4000-4099 | Per-project preview | 127.0.0.1 | Caddy (host) |
| 7710-7799 | Dynamic ttyd | 127.0.0.1 | Term Proxy |

## Verification

```bash
# All listening ports
sudo ss -tlnp

# All listening ports + bind address
sudo ss -tlnpa

# Per-port owner
sudo ss -tlnp | grep ':<port>'
```

## Why MCP binds 0.0.0.0

MCP relay is reachable by per-project agents inside namespaces. The agent's namespace has its own veth, and the host-side veth IP is the gateway. The relay listens on 0.0.0.0 so it's reachable from any veth.

iptables `ELLUL-NS-IN` chain restricts: `-i ea-+ -j ACCEPT`, `-j DROP` for non-veth interfaces. So even though it binds 0.0.0.0, only namespace veths reach it.

Per-project HMAC token authentication adds a second layer.

## Why agent's localhost has restricted port whitelist

Free tier `coder` user can connect to:

- 3005 (Shield)
- 5353 (Warden DNS)
- 53 (systemd-resolved)
- 7701 (term-proxy)
- 8080 (Warden proxy)

NOT to:

- 3002 (file-api)
- 4096 (opencode API)
- 7700 (agent-bridge)

This forces the agent to go through Caddy for these services, which means forward_auth runs and decorates with auth headers.

If the agent could connect directly to file-api (3002), it would bypass the auth layer.

## Cross-references

- Port constants: `packages/vps/src/services/shared/ports.ts`.
- iptables localhost rules: [../networking/05-iptables-warden.md](../networking/05-iptables-warden.md).
- Caddy proxying: [../networking/04-caddy.md](../networking/04-caddy.md).
- VPS service inventory: [../architecture/03-vps-services.md](../architecture/03-vps-services.md).
