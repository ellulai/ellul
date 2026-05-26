# ellul.ai overview

ellul.ai operates a fleet of single-tenant Linux VPSes that run AI coding agents under a kernel-enforced sovereignty model. The platform sells four products on top of one infrastructure:

| Product | What the customer gets |
| --- | --- |
| **Cloud Platform** | A fully-managed coding workbench with chat, terminal, code browser, deploys. Tiers: Free ($0), Starter ($20), Standard ($50). |
| **Cloud Sandbox** | A sandboxed agent execution environment without the workbench UI. ($20 / $50). |
| **Shield Gateway** | A standalone Sovereign Shield deployment for self-hosted clouds. ($10). |
| **Agent Adapter** | A backend that orchestrators (Paperclip, CrewAI) plug into for sandboxed multi-agent execution. ($50). |

All four products share one codebase. The differences are configuration, provisioning profile, and which services start.

## Architectural pillars

Five non-negotiable properties drive every design decision.

**1. The agent is treated as malicious.** The agent (the AI coding assistant running on the VPS) is the primary threat actor. Every defense — kernel hardening, namespace isolation, gates, signed commands — assumes the agent will eventually be jailbroken or replaced with a hostile binary. Defenses must hold against that.

**2. Defense is layered and kernel-enforced.** No single mechanism is trusted. ptrace_scope, hidepid, mount namespaces, seccomp, Caddy directory ACLs, and shield-group POSIX permissions all stack. If application logic fails, the kernel still says no.

**3. Cloud provider trust is finite.** Hetzner can suspend an account if a customer mines crypto, scans ports, or sends spam. The platform must detect and stop abuse fast enough that Hetzner never pages us.

**4. The platform should be removable.** In sovereign mode (`private_locked` tier), the platform key is physically deleted from LUKS. Even if ellul.ai is compromised, attackers cannot decrypt customer volumes. This is a hard architectural commitment.

**5. The control plane never sees secrets.** Application secrets, API keys, vault contents, and LUKS keys live on the VPS. The API stores wrapped keys (encrypted to a per-VPS public key). Heartbeat responses are entirely discarded — VPSes do not trust API responses.

## High-level system diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│                          Control Plane (apps/api)                    │
│                          Cloud Run, Cloudflare DNS, R2                │
│                                                                      │
│  - Provisioning, billing, idle/wake orchestration                    │
│  - Manifest signing (ML-DSA-65), gateway reconciler                  │
│  - Stores wrapped secrets only, never plaintext                      │
│                                                                      │
└──────────────────────┬─────────────────────────┬─────────────────────┘
                       │                         │
                       │                         │
            (provisioning payload,               (signed manifests,
             wrapped secrets,                     fleet updates,
             commands)                            heartbeats)
                       │                         │
                       v                         v
┌──────────────────────────────────────────────────────────────────────┐
│  Cloudflare Edge                                                     │
│  - DNS for *.ellul.ai, *.ellul.app                                  │
│  - Worker (packages/gateway): KV → resolveOverride to origin tag     │
│  - mTLS to origin (Authenticated Origin Pull)                        │
└──────────────────────────┬───────────────────────────────────────────┘
                           │
                           v
┌──────────────────────────────────────────────────────────────────────┐
│  Customer VPS (Hetzner ARM/Intel/AMD; one per Cloud Platform user)   │
│                                                                      │
│   Caddy (mTLS, forward_auth gate to Shield)                          │
│      │                                                                │
│      ├─ Sovereign Shield (auth, sessions, gate decisions)            │
│      │  - shield-runner user (separate from agent)                   │
│      │  - Vault: /etc/ellul/shield-data (LUKS-backed)                │
│      │                                                                │
│      ├─ File API (code browser, preview ctl, WebSocket)              │
│      ├─ Agent Bridge (WebSocket chat, CLI orchestration)             │
│      ├─ Term Proxy (terminal multiplexing)                           │
│      │                                                                │
│   Daemons:                                                            │
│      ├─ Enforcer (root, heartbeat every 30s, command execution)     │
│      └─ Watchdog (CLI auth sessions, OpenClaw lifecycle)             │
│                                                                      │
│   Per-project namespace (mount + PID + network):                     │
│      └─ AI agent (Claude/Codex/Gemini/OpenCode) runs here            │
│                                                                      │
│   Egress firewall:                                                    │
│      ├─ Warden (Go service, DNS + transparent proxy)                 │
│      └─ iptables (UID-based, redirects agent traffic to Warden)     │
│                                                                      │
│   Encrypted volume (LUKS2, mounted at /home/$SVC_USER/.ellul-vault) │
└──────────────────────────────────────────────────────────────────────┘
```

## Two runtime models

The platform supports two infrastructure runtimes, selected by `servers.runtime`:

| Runtime | How it works | Boot | Density | Best for |
| --- | --- | --- | --- | --- |
| `vps` (default) | Dedicated cloud server per customer | 2-5 min | 1:1 | Sovereign mode, dedicated tier, heavy workloads |
| `sandbox` | QEMU/KVM VM on shared bare-metal via Incus | ~100ms (warm pool) / ~60s (cold) | 25-30:1 | Starter/standard tiers, fast iteration |

Sandboxes run on dedicated bare-metal servers managed by the Incus orchestration layer. Each sandbox is a full QEMU/KVM virtual machine with its own kernel and systemd as PID 1. A warm pool of pre-created frozen VMs enables ~100ms provisioning. See [incus/00-overview.md](./incus/00-overview.md).

## What you cannot do

To set expectations early, here is what the architecture deliberately rejects:

- **Multi-tenant VPSes.** Every customer gets their own VPS. Shared kernels are not in scope. (Incus sandboxes share a host but each has its own kernel via QEMU/KVM hardware virtualization.)
- **Agent root access.** The agent runs as `coder` (free) or `dev` (paid). Privileged actions go through narrowly-scoped sudo entries that are themselves immutable (`chattr +i`).
- **Bypassing the gate system.** Database writes, deploys, git pushes, and secret reads all flow through user-approved gates. There is no "trust this agent" mode.
- **Stable IPv6 in gateway mode.** Origin DNS records are A-only; AAAA is rejected at the reconciler. (Direct mode supports IPv6.) See [networking/03-origin-tags.md](./networking/03-origin-tags.md).
- **Hot-shipping Sovereign Shield.** It is copied (not symlinked) on each release because Node `require()` resolution depends on real path. The release pipeline ensures this. See [operations/02-manifest-system.md](./operations/02-manifest-system.md).

## Where to go next

- **Building features?** Start with [architecture/02-component-map.md](./architecture/02-component-map.md) and [architecture/03-vps-services.md](./architecture/03-vps-services.md).
- **Investigating an incident?** [operations/04-runbooks/](./operations/04-runbooks/) and [lifecycle/05-failure-recovery.md](./lifecycle/05-failure-recovery.md).
- **Threat modeling?** [security/00-overview.md](./security/00-overview.md), [security/13-known-limitations.md](./security/13-known-limitations.md).
- **Onboarding a new VPS?** [provisioning/01-pipeline.md](./provisioning/01-pipeline.md).
- **Hibernate/wake?** [lifecycle/02-hibernate.md](./lifecycle/02-hibernate.md), [lifecycle/03-wake.md](./lifecycle/03-wake.md).
- **Incus VMs (sandbox runtime)?** [incus/00-overview.md](./incus/00-overview.md).
