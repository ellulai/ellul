/*
 * ellul-namespaced — peer authentication.
 *
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 ellul.ai. All rights reserved.
 */

#define _GNU_SOURCE

#include "auth.h"
#include "log.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#ifndef SO_PEERPIDFD
#define SO_PEERPIDFD 77
#endif

int nsd_auth_probe_kernel(void) {
    int sv[2];
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) != 0) {
        nsd_event("nsd.startup.kernel-too-old",
                  "reason", nsd_jstr("socketpair-failed"),
                  "errno", nsd_jnum(errno),
                  NULL);
        return -1;
    }
    int pidfd = -1;
    socklen_t len = sizeof(pidfd);
    int rc = getsockopt(sv[0], SOL_SOCKET, SO_PEERPIDFD, &pidfd, &len);
    int saved = errno;
    /* Even if it succeeded we want to close the resulting pidfd. */
    if (rc == 0 && pidfd >= 0) close(pidfd);
    close(sv[0]); close(sv[1]);

    if (rc != 0) {
        nsd_event("nsd.startup.kernel-too-old",
                  "reason", nsd_jstr("SO_PEERPIDFD-unsupported"),
                  "errno", nsd_jnum(saved),
                  NULL);
        return -1;
    }
    return 0;
}

/* /proc/self/fd/<pidfd> is anon_inode:[pidfd] on Linux 6.8 — path traversal
 * returns ENOTDIR. Read /proc/<pid>/cgroup directly. PID-reuse race is caught
 * by cgroup_is_bridge (reused PID outside bridge cgroup → deny) and by per-
 * message HMAC bound to the pidfd inode (fstat'd in caller). */
static int read_cgroup_for_peer(pid_t pid, char *out, size_t cap) {
    char path[64];
    snprintf(path, sizeof(path), "/proc/%d/cgroup", (int)pid);
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return -1;
    ssize_t got = 0, r;
    while ((size_t)got < cap - 1) {
        r = read(fd, out + got, cap - 1 - (size_t)got);
        if (r < 0) {
            if (errno == EINTR) continue;
            close(fd); return -1;
        }
        if (r == 0) break;
        got += r;
    }
    close(fd);
    out[got] = 0;
    return 0;
}

/*
 * Check that the cgroup-v2 line "0::<path>" contains
 * "/ellul-agent-bridge.service" as a path component:
 *   - exact suffix:   "/ellul-agent-bridge.service"
 *   - subscope match: "/ellul-agent-bridge.service/<sub>"
 *
 * The latter form arises when systemd KillMode=mixed (or sub-cgroup
 * delegation) puts forked children of the bridge inside a sub-scope of the
 * bridge's service cgroup. We accept both as "in the bridge" — anything
 * else fails.
 */
static bool cgroup_is_bridge(const char *cgroup) {
    const char *suffix = NSD_BRIDGE_CGROUP_SUFFIX;  /* "/ellul-agent-bridge.service" */
    size_t slen = strlen(suffix);
    const char *p = cgroup;
    while (*p) {
        if (p[0] == '0' && p[1] == ':' && p[2] == ':') {
            const char *q = p + 3;
            const char *eol = strchr(q, '\n');
            size_t qlen = eol ? (size_t)(eol - q) : strlen(q);
            for (size_t i = 0; i + slen <= qlen; i++) {
                if (memcmp(q + i, suffix, slen) != 0) continue;
                size_t after = i + slen;
                if (after == qlen || q[after] == '/') return true;
            }
        }
        const char *eol = strchr(p, '\n');
        if (!eol) break;
        p = eol + 1;
    }
    return false;
}

int nsd_auth_check(int fd, struct nsd_session *ses, uid_t expected_uid) {
    /* (1) SO_PEERCRED — fast UID gate. */
    struct ucred cred;
    socklen_t cl = sizeof(cred);
    if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &cred, &cl) != 0 ||
        cl != sizeof(cred)) {
        nsd_event("nsd.auth.deny",
                  "reason", nsd_jstr("peercred"),
                  "errno", nsd_jnum(errno),
                  NULL);
        return NSD_EAUTH;
    }
    if (cred.uid != expected_uid) {
        nsd_event("nsd.auth.deny",
                  "reason", nsd_jstr("uid-mismatch"),
                  "got_uid", nsd_jnum(cred.uid),
                  "expected_uid", nsd_jnum(expected_uid),
                  NULL);
        return NSD_EAUTH;
    }
    ses->peer_uid = cred.uid;
    ses->peer_gid = cred.gid;
    ses->peer_pid = cred.pid;

    /* (2) SO_PEERPIDFD — race-free pidfd. */
    int pidfd = -1;
    socklen_t pl = sizeof(pidfd);
    if (getsockopt(fd, SOL_SOCKET, SO_PEERPIDFD, &pidfd, &pl) != 0 || pidfd < 0) {
        nsd_event("nsd.auth.deny",
                  "reason", nsd_jstr("peerpidfd"),
                  "errno", nsd_jnum(errno),
                  NULL);
        return NSD_EAUTH;
    }

    /* Stash inode of the pidfd: it ties subsequent HMACs to *this* pidfd,
     * not to any future one. */
    struct stat sbf;
    if (fstat(pidfd, &sbf) != 0) {
        close(pidfd);
        nsd_event("nsd.auth.deny",
                  "reason", nsd_jstr("pidfd-fstat"),
                  "errno", nsd_jnum(errno),
                  NULL);
        return NSD_EAUTH;
    }
    ses->peer_pidfd = pidfd;
    ses->peer_pidfd_inode = (uint64_t)sbf.st_ino;

    /* (3) Cgroup check via /proc/<pid>/cgroup. */
    char cgroup[512];
    if (read_cgroup_for_peer(cred.pid, cgroup, sizeof(cgroup)) != 0) {
        nsd_event("nsd.auth.deny",
                  "reason", nsd_jstr("cgroup-read"),
                  "errno", nsd_jnum(errno),
                  NULL);
        return NSD_EAUTH;
    }
    if (!cgroup_is_bridge(cgroup)) {
        nsd_event("nsd.auth.deny",
                  "reason", nsd_jstr("cgroup-mismatch"),
                  "peer_pid", nsd_jnum(cred.pid),
                  NULL);
        return NSD_EAUTH;
    }

    ses->auth_passed = true;
    return NSD_OK;
}
