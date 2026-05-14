# seccomp filter

Compiled C binary at `/usr/local/bin/ellul-seccomp-exec` applies a seccomp-BPF deny-list before exec'ing the agent's command.

Source: `packages/vps/src/shell/helpers/agent-namespace/seccomp-exec.c`.

## Default-allow with deny-list

Same model as Docker. Allow everything except a specific list of dangerous syscalls. Doesn't break package installers, language runtimes, or web servers.

## Blocked categories

### Namespace / container escape

`unshare`, `setns`, `pivot_root`, `chroot`, `mount`, `umount2`, `move_mount`, `fsopen`, `fsconfig`, `fsmount`, `fspick`, `open_tree`, `mount_setattr`.

Why: Prevents creating a new namespace with different mounts, escaping our restrictions.

### Process debugging

`ptrace`, `process_vm_readv`, `process_vm_writev`.

Why: Defense in depth for `kernel.yama.ptrace_scope=1`. If sysctl is somehow bypassed (regression), seccomp denies.

### Kernel module loading

`init_module`, `finit_module`, `delete_module`, `create_module`.

Why: Prevent rootkit installation.

### System control

`reboot`, `kexec_load`, `kexec_file_load`, `sethostname`, `setdomainname`, `settimeofday`, `clock_settime`, `adjtimex`, `clock_adjtime`, `acct`.

Why: Prevent reboot/kexec attacks (replacing kernel), hostname spoofing (could affect TLS/SNI), time manipulation.

### BPF / performance monitoring

`bpf`, `perf_event_open`, `lookup_dcookie`.

Why: BPF program loading, performance profiling, side-channel surfaces.

### Recent kernel CVE classes

`userfaultfd`, `io_uring_setup`, `io_uring_enter`, `io_uring_register`.

Why: io_uring has had multiple kernel exploit CVEs. userfaultfd has been used for race-condition attacks.

### Kernel keyring

`add_key`, `request_key`, `keyctl`.

Why: Keyring has been a vector for several escalation CVEs.

### I/O privilege (x86 only)

`iopl`, `ioperm`.

Why: Direct I/O port access, legacy escalation surface.

## Total

~50 syscalls denied. List in source code: `seccomp-exec.c:30-131`.

## Application

```c
#include <linux/seccomp.h>
#include <linux/filter.h>
#include <seccomp.h>

int main(int argc, char *argv[]) {
  scmp_filter_ctx ctx = seccomp_init(SCMP_ACT_ALLOW);
  
  // Add deny rules for each syscall
  seccomp_rule_add(ctx, SCMP_ACT_KILL, SCMP_SYS(unshare), 0);
  seccomp_rule_add(ctx, SCMP_ACT_KILL, SCMP_SYS(ptrace), 0);
  // ... etc.
  
  seccomp_load(ctx);
  
  // exec target with same args
  execvp(argv[1], &argv[1]);
}
```

`SCMP_ACT_KILL` terminates the process if it attempts a denied syscall.

The filter inherits to children (no way to disable for child processes once loaded). So once applied, the agent's entire process tree is constrained.

## Fail-closed execution

In `enter.sh:222` and `spawn.sh:373`:

```bash
SECCOMP_BIN="/usr/local/bin/ellul-seccomp-exec"
if [ ! -x "$SECCOMP_BIN" ]; then
  echo '{"success":false,"error":"SECURITY: seccomp binary missing"}' >&2
  exit 1
fi
exec "$SECCOMP_BIN" /usr/sbin/runuser -l "$SVC_USER" -c "$_CMD"
```

If the binary is missing, namespace setup fails. No silent fallback.

## What's allowed

Everything not on the deny list. Specifically:

- File I/O: read, write, open, close, openat, stat, fstat, lstat, etc.
- Networking: socket, bind, listen, connect, send, recv, sendto, recvfrom (and IPv6 variants).
- Process management: fork, vfork, clone, execve, wait4, exit_group.
- Memory: mmap, munmap, mprotect, brk.
- Signals: kill, sigaction, sigprocmask.
- Filesystem: chmod, chown, link, unlink, rename, symlink (within allowed paths).
- Package operations: all syscalls npm/pip/cargo need.

## Why default-allow

Default-deny would break too many legitimate workflows. Build tools use obscure syscalls; restricting them per-tool is impractical.

The trade-off is intentional: deny only what is dangerous and rarely-used.

## Audit

Seccomp denials log to dmesg (kernel) but `kernel.dmesg_restrict=1` blocks user reads. Visible to root via `journalctl -k`.

```bash
sudo journalctl -k | grep -i seccomp
sudo ausearch -m SECCOMP -ts recent
```

## Verification

Inside a namespace:

```bash
# Try to load a kernel module
sudo insmod /tmp/test.ko
# → Operation not permitted (seccomp kills the process)
```

The agent has no `sudo`, so this is mostly theoretical. But if the agent jailbroke into a context with capabilities, seccomp still denies.

## Cross-references

- Namespace setup: [01-namespace-script.md](./01-namespace-script.md).
- Kernel hardening: [../security/01-kernel-hardening.md](../security/01-kernel-hardening.md).
- Sandbox tools (bwrap): [../security/11-sandbox-and-seccomp.md](../security/11-sandbox-and-seccomp.md).
