/*
 * ellul-seccomp-exec — Apply seccomp-BPF filter then exec the target command.
 *
 * Usage: ellul-seccomp-exec <command> [args...]
 *
 * Blocks dangerous syscalls (namespace escape, kernel module loading, filesystem
 * manipulation, process debugging) while allowing all normal operations (file I/O,
 * networking, process spawning, package installation).
 *
 * Build: gcc -o ellul-seccomp-exec seccomp-exec.c -lseccomp -O2 -Wall -Wextra
 * Install: /usr/local/bin/ellul-seccomp-exec (mode 0755)
 *
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2025 ellul.ai. All rights reserved.
 */

#include <errno.h>
#include <seccomp.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#ifndef AF_ALG
#define AF_ALG 38  /* algif_* LPE family entry point (CopyFail, CVE-2026-31431) */
#endif

/*
 * Blocked syscalls — admin operations that no application code uses.
 * Normal agent operations (file I/O, networking, spawning processes,
 * npm install, pip install, cargo build) are completely unaffected.
 */
static const int blocked_syscalls[] = {
    /* ── Namespace / Container Escape ───────────────────────── */
    SCMP_SYS(unshare),         /* Create new namespaces                  */
    SCMP_SYS(setns),           /* Join existing namespaces               */
    SCMP_SYS(pivot_root),      /* Change root filesystem                 */
    SCMP_SYS(chroot),          /* Change root directory                  */

    /* ── Filesystem Manipulation ────────────────────────────── */
    SCMP_SYS(mount),           /* Mount filesystems                      */
    SCMP_SYS(umount2),         /* Unmount filesystems                    */
    SCMP_SYS(swapon),          /* Enable swap                            */
    SCMP_SYS(swapoff),         /* Disable swap                           */
#ifdef __NR_move_mount
    SCMP_SYS(move_mount),      /* Move mount points (5.2+)               */
#endif
#ifdef __NR_fsopen
    SCMP_SYS(fsopen),          /* Open filesystem (5.2+)                 */
#endif
#ifdef __NR_fsconfig
    SCMP_SYS(fsconfig),        /* Configure filesystem (5.2+)            */
#endif
#ifdef __NR_fsmount
    SCMP_SYS(fsmount),         /* Mount filesystem (5.2+)                */
#endif
#ifdef __NR_fspick
    SCMP_SYS(fspick),          /* Pick filesystem (5.2+)                 */
#endif
#ifdef __NR_open_tree
    SCMP_SYS(open_tree),       /* Open mount tree (5.2+)                 */
#endif
#ifdef __NR_mount_setattr
    SCMP_SYS(mount_setattr),   /* Set mount attributes (5.12+)           */
#endif

    /* ── Process Debugging ──────────────────────────────────── */
    SCMP_SYS(ptrace),          /* Attach to / inspect other processes    */
#ifdef __NR_process_vm_readv
    SCMP_SYS(process_vm_readv),  /* Read another process's memory        */
#endif
#ifdef __NR_process_vm_writev
    SCMP_SYS(process_vm_writev), /* Write another process's memory       */
#endif
#ifdef __NR_kcmp
    SCMP_SYS(kcmp),            /* Compare kernel objects across pids —
                                  used for covert channels & to identify
                                  shared fds across same-PID-NS peers   */
#endif

    /* ── pidfd: cross-process fd theft / signal injection ──── */
#ifdef __NR_pidfd_getfd
    SCMP_SYS(pidfd_getfd),     /* Steal open fds from sibling adapters
                                  in the same PID NS (auth tokens, etc.) */
#endif
#ifdef __NR_pidfd_open
    SCMP_SYS(pidfd_open),      /* Open a pidfd — gateway to pidfd_*     */
#endif
#ifdef __NR_pidfd_send_signal
    SCMP_SYS(pidfd_send_signal), /* Inject signals across PID NS peers  */
#endif
#ifdef __NR_process_madvise
    SCMP_SYS(process_madvise), /* Trigger OOM / page eviction on peers   */
#endif

    /* ── NUMA / mempolicy (rarely used, kernel attack surface) ─ */
#ifdef __NR_mbind
    SCMP_SYS(mbind),
#endif
#ifdef __NR_migrate_pages
    SCMP_SYS(migrate_pages),
#endif
#ifdef __NR_move_pages
    SCMP_SYS(move_pages),
#endif
#ifdef __NR_set_mempolicy
    SCMP_SYS(set_mempolicy),
#endif
#ifdef __NR_get_mempolicy
    SCMP_SYS(get_mempolicy),
#endif

    /* ── Misc kernel attack surface ─────────────────────────── */
#ifdef __NR_vmsplice
    SCMP_SYS(vmsplice),        /* Dirty Pipe (CVE-2022-0847) family      */
#endif
#ifdef __NR_quotactl
    SCMP_SYS(quotactl),
#endif
#ifdef __NR_quotactl_fd
    SCMP_SYS(quotactl_fd),
#endif
#ifdef __NR_name_to_handle_at
    SCMP_SYS(name_to_handle_at), /* Filesystem handle resolution        */
#endif
#ifdef __NR_open_by_handle_at
    SCMP_SYS(open_by_handle_at), /* Open by handle — bypasses path checks */
#endif
#ifdef __NR_cachestat
    SCMP_SYS(cachestat),       /* Page-cache side channel (6.5+)         */
#endif
#ifdef __NR_map_shadow_stack
    SCMP_SYS(map_shadow_stack), /* CET shadow stack (6.6+)               */
#endif
#ifdef __NR_mseal
    SCMP_SYS(mseal),           /* Memory sealing (6.10+) — prevents
                                  sandbox from later being un-sealed    */
#endif

    /* ── Landlock: agent must not be able to install its own
     *    LSM rules that could shadow our seccomp filter or
     *    interfere with container introspection.                       */
#ifdef __NR_landlock_create_ruleset
    SCMP_SYS(landlock_create_ruleset),
#endif
#ifdef __NR_landlock_add_rule
    SCMP_SYS(landlock_add_rule),
#endif
#ifdef __NR_landlock_restrict_self
    SCMP_SYS(landlock_restrict_self),
#endif

    /* ── Kernel Module Loading ──────────────────────────────── */
    SCMP_SYS(init_module),     /* Load kernel module from memory          */
    SCMP_SYS(finit_module),    /* Load kernel module from fd              */
    SCMP_SYS(delete_module),   /* Unload kernel module                    */
#ifdef __NR_create_module
    SCMP_SYS(create_module),   /* Create module entry (legacy)            */
#endif

    /* ── System Control ─────────────────────────────────────── */
    SCMP_SYS(reboot),          /* Reboot the machine                     */
    SCMP_SYS(kexec_load),      /* Load new kernel for kexec              */
#ifdef __NR_kexec_file_load
    SCMP_SYS(kexec_file_load), /* Load new kernel from fd                */
#endif
    SCMP_SYS(sethostname),     /* Change hostname                        */
    SCMP_SYS(setdomainname),   /* Change NIS domain name                 */
    SCMP_SYS(settimeofday),    /* Change system time                     */
    SCMP_SYS(clock_settime),   /* Change clock time                      */
    SCMP_SYS(adjtimex),        /* Tune kernel clock                      */
#ifdef __NR_clock_adjtime
    SCMP_SYS(clock_adjtime),   /* Adjust POSIX clock                     */
#endif
    SCMP_SYS(acct),            /* Enable/disable process accounting      */

    /* ── BPF / Performance Monitoring ───────────────────────── */
#ifdef __NR_bpf
    SCMP_SYS(bpf),             /* Load BPF programs                      */
#endif
#ifdef __NR_perf_event_open
    SCMP_SYS(perf_event_open), /* Performance monitoring (side-channels) */
#endif
#ifdef __NR_lookup_dcookie
    SCMP_SYS(lookup_dcookie),  /* Profiling dcookie lookup               */
#endif

    /* ── Exploitable / Rarely Needed ────────────────────────── */
#ifdef __NR_userfaultfd
    SCMP_SYS(userfaultfd),     /* Used in kernel exploits (race windows) */
#endif
#ifdef __NR_io_uring_setup
    SCMP_SYS(io_uring_setup),  /* io_uring (large kernel attack surface) */
#endif
#ifdef __NR_io_uring_enter
    SCMP_SYS(io_uring_enter),
#endif
#ifdef __NR_io_uring_register
    SCMP_SYS(io_uring_register),
#endif

    /* ── Kernel Keyring ─────────────────────────────────────── */
    SCMP_SYS(add_key),         /* Add key to kernel keyring               */
    SCMP_SYS(request_key),     /* Request key from kernel keyring         */
    SCMP_SYS(keyctl),          /* Kernel keyring manipulation             */

    /* ── I/O Privilege (x86 only, harmless no-op on ARM) ──── */
#ifdef __NR_iopl
    SCMP_SYS(iopl),            /* Change I/O privilege level              */
#endif
#ifdef __NR_ioperm
    SCMP_SYS(ioperm),          /* Set I/O port permissions                */
#endif
};

#define ARRAY_LEN(a) (sizeof(a) / sizeof((a)[0]))

int main(int argc, char *argv[])
{
    if (argc < 2) {
        fprintf(stderr, "Usage: ellul-seccomp-exec <command> [args...]\n");
        return 1;
    }

    /*
     * Filter mode selection.
     *
     *   ELLUL_SECCOMP_MODE=allowlist
     *     Default action SCMP_ACT_KILL_PROCESS, only the syscalls in
     *     `allowed_syscalls[]` (below) are permitted. Tighter; closes the
     *     M-2 finding (denylist drift). Adopted incrementally per-binary
     *     — see /etc/ellul/feature-flags/agent-seccomp-allowlist.
     *
     *   default (or ELLUL_SECCOMP_MODE=denylist)
     *     Existing behavior: SCMP_ACT_ALLOW default, denylist of admin
     *     syscalls. Production-tested with every agent CLI we ship.
     *
     * Environment override is intentional: per-binary opt-in is a soft
     * way to roll out the allowlist without breaking working CLIs. The
     * agent-bridge passes ELLUL_SECCOMP_MODE in the env memfd for
     * specific adapters as their allowlists are vetted.
     */
    const char *mode = getenv("ELLUL_SECCOMP_MODE");
    bool allowlist_mode = (mode && strcmp(mode, "allowlist") == 0);

    scmp_filter_ctx ctx = seccomp_init(
        allowlist_mode ? SCMP_ACT_KILL_PROCESS : SCMP_ACT_ALLOW);
    if (ctx == NULL) {
        fprintf(stderr, "ellul-seccomp: seccomp_init failed\n");
        return 1;
    }

    /*
     * Enable kernel audit logging for SCMP_ACT_ERRNO denials. With this
     * attribute set, every blocked syscall produces an `audit: type=1326
     * SECCOMP` record in dmesg / /var/log/audit/audit.log, including the
     * syscall number, pid, comm, and architecture. Without it, denied
     * syscalls return EPERM silently and a Rust binary like codex's
     * vendored bwrap can BRK (SIGTRAP / exit 133) on the failure with no
     * trace anywhere.
     *
     * Best-effort: older kernels may not support SCMP_FLTATR_CTL_LOG. We
     * print a marker either way so operators know whether kernel-side
     * logging is active for this child.
     */
    int log_rc = seccomp_attr_set(ctx, SCMP_FLTATR_CTL_LOG, 1);

    int rules_added = 0;

    /* Deny socket(AF_ALG, ...) — algif_* LPE family (CopyFail). ERRNO > ALLOW
     * in libseccomp priority, so this overrides the broad socket() allow. */
    {
        int rc = seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM),
                                  SCMP_SYS(socket), 1,
                                  SCMP_A0(SCMP_CMP_EQ, AF_ALG));
        if (rc < 0 && rc != -EFAULT) {
            fprintf(stderr,
                    "ellul-seccomp: failed to add AF_ALG deny: %s\n",
                    strerror(-rc));
            seccomp_release(ctx);
            return 1;
        }
        if (rc == 0) rules_added++;
    }

    if (allowlist_mode) {
        /*
         * Allowlist syscalls — the union of what agent CLIs (claude-code,
         * codex, opencode, cursor-agent), Node, Python interpreters, npm,
         * yarn, git, and toolchain helpers need under normal operation.
         * Anything outside this list SIGKILLs.
         *
         * If a CLI hits a syscall not on the list, the failure is loud
         * (SIGSYS audit log + process kill); add the syscall here once
         * verified safe. The denylist mode remains the production default
         * until every supported binary's allowlist is vetted.
         */
        static const int allowed_syscalls[] = {
            /* File I/O */
            SCMP_SYS(open), SCMP_SYS(openat),
#ifdef __NR_openat2
            SCMP_SYS(openat2),
#endif
            SCMP_SYS(read), SCMP_SYS(write), SCMP_SYS(close),
            SCMP_SYS(stat), SCMP_SYS(lstat), SCMP_SYS(fstat),
            SCMP_SYS(newfstatat),
#ifdef __NR_statx
            SCMP_SYS(statx),
#endif
            SCMP_SYS(access), SCMP_SYS(faccessat),
#ifdef __NR_faccessat2
            SCMP_SYS(faccessat2),
#endif
            SCMP_SYS(readlink), SCMP_SYS(readlinkat),
            SCMP_SYS(getdents), SCMP_SYS(getdents64),
            SCMP_SYS(lseek),
#ifdef __NR__llseek
            SCMP_SYS(_llseek),
#endif
            SCMP_SYS(fcntl), SCMP_SYS(ioctl),
            SCMP_SYS(dup), SCMP_SYS(dup2), SCMP_SYS(dup3),
            SCMP_SYS(pipe), SCMP_SYS(pipe2),
            SCMP_SYS(unlink), SCMP_SYS(unlinkat),
            SCMP_SYS(mkdir), SCMP_SYS(mkdirat), SCMP_SYS(rmdir),
            SCMP_SYS(rename), SCMP_SYS(renameat),
#ifdef __NR_renameat2
            SCMP_SYS(renameat2),
#endif
            SCMP_SYS(chmod), SCMP_SYS(fchmod), SCMP_SYS(fchmodat),
            SCMP_SYS(chown), SCMP_SYS(fchown), SCMP_SYS(fchownat),
            SCMP_SYS(umask),
            SCMP_SYS(truncate), SCMP_SYS(ftruncate),
            SCMP_SYS(fsync), SCMP_SYS(fdatasync),
            SCMP_SYS(sync), SCMP_SYS(syncfs),
            SCMP_SYS(readv), SCMP_SYS(writev),
            SCMP_SYS(pread64), SCMP_SYS(pwrite64),
            SCMP_SYS(preadv), SCMP_SYS(pwritev),
#ifdef __NR_close_range
            SCMP_SYS(close_range),
#endif
            SCMP_SYS(symlink), SCMP_SYS(symlinkat),
            SCMP_SYS(link), SCMP_SYS(linkat),
            SCMP_SYS(splice), SCMP_SYS(tee), SCMP_SYS(sendfile),
#ifdef __NR_copy_file_range
            SCMP_SYS(copy_file_range),
#endif
            SCMP_SYS(utimensat), SCMP_SYS(futimesat), SCMP_SYS(utimes),
#ifdef __NR_clock_adjtime
            /* clock_adjtime is in the denylist; do NOT add here. */
#endif
            SCMP_SYS(getcwd), SCMP_SYS(chdir), SCMP_SYS(fchdir),
            SCMP_SYS(rt_sigaction), SCMP_SYS(rt_sigprocmask),
            SCMP_SYS(rt_sigreturn), SCMP_SYS(rt_sigtimedwait),
            SCMP_SYS(rt_sigsuspend), SCMP_SYS(rt_sigpending),
            SCMP_SYS(rt_sigqueueinfo), SCMP_SYS(sigaltstack),

            /* Memory */
            SCMP_SYS(mmap),
#ifdef __NR_mmap2
            SCMP_SYS(mmap2),
#endif
            SCMP_SYS(munmap), SCMP_SYS(mprotect),
            SCMP_SYS(madvise), SCMP_SYS(brk),
            SCMP_SYS(mlock), SCMP_SYS(munlock), SCMP_SYS(mremap),
            SCMP_SYS(msync),

            /* Process */
            SCMP_SYS(clone),
#ifdef __NR_clone3
            SCMP_SYS(clone3),
#endif
            SCMP_SYS(fork), SCMP_SYS(vfork),
            SCMP_SYS(execve),
#ifdef __NR_execveat
            SCMP_SYS(execveat),
#endif
            SCMP_SYS(exit), SCMP_SYS(exit_group),
            SCMP_SYS(getpid), SCMP_SYS(getppid),
            SCMP_SYS(gettid),
            SCMP_SYS(getuid), SCMP_SYS(geteuid),
            SCMP_SYS(getgid), SCMP_SYS(getegid),
            SCMP_SYS(setuid), SCMP_SYS(setgid),
            SCMP_SYS(setresuid), SCMP_SYS(setresgid),
            SCMP_SYS(setgroups), SCMP_SYS(getgroups),
            SCMP_SYS(wait4), SCMP_SYS(waitid),
            SCMP_SYS(kill), SCMP_SYS(tgkill), SCMP_SYS(tkill),
            SCMP_SYS(getpgid), SCMP_SYS(setpgid),
            SCMP_SYS(getpgrp), SCMP_SYS(setsid), SCMP_SYS(getsid),
            SCMP_SYS(getrandom),
            SCMP_SYS(arch_prctl), SCMP_SYS(prctl),

            /* Sockets */
            SCMP_SYS(socket), SCMP_SYS(socketpair),
            SCMP_SYS(bind), SCMP_SYS(listen),
            SCMP_SYS(accept), SCMP_SYS(accept4),
            SCMP_SYS(connect),
            SCMP_SYS(getsockname), SCMP_SYS(getpeername),
            SCMP_SYS(getsockopt), SCMP_SYS(setsockopt),
            SCMP_SYS(send), SCMP_SYS(sendto), SCMP_SYS(sendmsg), SCMP_SYS(sendmmsg),
            SCMP_SYS(recv), SCMP_SYS(recvfrom), SCMP_SYS(recvmsg), SCMP_SYS(recvmmsg),
            SCMP_SYS(shutdown),

            /* Polling */
            SCMP_SYS(poll), SCMP_SYS(ppoll),
            SCMP_SYS(select), SCMP_SYS(pselect6),
            SCMP_SYS(epoll_create), SCMP_SYS(epoll_create1),
            SCMP_SYS(epoll_ctl), SCMP_SYS(epoll_wait), SCMP_SYS(epoll_pwait),
#ifdef __NR_epoll_pwait2
            SCMP_SYS(epoll_pwait2),
#endif
            SCMP_SYS(eventfd), SCMP_SYS(eventfd2),
            SCMP_SYS(timerfd_create), SCMP_SYS(timerfd_settime), SCMP_SYS(timerfd_gettime),
            SCMP_SYS(signalfd), SCMP_SYS(signalfd4),

            /* Time */
            SCMP_SYS(clock_gettime),
#ifdef __NR_clock_gettime64
            SCMP_SYS(clock_gettime64),
#endif
            SCMP_SYS(clock_nanosleep), SCMP_SYS(nanosleep),
            SCMP_SYS(gettimeofday), SCMP_SYS(time), SCMP_SYS(clock_getres),

            /* Threading sync */
            SCMP_SYS(futex),
#ifdef __NR_futex_waitv
            SCMP_SYS(futex_waitv),
#endif
            SCMP_SYS(set_robust_list), SCMP_SYS(get_robust_list),
            SCMP_SYS(set_tid_address),
            SCMP_SYS(sched_getaffinity), SCMP_SYS(sched_setaffinity),
            SCMP_SYS(sched_yield),
            SCMP_SYS(sched_get_priority_max), SCMP_SYS(sched_get_priority_min),

            /* Resource limits */
            SCMP_SYS(getrlimit), SCMP_SYS(setrlimit), SCMP_SYS(prlimit64),
            SCMP_SYS(getrusage),

            /* Misc */
            SCMP_SYS(uname), SCMP_SYS(sysinfo),
            SCMP_SYS(membarrier), SCMP_SYS(getcpu),
            SCMP_SYS(personality),
            SCMP_SYS(capget), SCMP_SYS(capset),
        };
        for (size_t i = 0; i < ARRAY_LEN(allowed_syscalls); i++) {
            int rc = seccomp_rule_add(ctx, SCMP_ACT_ALLOW,
                                      allowed_syscalls[i], 0);
            if (rc < 0 && rc != -EFAULT && rc != -EDOM) {
                fprintf(stderr,
                        "ellul-seccomp: failed to allow rule %zu: %s\n",
                        i, strerror(-rc));
                seccomp_release(ctx);
                return 1;
            }
            if (rc == 0) rules_added++;
        }
    } else {
        /* Original denylist mode — production default. */
        for (size_t i = 0; i < ARRAY_LEN(blocked_syscalls); i++) {
            int rc = seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM),
                                      blocked_syscalls[i], 0);
            if (rc < 0 && rc != -EFAULT) {
                fprintf(stderr, "ellul-seccomp: failed to add rule %zu: %s\n",
                        i, strerror(-rc));
                seccomp_release(ctx);
                return 1;
            }
            if (rc == 0) rules_added++;
        }
    }

    /* Load the filter into the kernel */
    int rc = seccomp_load(ctx);
    if (rc < 0) {
        fprintf(stderr, "ellul-seccomp: seccomp_load failed: %s\n",
                strerror(-rc));
        seccomp_release(ctx);
        return 1;
    }

    seccomp_release(ctx);

    /*
     * Marker on stderr so operators reading the bridge's stderrTail can see
     * "filter loaded, exec'ing target". If exit 133 happens AFTER this line,
     * the syscall denial was reached. If exit 133 happens WITHOUT this line,
     * the failure was upstream (namespace setup, runuser, etc.). The marker
     * is silent unless ELLUL_SECCOMP_VERBOSE is set, so it doesn't pollute
     * codex's stderr line classifier under normal operation.
     */
    if (getenv("ELLUL_SECCOMP_VERBOSE")) {
        fprintf(stderr,
                "ellul-seccomp: filter loaded mode=%s rules=%d kernelLog=%s exec=%s\n",
                allowlist_mode ? "allowlist" : "denylist",
                rules_added, log_rc == 0 ? "on" : "off", argv[1]);
    }

    /* exec the target command — seccomp filter is inherited */
    execvp(argv[1], &argv[1]);

    /* Only reached if exec fails */
    fprintf(stderr, "ellul-seccomp: exec %s failed: %s\n",
            argv[1], strerror(errno));
    return 127;
}
