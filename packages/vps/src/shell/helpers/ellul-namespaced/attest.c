/*
 * ellul-namespaced — ATTEST handler.
 *
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 ellul.ai. All rights reserved.
 */

#define _GNU_SOURCE

#include "attest.h"
#include "log.h"
#include "mountinfo.h"

#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/uio.h>
#include <sys/wait.h>
#include <unistd.h>
#include <sodium.h>

#ifndef __NR_pidfd_open
#define __NR_pidfd_open 434
#endif
#ifndef __NR_pidfd_send_signal
#define __NR_pidfd_send_signal 424
#endif

static int sys_pidfd_open(pid_t pid, unsigned int flags) {
    return (int) syscall(__NR_pidfd_open, pid, flags);
}
static int sys_pidfd_send_signal(int pidfd, int sig, void *info, unsigned int flags) {
    return (int) syscall(__NR_pidfd_send_signal, pidfd, sig, info, flags);
}

/* ── Wire-format for child→parent ────────────────────────── */

#define ATTEST_PIPE_MAGIC 0x4E534441u  /* "NSDA" */

struct attest_pipe_hdr {
    uint32_t magic;
    uint8_t  matches;
    uint8_t  n_mismatches;
    uint8_t  reserved[2];
    uint8_t  mountinfo_digest[NSD_SHA256_BYTES];
    /* Followed by `n_mismatches` * NSD_MISMATCH_DESC_LEN bytes. */
};

/* ── Helpers ─────────────────────────────────────────────── */

static int read_anchor_pid(const char *project, pid_t *out_pid) {
    char path[256];
    snprintf(path, sizeof(path), "/run/.ns-%s/anchor.pid", project);
    int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return -1;
    struct stat sb;
    if (fstat(fd, &sb) != 0) { close(fd); return -1; }
    /* Must be a regular file, root-owned, no group/other write. */
    if (!S_ISREG(sb.st_mode) || sb.st_uid != 0 ||
        (sb.st_mode & (S_IWGRP | S_IWOTH)) != 0) {
        close(fd); errno = EPERM; return -1;
    }
    char buf[32] = {0};
    ssize_t r = read(fd, buf, sizeof(buf) - 1);
    close(fd);
    if (r <= 0) { errno = EIO; return -1; }
    char *end;
    long pid = strtol(buf, &end, 10);
    if (pid <= 0 || pid > (1L << 22)) { errno = ERANGE; return -1; }
    *out_pid = (pid_t)pid;
    return 0;
}

static int validate_anchor_cgroup(int pidfd, const char *project) {
    char path[64];
    snprintf(path, sizeof(path), "/proc/self/fd/%d/cgroup", pidfd);
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return -1;
    char buf[512] = {0};
    ssize_t total = 0, r;
    while (total < (ssize_t)sizeof(buf) - 1) {
        r = read(fd, buf + total, sizeof(buf) - 1 - (size_t)total);
        if (r < 0) { if (errno == EINTR) continue; close(fd); return -1; }
        if (r == 0) break;
        total += r;
    }
    close(fd);
    buf[total] = 0;

    /*
     * Anchor cgroup must contain
     *   "/ellul-namespaces.slice/ellul-ns-<project>.service"
     * as a path component (exact suffix or followed by `/`). Subscope
     * match is rare for an anchor but kept symmetric with auth.c.
     */
    char want[160];
    snprintf(want, sizeof(want), "%s%s.service", NSD_ANCHOR_CGROUP_PREFIX, project);
    size_t wlen = strlen(want);

    const char *p = buf;
    while (*p) {
        if (p[0] == '0' && p[1] == ':' && p[2] == ':') {
            const char *q = p + 3;
            const char *eol = strchr(q, '\n');
            size_t qlen = eol ? (size_t)(eol - q) : strlen(q);
            for (size_t i = 0; i + wlen <= qlen; i++) {
                if (memcmp(q + i, want, wlen) != 0) continue;
                size_t after = i + wlen;
                if (after == qlen || q[after] == '/') return 0;
            }
        }
        const char *eol = strchr(p, '\n');
        if (!eol) break;
        p = eol + 1;
    }
    errno = EPERM;
    return -1;
}

/* Determine whether observed `obs_options` (per-mount field 6 + super-options
 * concatenated) satisfy a manifest mount's `flags` and `options_required`. */
static bool options_satisfy(uint32_t flags,
                            const char (*opts_req)[NSD_MAX_OPTION_LEN],
                            size_t opts_req_n,
                            const char *obs_per_mount,
                            const char *obs_super) {
    if ((flags & NSD_MF_RO) &&
        !nsd_mountinfo_opt_has(obs_per_mount, "ro") &&
        !nsd_mountinfo_opt_has(obs_super, "ro")) return false;
    if ((flags & NSD_MF_NOSUID) && !nsd_mountinfo_opt_has(obs_per_mount, "nosuid")) return false;
    if ((flags & NSD_MF_NODEV)  && !nsd_mountinfo_opt_has(obs_per_mount, "nodev"))  return false;
    if ((flags & NSD_MF_NOEXEC) && !nsd_mountinfo_opt_has(obs_per_mount, "noexec")) return false;
    for (size_t i = 0; i < opts_req_n; i++) {
        if (!nsd_mountinfo_opt_has(obs_per_mount, opts_req[i]) &&
            !nsd_mountinfo_opt_has(obs_super, opts_req[i])) return false;
    }
    return true;
}

/* Count entries in a directory; returns -1 on error, else the count
 * (excluding "." and ".."). */
static long count_dirents(const char *path) {
    DIR *d = opendir(path);
    if (!d) return -1;
    long n = 0;
    struct dirent *e;
    while ((e = readdir(d)) != NULL) {
        if (e->d_name[0] == '.' &&
            (e->d_name[1] == 0 || (e->d_name[1] == '.' && e->d_name[2] == 0)))
            continue;
        n++;
        if (n > 65536) break;
    }
    closedir(d);
    return n;
}

/* Append a mismatch description to the result. */
static void push_mismatch(uint8_t *n, char (*arr)[NSD_MISMATCH_DESC_LEN],
                          const char *fmt, ...) {
    if (*n >= NSD_MAX_MISMATCHES_REPORTED) return;
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(arr[*n], NSD_MISMATCH_DESC_LEN, fmt, ap);
    va_end(ap);
    (*n)++;
}

/* ── Child: walks mountinfo, evaluates manifest ──────────── */

static int child_attest(int pidfd, const struct nsd_manifest *m,
                        const char *project, const char *home,
                        int write_pipe) {
    /* Join the anchor's mount NS. */
    if (setns(pidfd, CLONE_NEWNS) != 0) {
        return 1;
    }

    /* Read mountinfo from inside the joined NS. */
    struct nsd_mountinfo *mi = NULL;
    if (nsd_mountinfo_read_self(&mi) != 0) {
        return 2;
    }

    struct attest_pipe_hdr hdr;
    memset(&hdr, 0, sizeof(hdr));
    hdr.magic = ATTEST_PIPE_MAGIC;
    hdr.matches = 1;
    hdr.n_mismatches = 0;
    char mismatches[NSD_MAX_MISMATCHES_REPORTED][NSD_MISMATCH_DESC_LEN];

    /* mountinfo_digest: sha256 over canonicalised target||fstype lines. */
    crypto_hash_sha256_state ds;
    crypto_hash_sha256_init(&ds);
    for (size_t i = 0; i < mi->n_entries; i++) {
        const struct nsd_mountinfo_entry *e = &mi->entries[i];
        crypto_hash_sha256_update(&ds, (const unsigned char *)e->mount_point,
                                  strlen(e->mount_point));
        crypto_hash_sha256_update(&ds, (const unsigned char *)"\0", 1);
        crypto_hash_sha256_update(&ds, (const unsigned char *)e->fstype,
                                  strlen(e->fstype));
        crypto_hash_sha256_update(&ds, (const unsigned char *)"\n", 1);
    }
    crypto_hash_sha256_final(&ds, hdr.mountinfo_digest);

    /* Walk manifest mounts. */
    for (size_t i = 0; i < m->mounts_n; i++) {
        const struct nsd_manifest_mount *mm = &m->mounts[i];
        char target[NSD_MAX_PATH_TEMPLATE];
        if (nsd_manifest_substitute(mm->target_template, project, home,
                                    target, sizeof(target)) != 0) {
            push_mismatch(&hdr.n_mismatches, mismatches,
                          "[manifest %zu] template substitution failed: %s",
                          i, mm->target_template);
            hdr.matches = 0;
            continue;
        }
        const struct nsd_mountinfo_entry *obs = nsd_mountinfo_find(mi, target);
        if (!obs) {
            if (mm->mandatory) {
                push_mismatch(&hdr.n_mismatches, mismatches,
                              "missing-mount target=%s", target);
                hdr.matches = 0;
            }
            continue;
        }
        if (mm->has_fstype && strcmp(obs->fstype, mm->post_check_fstype) != 0) {
            push_mismatch(&hdr.n_mismatches, mismatches,
                          "fstype-mismatch target=%s expected=%s observed=%s",
                          target, mm->post_check_fstype, obs->fstype);
            hdr.matches = 0;
            continue;
        }
        if (!options_satisfy(mm->flags, mm->options_required,
                             mm->options_required_n,
                             obs->options, obs->super_options)) {
            push_mismatch(&hdr.n_mismatches, mismatches,
                          "options-mismatch target=%s flags=%u "
                          "options=[%s] super=[%s]",
                          target, mm->flags, obs->options, obs->super_options);
            hdr.matches = 0;
            continue;
        }
        if (mm->kind == NSD_MK_BIND && mm->has_source) {
            char src[NSD_MAX_PATH_TEMPLATE];
            if (nsd_manifest_substitute(mm->source_template, project, home,
                                        src, sizeof(src)) != 0) {
                push_mismatch(&hdr.n_mismatches, mismatches,
                              "bind-source-substitute-fail target=%s", target);
                hdr.matches = 0;
                continue;
            }
            /* mountinfo's source_field is sometimes the original device or
             * underlying file; for bind mounts it can be the source path or
             * a partial form. We accept either exact match or a "common
             * prefix" match; this is intentionally lenient because bind
             * mountinfo encoding varies across kernels. */
            if (strncmp(obs->source, src, strlen(src)) != 0 &&
                strcmp(obs->source, src) != 0) {
                push_mismatch(&hdr.n_mismatches, mismatches,
                              "bind-source-mismatch target=%s expected=%s observed=%s",
                              target, src, obs->source);
                hdr.matches = 0;
                continue;
            }
        }
        if (mm->kind == NSD_MK_BLACKHOLE && (mm->flags & NSD_MF_EMPTY)) {
            long n = count_dirents(target);
            if (n != 0) {
                push_mismatch(&hdr.n_mismatches, mismatches,
                              "blackhole-not-empty target=%s n=%ld", target, n);
                hdr.matches = 0;
                continue;
            }
        }
    }

    /* Write the header, then `n_mismatches` * NSD_MISMATCH_DESC_LEN bytes. */
    struct iovec iov[2] = {
        { .iov_base = &hdr, .iov_len = sizeof(hdr) },
        { .iov_base = mismatches, .iov_len = (size_t)hdr.n_mismatches * NSD_MISMATCH_DESC_LEN },
    };
    if (writev(write_pipe, iov, 2) < 0) {
        nsd_mountinfo_free(mi);
        return 3;
    }
    nsd_mountinfo_free(mi);
    return 0;
}

/* ── Parent: orchestrates the fork + waitpid ─────────────── */

int nsd_attest_run(const struct nsd_manifest *m,
                   const char *project,
                   const char *home,
                   struct nsd_attest_result *out) {
    memset(out, 0, sizeof(*out));

    pid_t anchor_pid;
    if (read_anchor_pid(project, &anchor_pid) != 0) {
        out->errcode = NSD_EANCHOR_DEAD;
        nsd_event("nsd.attest.unreachable",
                  "project", nsd_jstr(project),
                  "reason", nsd_jstr("anchor-pid-file"),
                  "errno", nsd_jnum(errno),
                  NULL);
        return -NSD_EANCHOR_DEAD;
    }

    int pidfd = sys_pidfd_open(anchor_pid, 0);
    if (pidfd < 0) {
        out->errcode = NSD_EANCHOR_DEAD;
        nsd_event("nsd.attest.unreachable",
                  "project", nsd_jstr(project),
                  "reason", nsd_jstr("pidfd_open"),
                  "errno", nsd_jnum(errno),
                  NULL);
        return -NSD_EANCHOR_DEAD;
    }

    /* Liveness check. */
    if (sys_pidfd_send_signal(pidfd, 0, NULL, 0) != 0) {
        out->errcode = NSD_EANCHOR_DEAD;
        nsd_event("nsd.attest.unreachable",
                  "project", nsd_jstr(project),
                  "reason", nsd_jstr("anchor-not-alive"),
                  "errno", nsd_jnum(errno),
                  NULL);
        close(pidfd);
        return -NSD_EANCHOR_DEAD;
    }
    out->anchor_alive = true;

    /* Validate cgroup membership: must be in
     * /ellul-namespaces.slice/ellul-ns-<project>.service. */
    if (validate_anchor_cgroup(pidfd, project) != 0) {
        out->errcode = NSD_EANCHOR_CGROUP;
        nsd_event("nsd.attest.unreachable",
                  "project", nsd_jstr(project),
                  "reason", nsd_jstr("anchor-cgroup-mismatch"),
                  NULL);
        close(pidfd);
        return -NSD_EANCHOR_CGROUP;
    }

    int pipefd[2];
    if (pipe2(pipefd, O_CLOEXEC) != 0) {
        out->errcode = NSD_EINTERNAL;
        nsd_event("nsd.attest.fail",
                  "project", nsd_jstr(project),
                  "reason", nsd_jstr("pipe2"),
                  "errno", nsd_jnum(errno),
                  NULL);
        close(pidfd);
        return -NSD_EINTERNAL;
    }

    pid_t child = fork();
    if (child < 0) {
        out->errcode = NSD_EINTERNAL;
        nsd_event("nsd.attest.fail",
                  "project", nsd_jstr(project),
                  "reason", nsd_jstr("fork"),
                  "errno", nsd_jnum(errno),
                  NULL);
        close(pipefd[0]); close(pipefd[1]); close(pidfd);
        return -NSD_EINTERNAL;
    }

    if (child == 0) {
        close(pipefd[0]);
        int rc = child_attest(pidfd, m, project, home, pipefd[1]);
        _exit(rc);
    }

    close(pipefd[1]);

    /* Read fixed-size header first, then trailing variable mismatches. */
    struct attest_pipe_hdr hdr = {0};
    ssize_t got = 0;
    while (got < (ssize_t)sizeof(hdr)) {
        ssize_t r = read(pipefd[0], (char *)&hdr + got,
                         sizeof(hdr) - (size_t)got);
        if (r < 0) {
            if (errno == EINTR) continue;
            break;
        }
        if (r == 0) break;
        got += r;
    }

    char mismatch_buf[NSD_MAX_MISMATCHES_REPORTED][NSD_MISMATCH_DESC_LEN];
    memset(mismatch_buf, 0, sizeof(mismatch_buf));
    if (got == (ssize_t)sizeof(hdr) && hdr.magic == ATTEST_PIPE_MAGIC &&
        hdr.n_mismatches <= NSD_MAX_MISMATCHES_REPORTED) {
        size_t want = (size_t)hdr.n_mismatches * NSD_MISMATCH_DESC_LEN;
        size_t mgot = 0;
        while (mgot < want) {
            ssize_t r = read(pipefd[0], (char *)mismatch_buf + mgot, want - mgot);
            if (r < 0) {
                if (errno == EINTR) continue;
                break;
            }
            if (r == 0) break;
            mgot += (size_t)r;
        }
    }
    close(pipefd[0]);
    close(pidfd);

    int wstatus = 0;
    waitpid(child, &wstatus, 0);

    if (got != (ssize_t)sizeof(hdr) || hdr.magic != ATTEST_PIPE_MAGIC) {
        out->errcode = NSD_EATTEST_MISMATCH;
        nsd_event("nsd.attest.fail",
                  "project", nsd_jstr(project),
                  "reason", nsd_jstr("child-no-result"),
                  "child_exit", nsd_jnum(WIFEXITED(wstatus) ? WEXITSTATUS(wstatus) : -1),
                  "child_signal", nsd_jnum(WIFSIGNALED(wstatus) ? WTERMSIG(wstatus) : 0),
                  NULL);
        return -NSD_EATTEST_MISMATCH;
    }

    out->success = true;
    out->matches = hdr.matches != 0;
    out->n_mismatches = hdr.n_mismatches;
    memcpy(out->mountinfo_digest, hdr.mountinfo_digest, NSD_SHA256_BYTES);
    for (size_t i = 0; i < out->n_mismatches; i++) {
        memcpy(out->mismatches[i], mismatch_buf[i], NSD_MISMATCH_DESC_LEN);
        out->mismatches[i][NSD_MISMATCH_DESC_LEN - 1] = 0;
    }

    if (out->matches) {
        nsd_event("nsd.attest.ok",
                  "project", nsd_jstr(project),
                  "mountinfo_digest", nsd_jbytes_hex(out->mountinfo_digest, NSD_SHA256_BYTES),
                  NULL);
    } else {
        nsd_event("nsd.attest.mismatch",
                  "project", nsd_jstr(project),
                  "n_mismatches", nsd_jnum((long long)out->n_mismatches),
                  "first", nsd_jstr(out->n_mismatches > 0 ? out->mismatches[0] : ""),
                  "mountinfo_digest", nsd_jbytes_hex(out->mountinfo_digest, NSD_SHA256_BYTES),
                  NULL);
    }
    return 0;
}
