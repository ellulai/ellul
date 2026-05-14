# Per-project isolation

Every project on a VPS runs in its own Linux namespace boundary: mount, PID, network. The agent inside the namespace sees only its own project's files and processes; outbound traffic is allowlist-only.

For the security perspective: [../security/10-namespace-isolation.md](../security/10-namespace-isolation.md). For implementation: this section.

## Pages

- [01-namespace-script.md](./01-namespace-script.md) — `ellul-agent-namespace` modes.
- [02-mount-layout.md](./02-mount-layout.md) — bind mounts, overlays, tmpfs.
- [03-network-namespace.md](./03-network-namespace.md) — veth, IPs, firewall.
- [04-cross-project-snapshots.md](./04-cross-project-snapshots.md) — `.shared/<slug>` mechanism.
- [05-seccomp.md](./05-seccomp.md) — syscall denylist.
- [06-future-shared-gateway.md](./06-future-shared-gateway.md) — Phase 5b plan.

## Three namespace types

```
[host kernel]
   |
   ├─ mount namespace (private root)
   │   private /, project bind mount, tmpfs overlays
   │
   ├─ PID namespace (private process tree)
   │   /proc shows only namespace PIDs
   │
   └─ network namespace (named netns per project)
       veth pair, deterministic 10.x.x.x IP
       FORWARD chain controls egress
```

## What's NOT isolated

- UTS (hostname).
- IPC.
- User (uid/gid mapping).

These are intentionally shared — full isolation would break some agent workflows (hostname-based git config, etc.) without meaningful security benefit. The isolation we apply is sufficient.

## Mode summary

The `ellul-agent-namespace` script has four modes:

| Mode | Purpose | Latency |
| --- | --- | --- |
| `setup` | Create persistent anchor + namespace per project | ~2-3s (first-time) |
| `enter` | Reuse persistent namespace via nsenter | ~50ms target |
| `spawn` | Create fresh ephemeral namespace per command | ~1s |
| `teardown` | Tear down namespace, kill anchor | ~500ms |

Persistent (`setup`+`enter`) is the intended flow. Ephemeral (`spawn`) is fallback.

For details: [01-namespace-script.md](./01-namespace-script.md).

## Why this matters

The agent reads its own training data, may have prompt injection from untrusted user input, may be replaced. Defenses must hold against an actively hostile process.

Namespace isolation gives kernel-enforced boundaries. Combined with per-namespace egress allowlist, the worst the agent can do is exfiltrate or disrupt within a small radius.
