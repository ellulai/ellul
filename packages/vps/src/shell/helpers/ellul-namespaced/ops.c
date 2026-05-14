/*
 * ellul-namespaced — operational handlers (SETUP / TEARDOWN /
 * CREATE_PROJECT / DROP_PROJECT).
 *
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 ellul.ai. All rights reserved.
 */

#define _GNU_SOURCE

#include "ops.h"
#include "byok.h"
#include "daemon_subexec.h"
#include "log.h"
#include "mount_stage.h"
#include "sock_listen.h"

#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <pwd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define NSD_AGENT_NAMESPACE_BIN "/usr/local/bin/ellul-agent-namespace"
#define NSD_OPS_TIMEOUT_S        180

static pthread_mutex_t g_projects_mu = PTHREAD_MUTEX_INITIALIZER;

static bool slug_ok(const char *slug) {
    if (!slug) return false;
    if (strlen(slug) != NSD_PROJECT_SLUG_LEN) return false;
    if (strncmp(slug, "sbx-", 4) != 0) return false;
    for (int i = 4; i < NSD_PROJECT_SLUG_LEN; i++) {
        char c = slug[i];
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'))) return false;
    }
    return true;
}

static int load_svc_identity(char user[32], uid_t *uid, gid_t *gid,
                             char home[64]) {
    strcpy(user, "dev");
    int fd = open(NSD_DEFAULT_DEFAULTS, O_RDONLY | O_CLOEXEC);
    if (fd >= 0) {
        char buf[512] = {0};
        ssize_t r = read(fd, buf, sizeof(buf) - 1);
        close(fd);
        if (r > 0) {
            char *line = buf;
            while (line < buf + r) {
                char *eol = strchr(line, '\n');
                if (eol) *eol = 0;
                if (strncmp(line, "PS_USER=", 8) == 0) {
                    const char *v = line + 8;
                    if (*v == '"' || *v == '\'') v++;
                    size_t i = 0;
                    while (*v && *v != '"' && *v != '\'' && *v != ' ' &&
                           *v != '\n' && i + 1 < 32) {
                        user[i++] = *v++;
                    }
                    user[i] = 0;
                    break;
                }
                if (!eol) break;
                line = eol + 1;
            }
        }
    }
    struct passwd *pw = getpwnam(user);
    if (!pw) return -1;
    *uid = pw->pw_uid;
    *gid = pw->pw_gid;
    snprintf(home, 64, "%s", pw->pw_dir ? pw->pw_dir : "/home");
    return 0;
}

/* ── SETUP ───────────────────────────────────────────────── */

int nsd_ops_setup(const char *project,
                  const struct nsd_setup_request *req,
                  struct nsd_setup_result *out) {
    memset(out, 0, sizeof(*out));
    if (!slug_ok(project)) { out->errcode = NSD_EPROTO; return -NSD_EPROTO; }

    char user[32], home[64];
    uid_t uid; gid_t gid;
    if (load_svc_identity(user, &uid, &gid, home) != 0) {
        out->errcode = NSD_EINTERNAL;
        return -NSD_EINTERNAL;
    }

    struct nsd_mount_stage_input in = {
        .project         = project,
        .home            = home,
        .svc_user        = user,
        .svc_uid         = uid,
        .svc_gid         = gid,
        .shared_projects = req->shared_projects,
        .shared_previews = req->shared_previews,
        .shared_ports    = req->shared_ports,
        .byok            = (access("/etc/ellul/shield-data/.byok-active",
                                   F_OK) == 0),
    };
    struct nsd_mount_stage_result r = {0};
    int rc = nsd_mount_stage_run(&in, &r);
    if (rc != 0 || !r.success) {
        out->errcode = r.errcode ? r.errcode : NSD_ESTAGE_FAILED;
        snprintf(out->stderr_tail, sizeof(out->stderr_tail),
                 "phase=%s err=%s", r.phase_tail, r.err_tail);
        nsd_event("nsd.setup.fail",
                  "project", nsd_jstr(project),
                  "phase", nsd_jstr(r.phase_tail),
                  "errcode", nsd_jnum(out->errcode),
                  "err", nsd_jstr(r.err_tail),
                  NULL);
        return 0;
    }

    out->success    = true;
    out->anchor_pid = r.anchor_pid;
    out->errcode    = NSD_OK;
    snprintf(out->unit_name, sizeof(out->unit_name), "%s", r.unit_name);
    nsd_event("nsd.setup.ok",
              "project", nsd_jstr(project),
              "anchor_pid", nsd_jnum(r.anchor_pid),
              "unit", nsd_jstr(r.unit_name),
              NULL);
    return 0;
}

/* ── TEARDOWN ────────────────────────────────────────────── */

int nsd_ops_teardown(const char *project,
                     struct nsd_teardown_result *out) {
    memset(out, 0, sizeof(*out));
    if (!slug_ok(project)) { out->errcode = NSD_EPROTO; return -NSD_EPROTO; }

    char *argv[] = {
        (char *)NSD_AGENT_NAMESPACE_BIN,
        (char *)"teardown",
        (char *)project,
        NULL
    };

    nsd_phase("nsd-teardown", project, "exec", "begin", NULL);

    /* Route through the pre-seccomp subexec helper — teardown calls
     * systemctl, iptables, ip, and bash, all of which use syscalls
     * outside the daemon's seccomp allowlist. Setup already runs
     * through subexec via mount_stage; teardown must do the same. */
    size_t errlen = 0;
    int exit_status = -1, signal_status = 0;
    int rc = nsd_subexec_run(NSD_AGENT_NAMESPACE_BIN, argv,
                             NULL, 0,
                             out->stderr_tail, sizeof(out->stderr_tail),
                             &errlen, &exit_status, &signal_status);
    if (rc != 0) {
        out->errcode = NSD_EINTERNAL;
        return -NSD_EINTERNAL;
    }

    int exit_code = signal_status > 0 ? -signal_status : exit_status;
    out->success = exit_status == 0 && signal_status == 0;
    out->errcode = out->success ? NSD_OK : NSD_ESTAGE_FAILED;

    if (out->success) {
        nsd_event("nsd.teardown.ok", "project", nsd_jstr(project), NULL);
    } else {
        nsd_event("nsd.teardown.fail",
                  "project", nsd_jstr(project),
                  "exit_code", nsd_jnum(exit_code),
                  "stderr_tail", nsd_jstr(out->stderr_tail),
                  NULL);
    }
    return 0;
}

/* ── Admin: CREATE_PROJECT / DROP_PROJECT ────────────────── */

/* Forward-declared accessors for the projects[] array. We define them
 * here as helpers; main.c exposes the underlying state and each helper
 * acquires g_projects_mu around its mutation. */
extern struct nsd_project *nsd_state_projects(struct nsd_state *st);
extern size_t              nsd_state_n_projects(const struct nsd_state *st);
extern void                nsd_state_set_n_projects(struct nsd_state *st, size_t n);
extern gid_t               nsd_state_ns_gid(const struct nsd_state *st);

static struct nsd_project *find_project(struct nsd_project *arr, size_t n,
                                         const char *slug) {
    for (size_t i = 0; i < n; i++) {
        if (strcmp(arr[i].slug, slug) == 0) return &arr[i];
    }
    return NULL;
}

int nsd_ops_create_project(struct nsd_state *st, const char *project) {
    if (!slug_ok(project)) return NSD_EPROTO;
    int rc = NSD_OK;
    pthread_mutex_lock(&g_projects_mu);
    struct nsd_project *arr = nsd_state_projects(st);
    size_t n = nsd_state_n_projects(st);
    struct nsd_project *existing = find_project(arr, n, project);
    if (existing) {
        /* Idempotent: socket already bound. */
        pthread_mutex_unlock(&g_projects_mu);
        return NSD_OK;
    }
    if (n >= NSD_MAX_PROJECTS) {
        pthread_mutex_unlock(&g_projects_mu);
        return NSD_EINTERNAL;
    }
    int lfd = nsd_sock_bind_project(project, nsd_state_ns_gid(st));
    if (lfd < 0) {
        rc = NSD_EINTERNAL;
        nsd_event("nsd.admin.create-fail",
                  "project", nsd_jstr(project),
                  "errno", nsd_jnum(errno),
                  NULL);
        pthread_mutex_unlock(&g_projects_mu);
        return rc;
    }
    /* Provision the per-project BYOK secret BEFORE registering the
     * project. If the secret write fails, abort cleanly so we don't
     * end up with a project the bridge can attest but cannot wrap
     * keys for. Idempotent on re-create — preserves existing secret. */
    int byok_rc = nsd_byok_provision_project(project);
    if (byok_rc != NSD_OK) {
        close(lfd);
        nsd_sock_unlink_project(project);
        pthread_mutex_unlock(&g_projects_mu);
        nsd_event("nsd.admin.create-fail",
                  "project", nsd_jstr(project),
                  "stage", nsd_jstr("byok-secret"),
                  "errcode", nsd_jnum(byok_rc),
                  NULL);
        return byok_rc;
    }
    struct nsd_project *p = &arr[n];
    memset(p, 0, sizeof(*p));
    snprintf(p->slug, sizeof(p->slug), "%s", project);
    p->listen_fd = lfd;
    nsd_state_set_n_projects(st, n + 1);
    nsd_event("nsd.admin.create-ok",
              "project", nsd_jstr(project),
              "fd", nsd_jnum(lfd),
              NULL);
    pthread_mutex_unlock(&g_projects_mu);
    return rc;
}

int nsd_ops_drop_project(struct nsd_state *st, const char *project) {
    if (!slug_ok(project)) return NSD_EPROTO;

    /* BYOK revocation invariant: unlink /var/lib/ellul/byok/<slug>/secret
     * BEFORE any other teardown. A partial drop that crashes mid-flow
     * still revoked every ciphertext wrapped under this project's
     * secret. The reverse order would leave a window where an attacker
     * who races teardown could re-derive the subkey. Run outside the
     * projects mutex so a stuck filesystem doesn't deadlock the admin
     * socket — the secret revocation is independent of the in-memory
     * projects[] state. */
    int byok_rc = nsd_byok_drop_project(project);
    if (byok_rc != NSD_OK) {
        nsd_event("nsd.admin.drop-fail",
                  "project", nsd_jstr(project),
                  "stage", nsd_jstr("byok-secret"),
                  "errcode", nsd_jnum(byok_rc),
                  NULL);
        /* Continue with socket teardown even on byok failure: the
         * partial-drop fail-mode (secret unlinked, dir not removed)
         * is still a successful revocation. EPROTO from a malformed
         * slug never reaches here — slug_ok above catches it. */
    }

    pthread_mutex_lock(&g_projects_mu);
    struct nsd_project *arr = nsd_state_projects(st);
    size_t n = nsd_state_n_projects(st);
    size_t found = SIZE_MAX;
    for (size_t i = 0; i < n; i++) {
        if (strcmp(arr[i].slug, project) == 0) { found = i; break; }
    }
    if (found == SIZE_MAX) {
        /* Idempotent: not present. */
        pthread_mutex_unlock(&g_projects_mu);
        return NSD_OK;
    }
    if (arr[found].listen_fd >= 0) close(arr[found].listen_fd);
    nsd_sock_unlink_project(project);
    /* Compact the array. */
    for (size_t i = found; i + 1 < n; i++) arr[i] = arr[i + 1];
    nsd_state_set_n_projects(st, n - 1);
    nsd_event("nsd.admin.drop-ok",
              "project", nsd_jstr(project),
              NULL);
    pthread_mutex_unlock(&g_projects_mu);
    return NSD_OK;
}
