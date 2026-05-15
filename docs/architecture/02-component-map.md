# Component map

The repo is a pnpm monorepo with `apps/` (deployable surfaces) and `packages/` (shared libraries and runtime bundles). This page is the index.

## apps/

| App | Purpose | Deployment target |
| --- | --- | --- |
| `apps/api` | Control plane (Hono + Drizzle). Provisioning, billing, manifests, gateway reconciler, server lifecycle. | Cloud Run |
| `apps/web` | Marketing site, landing pages, signup. | Cloudflare Pages / Next.js |
| `apps/console` | Customer dashboard (servers, domains, billing, settings). | Cloudflare Pages / Next.js |
| `apps/docs` | Public documentation site (this v2 tree may eventually feed it). | Next.js |
| `apps/games` | Standalone game studio surface. | Cloudflare Pages |
| `apps/ide` | Tauri-based desktop IDE (legacy). | Tauri build |
| `apps/app` | Native app (desktop, iOS, Android). | Tauri build |
| `apps/android` | Android wrapper (legacy). | Tauri build |
| `apps/vscode-extension` | VS Code extension for ellul.ai integration. | VS Code Marketplace |

Most engineering changes live in `apps/api/` (the control plane) and `apps/console/` (the customer-facing dashboard).

### `apps/api/src/` layout

| Subdir | Purpose |
| --- | --- |
| `provisioning/` | First-boot script generation (sections, shell scripts, Hetzner provider). |
| `provisioning/shell/` | The bash sections (header, user, directories, packages, security, services, etc.). |
| `provisioning/shell/security/` | Security setup scripts: kernel hardening, firewall profiles, postgres, ssh injection. |
| `providers/` | Cloud provider clients: Hetzner, DigitalOcean, OVH. |
| `providers/security/` | Provider firewall profiles. |
| `routes/` | Hono routes. `v1/`, `byos/`, `paperclip/`, `admin/`, `webhooks/`, `servers/`, `git/`, etc. |
| `services/` | Business logic (server-state, gateway-kv, gateway-hostname, agent-manifest, billing). |
| `engines/` | Server lifecycle engines: `ephemeral/` (hibernate/wake), `persistent/`, `shared/`. |
| `bridges/` | Terminal and protocol bridges. |
| `cron/` | Background jobs: idle-manager, gateway-reconciler, cpu-monitor, bandwidth-monitor. |
| `security/` | Auth, JWT, middleware, threat detection, audit, attestation, guards. |
| `infrastructure/` | Lower-level infra (DB, queue, cache). |
| `billing/` | Subscription and usage logic. |
| `config/` | Runtime config loading. |

## packages/

| Package | Purpose |
| --- | --- |
| `packages/vps` | VPS runtime services and shell scripts. The biggest package. |
| `packages/vps/core-runtime-bundle` | Single-version pin for grouped runtime components. |
| `packages/vps-ui` | Browser UI hosted on the VPS (code browser, chat, etc.). Tailwind v3 (note: t3code is on v4). |
| `packages/ironclad` | Free-tier firewall: Warden (Go) + iptables packer scripts. |
| `packages/gateway` | Cloudflare Worker for gateway routing. |
| `packages/shield` | Local Shield daemon (paid-tier feature, in development). |
| `packages/shield-proxy` | HTTP proxy for shielded apps. |
| `packages/sovereign-gate-kmod` | Linux kernel module for hardware-interrupt-driven attestation. |
| `packages/db` | Drizzle schema, migrations, types. |
| `packages/types` | Shared TypeScript types. |
| `packages/ellul-crypto` | PQC crypto bindings (ML-KEM-1024, ML-DSA-65, hybrid envelope). |
| `packages/pqc-types` | PQC type definitions. |
| `packages/sandbox-provider` | Per-app sandbox glue. |
| `packages/paperclip-adapter` | npm adapter for Paperclip orchestrator. |
| `packages/chat-actions` | Shared chat action types between web and bridge. |
| `packages/ts-config` | Shared tsconfig presets. |
| `packages/ui` | Shared React component library. |
| `packages/games-runtime`, `games-cli`, `games-seed` | Games product runtime. |
| `packages/studio-service` | Studio backend service. |

### `packages/vps/src/` layout

| Subdir | Purpose |
| --- | --- |
| `services/` | Long-lived processes: gateway, auth, backends, daemons, shared utilities. |
| `services/gateway/caddy-gen/` | Caddyfile generator CLI. |
| `services/gateway/term-proxy/` | Terminal auth proxy. |
| `services/auth/sovereign-shield/` | Auth + gate service. The largest single service. |
| `services/backends/file-api/` | Code browser, file ops, preview ctl, WebSocket events. |
| `services/backends/agent-bridge/` | Chat WebSocket, CLI orchestration, MCP relay. |
| `services/daemons/enforcer/` | Bash daemon: heartbeat, command execution, mounts. |
| `services/daemons/watchdog/` | OpenClaw lifecycle, interactive auth sessions. |
| `services/shared/` | Constants (ports, tiers, deployment models), IPC tokens, framework detection. |
| `shell/` | TS-templated bash for users (workflow scripts, helpers). |
| `shell/workflow/` | User-facing CLIs: git-flow, doctor, ai-flow, slice, preview, expose, maintenance. |
| `shell/security/` | Security workflow helpers (vps-operations, lazy-ai). |
| `shell/sessions/` | Session management (ttyd-wrapper). |
| `shell/helpers/` | Lower-level helpers: agent-namespace, netns, namespace-wrappers, pg-recovery, system. |
| `scripts/` | Build-time generators that produce shell scripts (consumed by `shell/`). |
| `templates/` | Templates for shell scripts and config files. |
| `configs/` | Static config files copied to VPS at provisioning. |
| `capabilities/` | Capability registry (auto-generated capability.json). |

### `packages/ironclad/` layout

| Subdir | Purpose |
| --- | --- |
| `warden/cmd/warden/` | Go entry point for Warden service. |
| `warden/cmd/guardrail/` | Go entry point for Guardrail service. |
| `warden/internal/proxy/` | TLS SNI extraction, transparent proxy, MITM (legacy). |
| `warden/internal/dns/` | DNS resolver with rate limit and blacklist. |
| `warden/internal/throttle/` | Bandwidth throttling. |
| `warden/internal/health/` | Health endpoint. |
| `warden/internal/ca/` | CA cert generation for MITM mode. |
| `warden/seed-rules/global/` | Default deny/allow rule lists. |
| `packer/scripts/` | iptables setup scripts (`warden-iptables.sh`, `warden-iptables-dev.sh`). |
| `src/` | TypeScript install scripts, shim generators. |

## Build and bundling

`packages/vps` builds with tsup, producing `packages/vps/dist/`. From there:

- The control plane (`apps/api`) imports `packages/vps/dist/` to get TypeScript factories that generate provisioning scripts.
- `scripts/build-agent-bundles.mjs` invokes those factories at release time, producing release artefacts in `artifacts/`.
- `scripts/release.mjs` orchestrates: build → publish to R2 → manifest creation → fleet rollout.

The VPS itself receives:

1. The provisioning payload at first boot (via cloud-init).
2. Manifest-shipped components on each subsequent release: `ellul-env`, `ellul-mount-volume`, `ellul-crypto`, `core-runtime` (tarball), `ide` (tarball).

For the full release flow see [operations/01-release-pipeline.md](../operations/01-release-pipeline.md).

## Cross-package import paths

- `@ellul.ai/vps/services/{group}/{service}` — VPS service exports.
- `@vps/shared/*` — TS path alias for `packages/vps/src/services/shared/*`.
- `@vps/services/*` — TS path alias for `packages/vps/src/services/*`.
- `@ellul.ai/db` — Drizzle schema and types.
- `@ellul.ai/types` — Shared types.
- `@ellul.ai/ironclad` — Warden installer (TS only; binary built separately).

## Other root directories

| Path | Purpose |
| --- | --- |
| `scripts/` | Release pipeline, build orchestration, KMS-signed manifest tooling. |
| `dist/` | Build output (gitignored except for tracked subfolders). |
| `artifacts/` | Release artefacts produced by `release.mjs`. Includes `last-publish.json`. |
| `public-repo-files/` | Files copied to a public mirror repo (license, readme, etc.). |
| `cloudbuild.yaml` | Google Cloud Build config for `apps/api`. |
| `Dockerfile` | Container image for `apps/api`. |
| `.github/` | GitHub Actions workflows. |
| `.gstack/` | gstack browser state for QA testing. |
| `.claude/` | Claude Code config (skills, settings). |
