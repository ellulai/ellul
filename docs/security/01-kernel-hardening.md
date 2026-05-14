# Kernel hardening

Settings applied during provisioning's SECURITY section. Source: `apps/api/src/provisioning/shell/security/kernel-hardening.sh`.

These are kernel-level defenses. The agent cannot bypass them without exploiting the kernel itself.

## Sysctls

Written to `/etc/sysctl.d/99-ellul-*.conf` and applied via `sysctl --system`.

### `kernel.yama.ptrace_scope=1`

**File:** `/etc/sysctl.d/99-ellul-ptrace.conf`

Restricts who can call `ptrace()` (and through it, read another process's memory or environment). Mode 1 means "only ancestor processes can ptrace each other."

**What this blocks.**

The agent runs as `dev`. Sovereign Shield's git subprocesses also run as `dev` (because they spawn from `shield-runner` but execute in the agent's context for git pushes). Without ptrace_scope, the agent could read `/proc/<gitpid>/environ` to steal the `GIT_ASKPASS` credential helper's token before the credential session is deleted.

ptrace_scope=1 makes those processes "siblings" under systemd, not parent-child. Agent cannot ptrace siblings. Defense holds.

**Why it matters specifically.** Git push protection assumes credentials live in process memory only. ptrace_scope is what enforces this kernel-side.

### `kernel.dmesg_restrict=1`

Blocks unprivileged users from reading the kernel ring buffer (`dmesg`). Without this, kernel messages can leak addresses (KASLR bypass) and timing details.

### `kernel.kptr_restrict=2`

Hides kernel pointers from unprivileged processes. Affects `/proc/kallsyms` and similar interfaces. Mode 2 hides for everyone except root.

### `kernel.unprivileged_bpf_disabled=1`

Prevents unprivileged users from loading BPF programs. BPF could otherwise be used for kernel-level privilege escalation, packet sniffing, or fault injection.

### `net.core.bpf_jit_harden=2`

Even when BPF is loaded by privileged code, this hardens the JIT compiler against side-channel and Spectre-style attacks.

### `net.ipv4.ip_forward=1`

Enables IP forwarding. Required for our per-project network namespaces to reach the host's network through veth pairs and iptables masquerading. Counter-intuitive (looks like a hardening regression) but necessary for the namespace model.

### Memory subsystem (`vm.*`)

- `vm.overcommit_memory=1` — allow overcommit (Node services and Postgres tolerate well; OOM-killer steps in if needed).
- `vm.swappiness=` (RAM-tuned).
- `vm.watermark_scale_factor=` (RAM-tuned).
- `vm.min_free_kbytes=` (RAM-tuned).

These are tuned by the MEMORY_TUNING section based on the VPS's actual RAM, not security-driven.

## /proc mount with hidepid=2

`/proc` is remounted with `hidepid=2,gid=<shield-gid>` (lines 104-125 of kernel-hardening.sh).

**Effect.** Non-root processes cannot see `/proc/<pid>` for processes owned by other UIDs (except their own and same-group `shield`).

**What this blocks.**

- Agent enumerating root-owned processes (enforcer, luks-boot).
- Agent reading `/proc/<sovereign-shield-pid>/cmdline`.
- Agent finding sibling agent-bridge children to ptrace.
- (Combined with ptrace_scope, defense in depth.)

**Why `gid=shield`.** Shield-runner needs to read `/proc` for service health probes. Granting it via group membership lets us hide for everyone except shield, without making `/proc` a free-for-all.

## journalctl restriction

`/usr/bin/journalctl` chmod 750, owned `root:shield`.

The agent cannot read systemd journal. This matters because Shield's startup logs may include error messages mentioning paths or configuration.

## auditd with immutable rules

`/etc/audit/rules.d/ellul.rules` with `-e 2` flag (immutable). Once loaded, rules cannot be cleared without a reboot.

Audited events:

- File modifications under `/etc/ellul/`.
- File modifications under `/usr/local/bin/`.
- Privilege escalation attempts (setuid/setgid execs).
- Extended attribute changes (xattr — would catch attempts to remove `chattr +i`).
- Mount operations.

`/etc/systemd/journald.conf.d/ellul.conf` keeps journal persistent (`SystemMaxUse=200M`, `MaxRetentionSec=7day`).

## AppArmor profile for bwrap

Some agent CLIs (codex, claude-code) use bubblewrap (`bwrap`) for additional sandboxing. Ubuntu 24.04+ ships a restrictive default AppArmor profile that blocks `userns,` (creating user namespaces).

We ship a permissive profile in `/etc/apparmor.d/bwrap` allowing `userns,` for the bwrap binary:

```
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  # other capabilities...
}
```

Without this, codex sandboxes silently fail.

## File immutability (`chattr +i`)

Applied by `sudo-immutability.sh` to all sudo-reachable scripts:

```
ellul-mount-volume
ellul-update-identity
ellul-netns-helper
ellul-agent-namespace
ellul-luks-unlock
ellul-update-binary
git-credential-ellul
shield-git-wrapper
shield-pg-wrapper
ssh-authorized-keys-helper
```

`chattr +i` makes the file immutable to everyone, including `root` (must `chattr -i` first to modify, which auditd logs).

**Defense purpose.** If `root` is compromised through an exploit, the attacker cannot replace these scripts with malicious versions. The original scripts remain in place; any modification attempt is auditable.

## Coredump prevention

Three layers:

1. **systemd `LimitCORE=0`** in service units — disables coredumps for the service.
2. **`/proc/sys/kernel/core_pattern`** redirects coredumps to `/etc/ellul/coredumps/core.%e.%p` owned `root:shield-runner 2770` — agent can't read, even if a coredump escapes the limit.
3. **ulimit and ACLs** as belt-and-suspenders.

**Why.** A coredump of Sovereign Shield could leak passkey-derived secrets, the JWT signing key, etc. Three layers of redundancy here is intentional.

## SSH hardening

`/etc/ssh/sshd_config.d/ellul.conf` (immutable):

```
PasswordAuthentication no
PermitRootLogin prohibit-password
ChallengeResponseAuthentication no
KbdInteractiveAuthentication no
UsePAM no
AuthorizedKeysFile /etc/ssh/authorized_keys/%u
AllowUsers dev coder root
```

`AuthorizedKeysFile /etc/ssh/authorized_keys/%u` redirects to `/etc/ssh/authorized_keys/<username>` (root-owned, mode 660 with `shield` group). Standard `~/.ssh/authorized_keys` is NOT honoured.

This means the agent cannot grant itself SSH access by writing to `~/.ssh/authorized_keys`. Only Shield (in `shield` group) can update authorized keys.

## Ironclad firewall mode lockdown

Within `firewall-full-ironclad.sh` (free tier):

```bash
chmod 000 /usr/bin/su
chmod 700 /sbin/iptables
chmod 700 /usr/sbin/nft
chmod 700 /usr/bin/nsenter
chmod 700 /usr/bin/unshare
rm -f /usr/bin/pkexec
rm -f /usr/bin/newgrp
```

Each removal/lockdown closes a privilege-escalation path. `chmod 000` makes the binary execute-impossible even by root.

The legacy `firewall-relaxed.sh` (paid tier) applies the same locks, with a slightly broader sudo whitelist for development workflows.

## Sudoers

`/etc/sudoers.d/` files (each `chattr +i` after writing):

- `ellul-ns-sudo` — `dev ALL=(root) NOPASSWD: /usr/local/bin/ellul-agent-namespace *`
- `ellul-mount` — mount-volume helper
- `ellul-update-identity` — identity update helper
- `ellul-update-binary` — release apply helper

The `90-cloud-init-users` file (which granted `dev ALL=(ALL) NOPASSWD: ALL`) is **deleted** before tier-narrow rules are written. This ordering matters: removal first, then narrow rules; otherwise a misconfiguration could leave the agent with full sudo.

## Putting it together

A motivated attacker with code execution as `dev` faces:

```
Try ptrace sibling git subprocess
  → ptrace_scope=1 denies (kernel)

Try reading /proc/<shield-pid>/environ
  → hidepid=2 denies (kernel mount option)
  
Try modifying iptables to open a port
  → iptables binary is chmod 700 (POSIX ACL)
  → no sudo entry to run it (sudoers narrow)

Try unsharing a new mount namespace to bypass /proc hide
  → unshare binary is chmod 700
  → namespace creation requires CAP_SYS_ADMIN

Try replacing the namespace helper to inject privileged code
  → script is chattr +i (kernel attribute)
  → unsetting requires root + auditd will log

Try reading /etc/ellul/shield-data/local-auth.db directly
  → file is shield-runner:shield-runner 700 (POSIX)
  → not in shield-runner group, denied by kernel DAC

Try BPF program to ptrace sysenter
  → kernel.unprivileged_bpf_disabled=1 (kernel)

Try reading kernel ring buffer for ASLR-defeating addresses
  → kernel.dmesg_restrict=1 (kernel)

Try crashing Shield to dump credentials
  → LimitCORE=0 (systemd) + core_pattern redirect (kernel)
  → core file owned shield-runner, agent can't read
```

Every avenue terminates at a kernel- or POSIX-enforced barrier. This is what "defense in depth" means in concrete terms.

## What does NOT come from kernel hardening

- **Application logic.** Sovereign Shield's auth DB integrity is a SQLite + WAL + hash-chain property, not a kernel property.
- **Egress allowlists.** That's iptables + Warden, layered above the kernel firewall hooks.
- **PoP signing.** That's a browser-side WebCrypto property; the kernel doesn't enforce it.
- **Sovereign mode LUKS slot removal.** Kernel does store the LUKS header but doesn't enforce slot semantics; cryptsetup does.

The kernel layer is foundational but not the whole story. Deeper layers continue from here.
