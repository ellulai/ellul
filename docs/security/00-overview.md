# Security overview

This page is the entry point to the security model. Each subsection links to deeper detail.

## Threat model in one paragraph

The agent (the AI assistant running on the VPS) is the primary threat actor. It will read its own training data; it may have prompt injection from untrusted user input; it may, in the limit, be replaced with a malicious binary. Defenses must hold against an actively hostile process running as `dev` or `coder`. The user (browser) is trusted to authenticate via passkey or JWT; the platform (control plane) is partially trusted (signed manifests + signed commands, but in sovereign mode the platform key is removed). Cloudflare and Hetzner are partners with finite trust.

## Defense layers

Seven independent layers stack. Each is a separate defense; failure of one does not collapse the system.

1. **Kernel.** Linux kernel features: ptrace_scope, hidepid, namespace isolation, seccomp, AppArmor, BPF restrictions, dmesg/kptr restrictions, immutable file attributes (`chattr +i`). [01-kernel-hardening.md](./01-kernel-hardening.md).
2. **Network.** UID-based iptables egress filtering, Warden DNS+proxy, namespace-level ipset allowlists. [../networking/05-iptables-warden.md](../networking/05-iptables-warden.md).
3. **POSIX ACLs and groups.** `shield-runner:shield 700` on auth DB, `caddy:caddy 2770` on proxy config, `root:shield-ipc 640` on IPC tokens, etc. The agent (`dev`) is in `shield-ipc` only via systemd's SupplementaryGroups, not at shell level.
4. **Service isolation.** Sovereign Shield runs as separate `shield-runner` user. Caddy as `caddy`. Postgres as `postgres`. The agent cannot read these services' private files.
5. **Per-project namespaces.** Mount, PID, and network namespaces per project. Source read-only inside namespace; data vault private; tmpfs scratch; egress allowlist. [../isolation/](../isolation/).
6. **Gates.** User-controlled permissions for privileged actions (database, secrets, deploy, git). Agent must request, user approves. [03-sovereign-gates.md](./03-sovereign-gates.md).
7. **Tiers.** `standard` → `web_locked` → `private_locked`. Each tier ratchets up requirements (passkey, PoP, sovereign-mode LUKS). [05-tiers.md](./05-tiers.md).

## What the agent CAN do

So the model is realistic, here is the explicit allowed list:

- Read and write files in its current project's directory (mount-namespaced).
- Read explicitly-shared projects (read-only, rsync snapshot at `.shared/<slug>`).
- Spawn subprocesses (with seccomp blocking dangerous syscalls).
- Make outbound HTTPS calls to allowlisted destinations (mining/tunnels blocked).
- Call internal services over localhost or namespace veth (file-api, agent-bridge, MCP relay).
- Request gates from Sovereign Shield (which surface to user as popups).

## What the agent CANNOT do

- Read other projects' files (mount-namespace boundary).
- Read other UIDs' processes (`hidepid=2`).
- Read sibling processes' memory or environ (`ptrace_scope=1`).
- Modify firewall rules (`iptables` chmod 700).
- Run privileged commands (sudo narrowed, sudo-reachable scripts immutable).
- Reach the internet at unrestricted destinations (Warden DNS+proxy gate).
- Mine cryptocurrency (mining pool DNS blocked + port blocked + Stratum protocol blocked).
- Tunnel via ngrok / Tailscale / WireGuard (DNS blocked + port blocked + raw socket blocked).
- Read app secrets (`/etc/ellul/secrets/<app>.env` — not in `shield` group).
- Read the auth DB (`/etc/ellul/shield-data/local-auth.db` — owned by `shield-runner`).
- Modify Caddyfile (caddy directories `caddy:caddy 2770`).
- Reload Caddy directly (no `caddy` group at shell level).
- Switch security tier (Shield endpoint requires localhost + internal token).
- Push code without git gate (credentials exist only in process memory).
- Deploy without deploy gate (Caddy reload requires Shield-mediated path).

## What lives where

| Defense | Implementation file |
| --- | --- |
| ptrace_scope, hidepid, kptr, etc. | `apps/api/src/provisioning/shell/security/kernel-hardening.sh` |
| sudo lockdown, binary chmod | `apps/api/src/provisioning/shell/security/firewall-*.sh` |
| `chattr +i` on scripts | `apps/api/src/provisioning/shell/security/sudo-immutability.sh` |
| Sovereign Shield service | `packages/vps/src/services/auth/sovereign-shield/` |
| Gate engine | `packages/vps/src/services/auth/sovereign-shield/src/services/gate.service.ts` |
| Gate API | `packages/vps/src/services/auth/sovereign-shield/src/routes/gate-api.routes.ts` |
| Cross-project gate scope check | `packages/vps/src/services/auth/sovereign-shield/src/services/gate-scope-check.ts` |
| Agent namespace script | `packages/vps/src/templates/helpers/agent-namespace/` |
| seccomp filter | `packages/vps/src/shell/helpers/agent-namespace/seccomp-exec.c` |
| iptables egress (free) | `packages/ironclad/packer/scripts/warden-iptables.sh` |
| iptables egress (paid) | `packages/ironclad/packer/scripts/warden-iptables-dev.sh` |
| Warden Go service | `packages/ironclad/warden/` |
| Audit log (hash chain) | `packages/vps/src/services/auth/sovereign-shield/src/services/audit.service.ts` |

## Pages in this section

- [01-kernel-hardening.md](./01-kernel-hardening.md) — sysctl-by-sysctl walk through what each does.
- [02-sovereign-shield.md](./02-sovereign-shield.md) — auth DB schema, secrets, internal endpoints.
- [03-sovereign-gates.md](./03-sovereign-gates.md) — gate types, TTLs, scopes, persistence.
- [04-passkey-and-pop.md](./04-passkey-and-pop.md) — WebAuthn flow, PoP signing.
- [05-tiers.md](./05-tiers.md) — standard / web_locked / private_locked behaviour.
- [06-git-push-protection.md](./06-git-push-protection.md) — the 9-layer git defense.
- [07-deploy-protection.md](./07-deploy-protection.md) — Caddy isolation, admin socket.
- [08-cross-project-isolation.md](./08-cross-project-isolation.md) — 4-layer scope enforcement.
- [09-secrets-management.md](./09-secrets-management.md) — split credential model, stdin injection.
- [10-namespace-isolation.md](./10-namespace-isolation.md) — mount/PID/network namespaces (cross-link with isolation/).
- [11-sandbox-and-seccomp.md](./11-sandbox-and-seccomp.md) — seccomp denylist, bwrap+AppArmor.
- [12-audit-and-forensics.md](./12-audit-and-forensics.md) — hash-chained audit log, auditd integration.
- [13-known-limitations.md](./13-known-limitations.md) — explicit gaps and acknowledged risks.
- [14-claude-oat-credentials.md](./14-claude-oat-credentials.md) — Claude OAuth token handling.
- [15-org-mode.md](./15-org-mode.md) — organization mode.
- [16-scoped-knowledge-vault.md](./16-scoped-knowledge-vault.md) — policy-governed agent knowledge projection.
- [17-gbrain-scrub-layer.md](./17-gbrain-scrub-layer.md) — secret redaction for gbrain persistent memory.
