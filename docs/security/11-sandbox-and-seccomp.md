# Sandbox tools and seccomp

Two related but distinct mechanisms:

- **seccomp-BPF filter** applied at namespace entry. Blocks ~50 dangerous syscalls.
- **bwrap (bubblewrap)** sandboxing inside CLI agents (codex, claude-code). Adds a separate layer of unprivileged user-namespace sandboxing.

## seccomp-BPF

Source: `packages/vps/src/shell/helpers/agent-namespace/seccomp-exec.c`. Compiled to `/usr/local/bin/ellul-seccomp-exec` (root:root 755).

Applied in namespace `enter.sh:222` and `spawn.sh:373`:

```bash
exec /usr/local/bin/ellul-seccomp-exec /usr/sbin/runuser -l "$SVC_USER" -c "$_CMD"
```

If the binary is missing, namespace setup fails closed:

```bash
if [ ! -x /usr/local/bin/ellul-seccomp-exec ]; then
  echo '{"success":false,"error":"SECURITY: seccomp binary missing..."}' >&2
  exit 1
fi
```

This is a hard requirement. No silent fallback.

## Default-allow with deny-list

Same pattern as Docker's seccomp profile. Allow everything except a specific list. This balances security and compatibility — package installers, language runtimes, web servers all work without modification.

## Blocked syscall categories

Source: `seccomp-exec.c:30-131`.

### Namespace / container escape

`unshare`, `setns`, `pivot_root`, `chroot`, `mount`, `umount2`, `move_mount`, `fsopen`, `fsconfig`, `fsmount`, `fspick`, `open_tree`, `mount_setattr`.

Why: prevents the agent from creating a fresh namespace that re-mounts host filesystems, escaping our mount restrictions. Even with `CAP_SYS_ADMIN` (which the agent doesn't have), seccomp blocks at syscall level.

### Process debugging

`ptrace`, `process_vm_readv`, `process_vm_writev`.

Why: defense in depth on top of `kernel.yama.ptrace_scope=1`. Even if the kernel sysctl is somehow bypassed (e.g., regression in a kernel update), seccomp denies syscall.

### Kernel module loading

`init_module`, `finit_module`, `delete_module`, `create_module`.

Why: prevents loading rootkits or hostile drivers. Module-loading also requires CAP_SYS_MODULE (which the agent doesn't have), but seccomp adds a tier of denial.

### System control

`reboot`, `kexec_load`, `kexec_file_load`, `sethostname`, `setdomainname`, `settimeofday`, `clock_settime`, `adjtimex`, `clock_adjtime`, `acct`.

Why: prevent reboot/kexec attacks (replacing kernel), hostname spoofing (could affect TLS/SNI), time manipulation (replay attacks).

### BPF / performance monitoring

`bpf`, `perf_event_open`, `lookup_dcookie`.

Why: prevent BPF program loading, performance profiling that could leak addresses, dcookie lookup (legacy oprofile).

### Kernel exploits (recent CVE classes)

`userfaultfd`, `io_uring_setup`, `io_uring_enter`, `io_uring_register`.

Why: io_uring has had multiple kernel exploits; userfaultfd has been used for race-condition attacks. Limiting access reduces attack surface.

### Kernel keyring

`add_key`, `request_key`, `keyctl`.

Why: keyring has been a vector for several escalation CVEs.

### I/O privilege (x86 only)

`iopl`, `ioperm`.

Why: direct I/O port access. Legacy x86 mechanism that occasionally allows privilege escalation.

## What's allowed

Everything not on the list. Notably:

- **File I/O.** read, write, open, close, openat, stat, fstat, lstat, etc.
- **Networking.** socket, bind, listen, connect, send, recv, sendto, recvfrom (and IPv6 variants).
- **Process management.** fork, vfork, clone (without CLONE_NEWNS etc.), execve, wait4, exit_group.
- **Memory.** mmap, munmap, mprotect, brk.
- **Signals.** kill, sigaction, sigprocmask.
- **Filesystem.** chmod, chown, link, unlink, rename, symlink (within allowed paths).
- **Package operations.** All the syscalls that npm/pip/cargo need.

## Validation

Block list is in C, compiled with libseccomp. Easy to audit. Updates require rebuilding the binary and re-deploying via manifest.

## bwrap (bubblewrap)

`bwrap` is an unprivileged sandbox tool used by some agent CLIs (codex's sandbox feature, claude-code's restricted mode). It creates additional user namespaces and mount restrictions on top of our project namespace.

### Why bwrap on top of our namespaces

CLI agents have their own sandboxing models for code execution. They don't know about our namespace setup. They invoke `bwrap` directly. We need to allow this without compromising our security.

### AppArmor profile

Ubuntu 24.04+ ships a restrictive AppArmor profile that blocks `userns,` (user namespace creation) by default. This breaks bwrap — the agent CLI errors with "Operation not permitted" when trying to sandbox.

We ship a custom profile at `/etc/apparmor.d/bwrap`:

```
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  network,
  mount,
  pivot_root,
  capability sys_admin,
  capability dac_override,
  # ... other capabilities bwrap needs
}
```

Loaded via `apparmor_parser -r /etc/apparmor.d/bwrap`. Persistent across reboots.

The profile is scoped to bwrap specifically; it doesn't grant userns to other binaries.

### Compatibility

bwrap inside our project namespace works. The agent's CLI-issued bwrap creates nested namespaces. Since our seccomp-BPF blocks `unshare` and `setns`, you might think bwrap would fail — but bwrap uses `clone3` (with `CLONE_NEWNS` etc.) which is allowed by our default-allow seccomp. The flag-based denial is in the `unshare` syscall path; `clone` with namespace flags is permitted because we don't blacklist `clone`.

This is intentional: nested user namespaces are a Linux feature, and CLI agents rely on them. Our defense relies on the higher-level enforcement (POSIX ACLs, mount-namespace boundary) rather than blocking namespaces wholesale.

## What bwrap does NOT bypass

Even when bwrap creates a user namespace, the agent inside cannot:

- Reach files outside our project namespace's mount tree (host's `/etc/ellul/shield-data` is tmpfs-overlaid empty in our namespace; bwrap doesn't see the host's, only the namespace's).
- Make network calls to non-allowlisted destinations (host's iptables FORWARD chain still applies).
- Read other UIDs' /proc entries (hidepid=2 on the parent /proc).
- Spawn syscalls we deny via seccomp (the seccomp filter applied at namespace entry inherits to children).

So bwrap is additive isolation, not subtractive escape.

## CLI-specific configurations

### codex sandbox

codex's sandbox feature uses bwrap to read-only-mount a copy of the source and execute potentially-untrusted code. Within our namespace, codex's bwrap call works as long as the AppArmor profile is loaded.

### claude-code restricted mode

claude-code's restricted mode also uses bwrap. Same compatibility.

### tmpfs overlay for $HOME/.bun, $HOME/.opencode

In persistent-namespace mode, the home directory is read-only-bind-mounted, with overlayfs for specific dotdirs. Some CLIs (bun, opencode) write to top-level home directories like `$HOME/.bun` or `/home/dev` directly — these get tmpfs overlays so writes succeed. Without the overlay, the CLI would error with EROFS.

This was a real bug. Fix: add the directory to the overlay list in the namespace setup.

## Audit and observability

Seccomp denials log to `dmesg` (kernel) but `kernel.dmesg_restrict=1` blocks user reads. From journald they're visible in audit format if auditd is configured to record SECCOMP events.

For incident response: `ausearch -m SECCOMP -ts recent` lists recent seccomp denials.

## What if seccomp turns out to be too restrictive?

If a legitimate workflow breaks because seccomp blocks something legitimate:

1. Identify the syscall via `strace` (or kernel audit).
2. Decide if it should be allowed (review the security impact).
3. Update `seccomp-exec.c` to remove from blocklist.
4. Rebuild binary, ship via manifest update.

Adding (allowing) a syscall is a security decision; removing (blocking) is a compatibility decision. Both should be code-reviewed.

## Cross-references

- Namespace setup: [../isolation/01-namespace-script.md](../isolation/01-namespace-script.md).
- Kernel hardening: [01-kernel-hardening.md](./01-kernel-hardening.md).
- Sandbox known issues: [13-known-limitations.md](./13-known-limitations.md).
