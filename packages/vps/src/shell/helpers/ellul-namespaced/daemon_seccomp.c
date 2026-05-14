/*
 * ellul-namespaced — daemon's own seccomp filter.
 *
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 ellul.ai. All rights reserved.
 */

#define _GNU_SOURCE

#include "daemon_seccomp.h"
#include "log.h"

#include <errno.h>
#include <seccomp.h>
#include <string.h>

/*
 * Allowlist of syscalls the daemon makes. Grouped by purpose. If a future
 * change adds a syscall, it goes here — the deny-by-default policy will
 * SIGSYS otherwise and the failure surfaces during testing, not in prod.
 */
static const int nsd_allowed[] = {
    /* Process / threading */
    SCMP_SYS(read), SCMP_SYS(write), SCMP_SYS(close), SCMP_SYS(exit),
    SCMP_SYS(exit_group), SCMP_SYS(getpid), SCMP_SYS(getppid),
    SCMP_SYS(gettid), SCMP_SYS(getuid), SCMP_SYS(geteuid),
    SCMP_SYS(getgid), SCMP_SYS(getegid),
    SCMP_SYS(rt_sigaction), SCMP_SYS(rt_sigprocmask), SCMP_SYS(rt_sigreturn),
    SCMP_SYS(rt_sigtimedwait), SCMP_SYS(rt_sigsuspend),
    SCMP_SYS(set_robust_list), SCMP_SYS(get_robust_list),
    SCMP_SYS(set_tid_address), SCMP_SYS(prctl),
    SCMP_SYS(arch_prctl), SCMP_SYS(getrandom),
    /* glibc >= 2.35 calls rseq() on every new pthread; missing it SIGSYSes the worker before user code runs. */
    SCMP_SYS(sigaltstack),
#ifdef __NR_rseq
    SCMP_SYS(rseq),
#endif
#ifdef __NR_clone3
    SCMP_SYS(clone3),
#endif
    SCMP_SYS(clone), SCMP_SYS(fork), SCMP_SYS(vfork),
    SCMP_SYS(wait4), SCMP_SYS(waitid),
    SCMP_SYS(kill), SCMP_SYS(tgkill),
    /* execve / execveat — ops.c forks ellul-agent-namespace. The daemon's
     * seccomp filter inherits to forked children, so the child needs
     * execve to run the helper binary. NoNewPrivileges=true on the unit
     * prevents setuid escalation. */
    SCMP_SYS(execve),
#ifdef __NR_execveat
    SCMP_SYS(execveat),
#endif
    SCMP_SYS(setsid),

    /* File I/O */
    SCMP_SYS(open), SCMP_SYS(openat),
#ifdef __NR_memfd_create
    /* BYOK_UNWRAP creates a sealed memfd to hand plaintext back to the
     * bridge via SCM_RIGHTS. fcntl(F_ADD_SEALS) is already covered by
     * the generic fcntl allowlist below. */
    SCMP_SYS(memfd_create),
#endif
#ifdef __NR_openat2
    SCMP_SYS(openat2),
#endif
    SCMP_SYS(stat), SCMP_SYS(lstat), SCMP_SYS(fstat),
#ifdef __NR_statx
    SCMP_SYS(statx),
#endif
    SCMP_SYS(newfstatat), SCMP_SYS(access), SCMP_SYS(faccessat),
#ifdef __NR_faccessat2
    SCMP_SYS(faccessat2),
#endif
    SCMP_SYS(readlink), SCMP_SYS(readlinkat),
    SCMP_SYS(getdents64), SCMP_SYS(getdents),
    SCMP_SYS(lseek), SCMP_SYS(_llseek),
    SCMP_SYS(fcntl), SCMP_SYS(ioctl),
    SCMP_SYS(dup), SCMP_SYS(dup2), SCMP_SYS(dup3),
    SCMP_SYS(pipe), SCMP_SYS(pipe2),
    SCMP_SYS(unlink), SCMP_SYS(unlinkat),
    SCMP_SYS(mkdir), SCMP_SYS(mkdirat),
    SCMP_SYS(rmdir),
    SCMP_SYS(rename), SCMP_SYS(renameat), SCMP_SYS(renameat2),
    SCMP_SYS(chmod), SCMP_SYS(fchmod), SCMP_SYS(fchmodat),
    SCMP_SYS(chown), SCMP_SYS(fchown), SCMP_SYS(fchownat),
    SCMP_SYS(umask),
    SCMP_SYS(ftruncate),
    SCMP_SYS(sync_file_range), SCMP_SYS(fdatasync), SCMP_SYS(fsync),
    SCMP_SYS(readv), SCMP_SYS(writev), SCMP_SYS(pread64), SCMP_SYS(pwrite64),
    SCMP_SYS(close_range),

    /* Memory */
    SCMP_SYS(mmap), SCMP_SYS(mmap2),
    SCMP_SYS(munmap), SCMP_SYS(mprotect), SCMP_SYS(brk), SCMP_SYS(madvise),
    SCMP_SYS(mlock), SCMP_SYS(munlock), SCMP_SYS(mremap),

    /* Sockets — AF_UNIX only is enforced via systemd RestrictAddressFamilies. */
    SCMP_SYS(socket), SCMP_SYS(socketpair),
    SCMP_SYS(bind), SCMP_SYS(listen), SCMP_SYS(accept), SCMP_SYS(accept4),
    SCMP_SYS(connect), SCMP_SYS(getsockname), SCMP_SYS(getpeername),
    SCMP_SYS(getsockopt), SCMP_SYS(setsockopt),
    SCMP_SYS(send), SCMP_SYS(sendto), SCMP_SYS(sendmsg), SCMP_SYS(sendmmsg),
    SCMP_SYS(recv), SCMP_SYS(recvfrom), SCMP_SYS(recvmsg), SCMP_SYS(recvmmsg),
    SCMP_SYS(shutdown),

    /* Polling / events */
    SCMP_SYS(poll), SCMP_SYS(ppoll),
    SCMP_SYS(select), SCMP_SYS(pselect6),
    SCMP_SYS(epoll_create1), SCMP_SYS(epoll_ctl), SCMP_SYS(epoll_wait),
    SCMP_SYS(epoll_pwait), SCMP_SYS(eventfd2),
    SCMP_SYS(timerfd_create), SCMP_SYS(timerfd_settime), SCMP_SYS(timerfd_gettime),
    SCMP_SYS(signalfd4),

    /* Time */
    SCMP_SYS(clock_gettime), SCMP_SYS(clock_gettime64),
    SCMP_SYS(clock_nanosleep), SCMP_SYS(nanosleep),
    SCMP_SYS(gettimeofday), SCMP_SYS(time),

    /* Threading sync */
    SCMP_SYS(futex),
#ifdef __NR_futex_waitv
    SCMP_SYS(futex_waitv),
#endif

    /* Namespace ops — ENTER/SETUP/INJECT_ENV exercise setns / unshare /
     * mount-related calls; allowlisting them explicitly so future filter
     * bumps don't surprise the cutover path. */
    SCMP_SYS(setns),
    SCMP_SYS(unshare),
    SCMP_SYS(mount), SCMP_SYS(umount2),
    SCMP_SYS(pivot_root),
#ifdef __NR_mount_setattr
    SCMP_SYS(mount_setattr),
#endif
#ifdef __NR_open_tree
    SCMP_SYS(open_tree),
#endif
#ifdef __NR_move_mount
    SCMP_SYS(move_mount),
#endif
#ifdef __NR_fsopen
    SCMP_SYS(fsopen),
#endif
#ifdef __NR_fsconfig
    SCMP_SYS(fsconfig),
#endif
#ifdef __NR_fsmount
    SCMP_SYS(fsmount),
#endif

    /* Pidfd */
#ifdef __NR_pidfd_open
    SCMP_SYS(pidfd_open),
#endif
#ifdef __NR_pidfd_send_signal
    SCMP_SYS(pidfd_send_signal),
#endif

    /* User/credential management — needed for setresuid/setresgid */
    SCMP_SYS(setresuid), SCMP_SYS(setresgid),
    SCMP_SYS(setuid), SCMP_SYS(setgid),
    SCMP_SYS(setgroups), SCMP_SYS(getgroups),

    /* Resource limits */
    SCMP_SYS(getrlimit), SCMP_SYS(prlimit64),
    SCMP_SYS(getrusage),

    /* Capabilities */
    SCMP_SYS(capget), SCMP_SYS(capset),

    /* Misc */
    SCMP_SYS(uname), SCMP_SYS(sysinfo),
    SCMP_SYS(sched_getaffinity), SCMP_SYS(sched_setaffinity),
    SCMP_SYS(sched_yield),
    SCMP_SYS(membarrier),
};

/* Explicitly denied syscalls — even if they slip through a libc growth, they
 * SIGSYS. We don't include "unknown" syscalls; deny-by-default already covers
 * those. The list below is for syscalls that show up in seccomp's allowlist
 * helpers (e.g. SCMP_SYS(ptrace)) and we want a hard denial for. */
static const int nsd_denied[] = {
    SCMP_SYS(ptrace),
#ifdef __NR_process_vm_readv
    SCMP_SYS(process_vm_readv),
#endif
#ifdef __NR_process_vm_writev
    SCMP_SYS(process_vm_writev),
#endif
#ifdef __NR_pidfd_getfd
    SCMP_SYS(pidfd_getfd),
#endif
    SCMP_SYS(init_module), SCMP_SYS(finit_module), SCMP_SYS(delete_module),
    SCMP_SYS(reboot), SCMP_SYS(kexec_load),
#ifdef __NR_kexec_file_load
    SCMP_SYS(kexec_file_load),
#endif
    SCMP_SYS(swapon), SCMP_SYS(swapoff),
    SCMP_SYS(add_key), SCMP_SYS(request_key), SCMP_SYS(keyctl),
#ifdef __NR_userfaultfd
    SCMP_SYS(userfaultfd),
#endif
#ifdef __NR_io_uring_setup
    SCMP_SYS(io_uring_setup),
#endif
#ifdef __NR_io_uring_enter
    SCMP_SYS(io_uring_enter),
#endif
#ifdef __NR_io_uring_register
    SCMP_SYS(io_uring_register),
#endif
#ifdef __NR_vmsplice
    SCMP_SYS(vmsplice),
#endif
    SCMP_SYS(perf_event_open),
};

int nsd_daemon_seccomp_install(void) {
    /* Default: SIGSYS — kills the process. Privileged daemon issuing an
     * un-allowlisted syscall is a bug; we want a clean crash and a coredump
     * (LimitCORE=0 in the unit, so it's a clean exit). */
    scmp_filter_ctx ctx = seccomp_init(SCMP_ACT_KILL_PROCESS);
    if (!ctx) {
        nsd_event("nsd.seccomp.init-fail", NULL);
        return -1;
    }

    int rc = seccomp_attr_set(ctx, SCMP_FLTATR_CTL_LOG, 1);
    (void) rc;

    for (size_t i = 0; i < sizeof(nsd_allowed) / sizeof(*nsd_allowed); i++) {
        int r = seccomp_rule_add(ctx, SCMP_ACT_ALLOW, nsd_allowed[i], 0);
        /* -EFAULT/-EDOM on syscalls not present on this arch → skip. */
        if (r < 0 && r != -EFAULT && r != -EDOM) {
            nsd_event("nsd.seccomp.rule-add-fail",
                      "syscall_idx", nsd_jnum((long long)i),
                      "rc", nsd_jnum(r),
                      NULL);
            seccomp_release(ctx);
            return -1;
        }
    }
    /* Belt-and-suspenders: the deny list is redundant under SCMP_ACT_KILL_PROCESS
     * default, but adding explicit ERRNO entries gives us audit trail under
     * SCMP_FLTATR_CTL_LOG without a SIGSYS — useful in dev. */
    for (size_t i = 0; i < sizeof(nsd_denied) / sizeof(*nsd_denied); i++) {
        int r = seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), nsd_denied[i], 0);
        if (r < 0 && r != -EFAULT && r != -EDOM) {
            /* Non-fatal; the default action handles it. */
            continue;
        }
    }

    if (seccomp_load(ctx) != 0) {
        nsd_event("nsd.seccomp.load-fail", "errno", nsd_jnum(errno), NULL);
        seccomp_release(ctx);
        return -1;
    }
    seccomp_release(ctx);
    nsd_event("nsd.seccomp.loaded",
              "allowlist_n", nsd_jnum((long long)(sizeof(nsd_allowed) / sizeof(*nsd_allowed))),
              NULL);
    return 0;
}
