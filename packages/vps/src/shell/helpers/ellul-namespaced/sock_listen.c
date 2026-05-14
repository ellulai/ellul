/*
 * ellul-namespaced — unix socket listeners.
 *
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 ellul.ai. All rights reserved.
 */

#define _GNU_SOURCE

#include "sock_listen.h"
#include "log.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>

/* Validate a project slug strictly: ^sbx-[a-z0-9]{7}$, exactly 11 chars. */
static int slug_ok(const char *slug) {
    if (!slug) return 0;
    if (strlen(slug) != NSD_PROJECT_SLUG_LEN) return 0;
    if (strncmp(slug, "sbx-", 4) != 0) return 0;
    for (int i = 4; i < NSD_PROJECT_SLUG_LEN; i++) {
        char c = slug[i];
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'))) return 0;
    }
    return 1;
}

int nsd_sock_ensure_run_dir(gid_t ns_gid) {
    /* mkdir is idempotent: if it already exists, we still chown/chmod to the
     * target shape. */
    if (mkdir(NSD_RUN_DIR, 0750) != 0 && errno != EEXIST) {
        nsd_event("nsd.sock.run-dir.mkdir-fail", "errno", nsd_jnum(errno), NULL);
        return -1;
    }
    if (chown(NSD_RUN_DIR, 0, ns_gid) != 0) {
        nsd_event("nsd.sock.run-dir.chown-fail", "errno", nsd_jnum(errno), NULL);
        return -1;
    }
    if (chmod(NSD_RUN_DIR, 0750) != 0) {
        nsd_event("nsd.sock.run-dir.chmod-fail", "errno", nsd_jnum(errno), NULL);
        return -1;
    }
    return 0;
}

/*
 * Atomic-bind helper. Steps:
 *   1. unlink any prior socket (stale daemon shutdown left it)
 *   2. socket() with SOCK_CLOEXEC
 *   3. bind() to a temp name, chmod, chown, then rename to final name
 *      so an attacker can never observe a partially-permissioned socket.
 *
 * `dir` and `final_name` describe the absolute socket path: dir/<final_name>.
 * The bind path must fit in sun_path (108 bytes).
 */
static int bind_atomic(const char *dir, const char *final_name, mode_t mode,
                       uid_t uid, gid_t gid) {
    char tmp_path[sizeof(((struct sockaddr_un*)0)->sun_path)];
    char fin_path[sizeof(((struct sockaddr_un*)0)->sun_path)];
    if ((size_t)snprintf(fin_path, sizeof(fin_path), "%s/%s", dir, final_name)
        >= sizeof(fin_path)) {
        errno = ENAMETOOLONG; return -1;
    }
    if ((size_t)snprintf(tmp_path, sizeof(tmp_path), "%s/.tmp-%s-%d", dir,
                         final_name, (int)getpid()) >= sizeof(tmp_path)) {
        errno = ENAMETOOLONG; return -1;
    }

    /* Stale path cleanup — both temp and final. */
    (void) unlink(tmp_path);
    (void) unlink(fin_path);

    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
    if (fd < 0) return -1;

    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, tmp_path, sizeof(addr.sun_path) - 1);

    /* umask 0 during bind so the socket inode permissions come from chmod. */
    mode_t old_umask = umask(0);
    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        umask(old_umask); close(fd); return -1;
    }
    umask(old_umask);

    if (chmod(tmp_path, mode) != 0) { close(fd); unlink(tmp_path); return -1; }
    if (chown(tmp_path, uid, gid) != 0) { close(fd); unlink(tmp_path); return -1; }

    if (listen(fd, 64) != 0) { close(fd); unlink(tmp_path); return -1; }

    /* rename(2) is atomic on a single filesystem. */
    if (rename(tmp_path, fin_path) != 0) { close(fd); unlink(tmp_path); return -1; }

    return fd;
}

int nsd_sock_bind_admin(gid_t ns_gid) {
    int fd = bind_atomic(NSD_RUN_DIR, "admin.sock", 0660, 0, ns_gid);
    if (fd < 0) {
        nsd_event("nsd.sock.admin.bind-fail", "errno", nsd_jnum(errno), NULL);
        return -1;
    }
    nsd_event("nsd.sock.admin.bind-ok", "fd", nsd_jnum(fd), NULL);
    return fd;
}

int nsd_sock_bind_project(const char *project, gid_t ns_gid) {
    if (!slug_ok(project)) { errno = EINVAL; return -1; }

    char dir[256];
    snprintf(dir, sizeof(dir), "%s/%s", NSD_RUN_DIR, project);

    /* Project subdir: 0700 root:root — agent-bridge cannot stat the socket
     * inode unless explicitly granted. */
    if (mkdir(dir, 0700) != 0 && errno != EEXIST) {
        nsd_event("nsd.sock.proj.mkdir-fail",
                  "project", nsd_jstr(project),
                  "errno", nsd_jnum(errno),
                  NULL);
        return -1;
    }
    if (chown(dir, 0, 0) != 0 || chmod(dir, 0700) != 0) {
        nsd_event("nsd.sock.proj.dir-perms-fail",
                  "project", nsd_jstr(project),
                  "errno", nsd_jnum(errno),
                  NULL);
        return -1;
    }

    int fd = bind_atomic(dir, "ctl.sock", 0660, 0, ns_gid);
    if (fd < 0) {
        nsd_event("nsd.sock.proj.bind-fail",
                  "project", nsd_jstr(project),
                  "errno", nsd_jnum(errno),
                  NULL);
        return -1;
    }
    /* After socket bind, loosen dir mode to 0710 root:ellul-ns so bridge can
     * traverse the subdir to reach the socket but cannot list its contents.
     * connect() needs +x on the parent directory, not +r. */
    if (chown(dir, 0, ns_gid) != 0 || chmod(dir, 0710) != 0) {
        close(fd); nsd_sock_unlink_project(project); return -1;
    }
    nsd_event("nsd.sock.proj.bind-ok",
              "project", nsd_jstr(project),
              "fd", nsd_jnum(fd),
              NULL);
    return fd;
}

void nsd_sock_unlink_project(const char *project) {
    if (!slug_ok(project)) return;
    char path[256];
    snprintf(path, sizeof(path), "%s/%s/ctl.sock", NSD_RUN_DIR, project);
    (void) unlink(path);
    snprintf(path, sizeof(path), "%s/%s", NSD_RUN_DIR, project);
    (void) rmdir(path);
}
