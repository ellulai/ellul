# Cloud Platform

The flagship product. Browser-based AI coding workbench with chat, terminal, code browser, deploys.

## Tiers

### Free ($0)

- 1 project max.
- Hetzner ARM cax11 (2GB RAM, 1 vCPU, 40GB disk).
- Hibernates after 130 min idle.
- `cloud_platform_hobby` provisioning profile.
- User: `coder`.
- Firewall: `full_ironclad` (cloud APIs blocked, mining/tunnels blocked, bandwidth throttled at 500 KB/s).
- Cgroup CPU 80%, RAM 75% soft.
- Tightly whitelisted localhost ports.

### Starter ($20)

- 5 projects.
- Hetzner cpx21 (4GB RAM, 3 vCPU, 80GB disk).
- Hibernates after 130 min idle (Starter idle algorithm).
- `cloud_platform` provisioning profile.
- User: `dev`.
- Firewall: `relaxed`.
- No cgroup limits.

### Standard ($50)

- 20 projects.
- Hetzner cpx31 (8GB RAM, 4 vCPU, 160GB disk).
- Hibernates after 8h idle (Builder idle algorithm with billing-hour-aware deferral).
- Same profile as Starter, larger machine.

## What customers get

- **Workbench UI.** chat, terminal, code browser (file tree, editor preview, file ops). All hosted on `<id>-srv.ellul.ai`.
- **Per-project namespaces.** Each project gets its own mount/PID/network namespace.
- **CLI tools.** Claude, Codex, Gemini, OpenCode pre-installed. Authenticated via watchdog interactive flow.
- **Preview server.** Per-app PM2-managed dev server on `<id>-dev.ellul.app`.
- **Custom domains.** Wire up your own domain.
- **Deploy gate.** User-approved deployments.
- **Database.** Per-app PostgreSQL with three-role hierarchy.
- **Hibernate/wake.** Pay only when active.

## Architecture

Default deployment model: `proxied` (Cloudflare Worker + mTLS to origin).

Services enabled:

- Caddy
- Sovereign Shield
- File API
- Agent Bridge
- Term Proxy
- Watchdog
- Enforcer
- (Free tier only) Warden

PostgreSQL provisioned on demand when first app is created.

## What's special about Cloud Platform vs others

- Has the workbench UI.
- Cloudflare-mediated networking by default.
- Customer-facing domains.

## Cross-references

- Provisioning profile: [../provisioning/03-tier-profiles.md](../provisioning/03-tier-profiles.md).
- Service inventory: [../architecture/03-vps-services.md](../architecture/03-vps-services.md).
- Tier matrix: [05-tier-matrix.md](./05-tier-matrix.md).
