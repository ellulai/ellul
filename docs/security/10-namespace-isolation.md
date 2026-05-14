# Namespace isolation (security perspective)

The mount/PID/network namespace boundary is the agent's primary cage. This page describes namespaces from a security standpoint; for implementation detail see [../isolation/](../isolation/).

## What is in a namespace

For each project, three Linux namespaces stack:

| Namespace | What it isolates | Default in Linux | Our setting |
| --- | --- | --- | --- |
| **mount** | filesystem view (`/`, `/home`, etc.) | shared | private root |
| **PID** | process tree | shared | private |
| **network** | network interfaces, routing, sockets | shared | private (named netns) |

Not isolated:

- **UTS** (hostname).
- **IPC** (System V IPC, POSIX message queues).
- **User** (uid/gid mapping). Same `dev` user inside and outside.
- **cgroup** (resource limits, separate from namespace per se).
- **time**.

We deliberately don't isolate UTS/IPC because the security gain is marginal and they break some agent expectations (e.g., resolving `hostname` for git config).

## What the agent sees inside a namespace

```
/                                       (mount-private)
├── /etc/                                (mostly host's, with overlays)
│   ├── ellul/                           tmpfs (empty, mode 000)
│   ├── caddy/                           inherited from host (read-only)
│   └── (others)                          inherited from host
├── /var/                                 inherited
├── /usr/                                 inherited
├── /home/dev/                           bind-mount of host (read-only via remount)
│   ├── projects/
│   │   ├── sbx-aaaaa/                   bind-mount writable (this project's source)
│   │   ├── .shared/
│   │   │   └── sbx-bbbbb/                read-only snapshot of B (rsync, not bind)
│   │   ├── CLAUDE.md, AGENTS.md          context files
│   ├── .config/                         overlayfs (writable upper)
│   ├── .claude/                         overlayfs
│   ├── .cache/                          overlayfs
│   ├── .ellul/                          overlayfs
│   └── .gitconfig, .claude.json         bind-mounted writable
├── /tmp/                                 tmpfs (256M, ephemeral)
├── /proc/                               private /proc (PID namespace)
├── /run/
│   └── shield/                           tmpfs empty (hides shield secrets)
└── /var/lib/
    └── ellul-shielded/                   tmpfs empty (hides app vaults)
```

So the agent sees:

- ITS project, writable.
- Other projects' source it has read access to, read-only and snapshot-frozen.
- Its own home dotfiles, with overlays for write.
- Its own /tmp, ephemeral.
- A view of system files (read-only).
- NOTHING from `/etc/ellul/shield-data` (tmpfs overlay).
- NOTHING from `/var/lib/ellul-shielded` (tmpfs overlay).
- NOTHING from `/run/shield` (tmpfs overlay).

## What it does NOT see

- Other projects' files (no bind mount).
- Host-process listings (`/proc/<pid>` of root-owned processes are hidden via `hidepid=2` on host /proc, which we re-mount; even our private /proc only shows namespace-internal pids).
- Other projects' network namespaces (its veth only connects to host bridge).
- Direct routes to internal services (3002, 7700) — must go through 127.0.0.1 inside namespace, which doesn't reach those ports because ports bind 127.0.0.1 in host namespace, not project's.

## Network isolation

Each project gets a deterministic IP in 10.200.0.0/8 derived from HMAC-SHA256(jwt-secret, projectSlug). So:

- Project A: `10.<x>.<y>.<z>`
- Project B: different `10.<x>.<y>.<z>`

Veth pair connects host (`ea-<slug>`) to namespace. Host-side iptables FORWARD chain:

```
-A FORWARD -s <ns-ip> -p udp --dport 53 -j DROP                  # block DNS
-A FORWARD -s <ns-ip> -p tcp --dport 53 -j DROP
-A FORWARD -s <ns-ip> -d <host-bridge>/30 -j ACCEPT             # allow bridge
-A FORWARD -s <ns-ip> -d 169.254.0.0/16 -j DROP                 # cloud metadata
-A FORWARD -s <ns-ip> -d 10.0.0.0/8 -j DROP                     # other namespaces
-A FORWARD -s <ns-ip> -d 172.16.0.0/12 -j DROP                  # RFC1918
-A FORWARD -s <ns-ip> -d 192.168.0.0/16 -j DROP                 # RFC1918
-A FORWARD -s <ns-ip> -m set ! --match-set ellul-egress dst -j DROP  # default-deny
-A FORWARD -s <ns-ip> -j ACCEPT                                 # allowlisted
-A FORWARD -d <ns-ip> -m state --state ESTABLISHED,RELATED -j ACCEPT
```

The `ellul-egress` ipset is populated at namespace setup with pre-resolved IPs of allowlisted destinations (Anthropic, OpenAI, npm, github, etc.). DNS is blocked at the FORWARD level — namespace must use injected `/etc/hosts` entries.

For why DNS is blocked: dnsmasq + iptables-nft has compatibility issues, and pre-resolved hosts simplifies the security model.

## Host /etc/hosts injection

Setup writes a marker block to host `/etc/hosts`:

```
# === ELLUL_EGRESS_BEGIN ===
192.168.x.y  api.anthropic.com
13.x.y.z     api.openai.com
...
# === ELLUL_EGRESS_END ===
```

Inside namespace, `/etc/hosts` is bind-mounted from host, so namespace sees the same entries. `/etc/resolv.conf` points to 8.8.8.8/1.1.1.1 (which DNS-block prevents from working) — entries in /etc/hosts take precedence.

## Mount isolation

Inside the namespace's mount namespace:

- `/home/dev` is bind-mounted from host then remounted read-only.
- Active project (`/home/dev/projects/<thisProject>`) is bind-mounted writable.
- Other projects don't appear (no bind mount to host's /home/dev/projects/<other>).
- Shared projects are rsync-copied to scratch tmpfs and bind-mounted read-only at `.shared/<slug>`.
- Sensitive paths (`/etc/ellul/shield-data`, `/var/lib/ellul-shielded`, `/run/shield`) are tmpfs-overlaid empty.

The remount-ro pattern is critical: bind mount, mount tmpfs upper layers (for `.cache`, `.config`, etc.), THEN remount-ro. Order matters — tmpfs upper layers must exist before the lower becomes ro, otherwise the upper creation fails.

## seccomp filter

Before exec'ing the agent's command, the namespace runner applies a seccomp-BPF filter (`ellul-seccomp-exec` binary) that blocks ~50 syscalls:

- Namespace creation: `unshare`, `setns`, `pivot_root`, `chroot`, `mount`, `umount2`.
- Process debugging: `ptrace`, `process_vm_readv`, `process_vm_writev`.
- Kernel module: `init_module`, `finit_module`, `delete_module`, `create_module`.
- System control: `reboot`, `kexec_*`, `sethostname`, `settimeofday`, `clock_settime`.
- BPF: `bpf`, `perf_event_open`.
- Kernel exploits: `userfaultfd`, `io_uring_*`.
- Kernel keyring: `add_key`, `request_key`, `keyctl`.
- I/O privilege (x86): `iopl`, `ioperm`.

Default action: ALLOW. Block-list approach (Docker-style). Doesn't break normal app behaviour (file I/O, networking, package managers all work).

For full list: [../isolation/05-seccomp.md](../isolation/05-seccomp.md).

## Persistent vs ephemeral namespaces

Two modes:

- **Setup (persistent).** Creates anchor process per project. Stays alive across multiple agent invocations. Subsequent commands use `enter` (fast nsenter, ~50ms target).
- **Spawn (ephemeral).** Creates fresh namespace per command. Tears down on exit. ~1s on ARM, slower than enter but simpler. Used as fallback.

Persistent has higher RAM cost (anchor process holds ~500MB per project) but better latency. The planned shared-gateway model would eliminate the per-project anchor entirely.

## What this isolation does NOT prevent

- **Agent reading its own project's secrets.** Files in `/home/dev/projects/<thisProject>/` are accessible. App `.env` stays in `/etc/ellul/secrets/` (separate, hidden) but if the customer puts secrets in their project, the agent sees them.
- **Agent making approved-for-allowlist calls.** Once the allowlist is set, the agent can call any allowlisted destination — including ones the customer might not expect.
- **Agent inferring information from timing or memory pressure.** Side channels are out of scope.
- **Agent exfiltrating via the allowlist.** A request to `api.anthropic.com` with a payload containing customer code is, formally, on-allowlist. Bandwidth monitoring is the partial mitigation.

## Cross-references

- Implementation: [../isolation/01-namespace-script.md](../isolation/01-namespace-script.md).
- Network details: [../isolation/03-network-namespace.md](../isolation/03-network-namespace.md).
- seccomp filter: [../isolation/05-seccomp.md](../isolation/05-seccomp.md).
- Cross-project specifics: [08-cross-project-isolation.md](./08-cross-project-isolation.md), [../isolation/04-cross-project-snapshots.md](../isolation/04-cross-project-snapshots.md).
