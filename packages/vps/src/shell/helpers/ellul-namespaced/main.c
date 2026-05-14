/*
 * ellul-namespaced — daemon entry.
 *
 * Lifecycle:
 *   1. Parse args, refuse to start if feature flag absent.
 *   2. Probe SO_PEERPIDFD; exit 78 if missing.
 *   3. Resolve $SVC_USER, ellul-ns gid.
 *   4. Derive HMAC key from /etc/machine-id.
 *   5. Load + verify manifest public key + tier manifest.
 *   6. Bind admin + per-project sockets.
 *   7. Install own seccomp filter.
 *   8. sd_notify(READY=1).
 *   9. Accept loop — one thread per connection.
 *  10. On SIGTERM, drain and exit cleanly.
 *
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 ellul.ai. All rights reserved.
 */

#define _GNU_SOURCE

#include "auth.h"
#include "byok.h"
#include "daemon.h"
#include "daemon_seccomp.h"
#include "daemon_subexec.h"
#include "dispatch.h"
#include "hmac_session.h"
#include "log.h"
#include "manifest.h"
#include "mount_stage.h"
#include "sock_listen.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <poll.h>
#include <pthread.h>
#include <pwd.h>
#include <signal.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/eventfd.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#include <systemd/sd-daemon.h>

/* ── Daemon state ────────────────────────────────────────── */

struct nsd_state {
    uint8_t   hmac_key[NSD_HMAC_KEY_BYTES];
    uint8_t   manifest_pubkey[NSD_PUBKEY_BYTES];
    uint8_t   manifest_pubkey_fp[NSD_FINGERPRINT_BYTES];
    uint8_t   manifest_pubkey_next[NSD_PUBKEY_BYTES];
    int       has_next_key;
    struct nsd_manifest *manifest;
    struct nsd_byok_state *byok;  /* NULL if master could not be loaded */

    char      svc_user[32];
    uid_t     svc_uid;
    gid_t     svc_gid;
    gid_t     ns_gid;             /* ellul-ns group GID */

    int       admin_listen_fd;
    struct nsd_project projects[NSD_MAX_PROJECTS];
    size_t    n_projects;

    atomic_int  active_connections;
    atomic_bool shutting_down;

    /* Wall-clock at startup, for uptime accounting. */
    struct timespec started_at;
};

static struct nsd_state g_state;

/* ── Accessors used by other modules ─────────────────────── */

const uint8_t *nsd_state_hmac_key(const struct nsd_state *st) {
    return st->hmac_key;
}
const uint8_t *nsd_state_manifest_pubkey(const struct nsd_state *st) {
    return st->manifest_pubkey;
}
const uint8_t *nsd_state_manifest_pubkey_fp(const struct nsd_state *st) {
    return st->manifest_pubkey_fp;
}
const struct nsd_manifest *nsd_state_manifest(const struct nsd_state *st) {
    return st->manifest;
}
const char *nsd_state_svc_user(const struct nsd_state *st) {
    return st->svc_user;
}
uid_t nsd_state_svc_uid(const struct nsd_state *st) {
    return st->svc_uid;
}
const struct nsd_byok_state *nsd_state_byok(const struct nsd_state *st) {
    return st->byok;
}
long nsd_state_uptime_ms(const struct nsd_state *st) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    long sec = now.tv_sec - st->started_at.tv_sec;
    long nsec = now.tv_nsec - st->started_at.tv_nsec;
    return sec * 1000 + nsec / 1000000;
}

/* Wave-1 admin accessors: ops.c manipulates the projects[] array under a
 * mutex defined inside ops.c. */
struct nsd_project *nsd_state_projects(struct nsd_state *st) {
    return st->projects;
}
size_t nsd_state_n_projects(const struct nsd_state *st) {
    return st->n_projects;
}
void nsd_state_set_n_projects(struct nsd_state *st, size_t n) {
    st->n_projects = n;
}
gid_t nsd_state_ns_gid(const struct nsd_state *st) {
    return st->ns_gid;
}

/* ── Argv-style helpers ──────────────────────────────────── */

static void log_to_stderr(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    fprintf(stderr, "ellul-namespaced: ");
    vfprintf(stderr, fmt, ap);
    fprintf(stderr, "\n");
    va_end(ap);
}

/* ── Feature flag ────────────────────────────────────────── */

static bool feature_flag_enabled(void) {
    int fd = open(NSD_FEATURE_FLAG, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return false;
    char b = 0;
    ssize_t r = read(fd, &b, 1);
    close(fd);
    if (r != 1) return false;
    return b == '1';
}

/* ── Service user / group resolution ─────────────────────── */

static int read_default_ellul(char out_user[32]) {
    /* /etc/default/ellul looks like:
     *   PS_USER=dev
     * Parse the PS_USER= line. Default to "dev". */
    strcpy(out_user, "dev");
    int fd = open(NSD_DEFAULT_DEFAULTS, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return 0;
    char buf[512] = {0};
    ssize_t r = read(fd, buf, sizeof(buf) - 1);
    close(fd);
    if (r <= 0) return 0;
    char *line = buf;
    while (line < buf + r) {
        char *eol = strchr(line, '\n');
        if (eol) *eol = 0;
        if (strncmp(line, "PS_USER=", 8) == 0) {
            const char *v = line + 8;
            /* Strip optional surrounding quotes. */
            if (*v == '"' || *v == '\'') v++;
            size_t i = 0;
            while (*v && *v != '"' && *v != '\'' && *v != '\n' &&
                   *v != ' ' && i + 1 < 32) {
                out_user[i++] = *v++;
            }
            out_user[i] = 0;
            break;
        }
        if (!eol) break;
        line = eol + 1;
    }
    return 0;
}

static int resolve_svc_and_group(struct nsd_state *st) {
    read_default_ellul(st->svc_user);
    struct passwd *pw = getpwnam(st->svc_user);
    if (!pw) {
        log_to_stderr("getpwnam(\"%s\") failed", st->svc_user);
        return -1;
    }
    st->svc_uid = pw->pw_uid;
    st->svc_gid = pw->pw_gid;

    struct group *gr = getgrnam("ellul-ns");
    if (!gr) {
        log_to_stderr("getgrnam(\"ellul-ns\") failed — group not provisioned?");
        return -1;
    }
    st->ns_gid = gr->gr_gid;
    return 0;
}

/* ── Manifest pubkey load ────────────────────────────────── */

static int load_manifest_pubkey(struct nsd_state *st) {
    int fd = open(NSD_MANIFEST_PUB_PATH, O_RDONLY | O_CLOEXEC);
    if (fd < 0) {
        log_to_stderr("open %s: %s", NSD_MANIFEST_PUB_PATH, strerror(errno));
        return -1;
    }
    /* Pubkey on-disk is raw 32 bytes, optionally hex-encoded.
     * Detect hex (length 64 or 65 with newline) and decode. */
    uint8_t buf[256];
    ssize_t r = read(fd, buf, sizeof(buf));
    close(fd);
    if (r <= 0) return -1;
    if (r == NSD_PUBKEY_BYTES) {
        memcpy(st->manifest_pubkey, buf, NSD_PUBKEY_BYTES);
    } else {
        /* Assume hex; strip whitespace, decode. */
        size_t hexlen = 0;
        for (ssize_t i = 0; i < r; i++) {
            char c = (char) buf[i];
            if (c == '\n' || c == '\r' || c == ' ') continue;
            if (hexlen >= NSD_PUBKEY_BYTES * 2) {
                log_to_stderr("manifest.pub too long");
                return -1;
            }
            buf[hexlen++] = (uint8_t) c;
        }
        if (hexlen != NSD_PUBKEY_BYTES * 2) {
            log_to_stderr("manifest.pub: expected %d hex chars, got %zu",
                          NSD_PUBKEY_BYTES * 2, hexlen);
            return -1;
        }
        for (size_t i = 0; i < NSD_PUBKEY_BYTES; i++) {
            char hi = (char) buf[i*2], lo = (char) buf[i*2+1];
            int h = (hi <= '9') ? hi - '0' :
                    (hi >= 'a') ? hi - 'a' + 10 : hi - 'A' + 10;
            int l = (lo <= '9') ? lo - '0' :
                    (lo >= 'a') ? lo - 'a' + 10 : lo - 'A' + 10;
            if (h < 0 || h > 15 || l < 0 || l > 15) {
                log_to_stderr("manifest.pub: bad hex");
                return -1;
            }
            st->manifest_pubkey[i] = (uint8_t)((h << 4) | l);
        }
    }
    nsd_manifest_pubkey_fingerprint(st->manifest_pubkey, st->manifest_pubkey_fp);
    return 0;
}

static void load_manifest_pubkey_next(struct nsd_state *st) {
    st->has_next_key = 0;
    int fd = open(NSD_MANIFEST_PUB_NEXT_PATH, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return;
    uint8_t buf[32];
    ssize_t r = read(fd, buf, sizeof(buf));
    close(fd);
    if (r == NSD_PUBKEY_BYTES) {
        memcpy(st->manifest_pubkey_next, buf, NSD_PUBKEY_BYTES);
        st->has_next_key = 1;
    }
}

/* ── Per-project socket scanning ─────────────────────────── */

static bool slug_is_valid(const char *slug) {
    if (strlen(slug) != NSD_PROJECT_SLUG_LEN) return false;
    if (strncmp(slug, "sbx-", 4) != 0) return false;
    for (int i = 4; i < NSD_PROJECT_SLUG_LEN; i++) {
        char c = slug[i];
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'))) return false;
    }
    return true;
}

static int scan_existing_namespaces(struct nsd_state *st) {
    DIR *d = opendir("/run");
    if (!d) {
        log_to_stderr("opendir /run: %s", strerror(errno));
        return -1;
    }
    struct dirent *e;
    while ((e = readdir(d)) != NULL) {
        if (strncmp(e->d_name, ".ns-", 4) != 0) continue;
        const char *slug = e->d_name + 4;
        if (!slug_is_valid(slug)) continue;
        if (st->n_projects >= NSD_MAX_PROJECTS) break;

        /* Check anchor.pid file is present and points to a live process. */
        char pidpath[256];
        snprintf(pidpath, sizeof(pidpath), "/run/.ns-%s/anchor.pid", slug);
        struct stat sb;
        if (stat(pidpath, &sb) != 0 || !S_ISREG(sb.st_mode)) continue;

        int lfd = nsd_sock_bind_project(slug, st->ns_gid);
        if (lfd < 0) {
            nsd_event("nsd.startup.proj-bind-skip",
                      "project", nsd_jstr(slug),
                      "errno", nsd_jnum(errno),
                      NULL);
            continue;
        }
        struct nsd_project *p = &st->projects[st->n_projects++];
        memset(p, 0, sizeof(*p));
        snprintf(p->slug, sizeof(p->slug), "%s", slug);
        p->listen_fd = lfd;
    }
    closedir(d);
    return 0;
}

/* ── Connection thread ───────────────────────────────────── */

struct conn_arg {
    int fd;
    char project[NSD_PROJECT_SLUG_LEN + 1];
    bool is_admin;
};

static void *conn_worker(void *arg) {
    struct conn_arg *a = arg;
    pthread_setname_np(pthread_self(), "nsd-conn");
    nsd_dispatch_connection(a->fd, a->is_admin ? NULL : a->project, &g_state);
    atomic_fetch_sub(&g_state.active_connections, 1);
    free(a);
    return NULL;
}

/* ── Signal handling ─────────────────────────────────────── */

static int g_shutdown_eventfd = -1;
static atomic_int g_term_sender_pid = 0;
static atomic_int g_term_sender_uid = 0;
static atomic_int g_term_signal     = 0;

static void on_term_signal(int sig, siginfo_t *si, void *uc) {
    (void) uc;
    atomic_store(&g_term_signal, sig);
    if (si) {
        atomic_store(&g_term_sender_pid, (int)si->si_pid);
        atomic_store(&g_term_sender_uid, (int)si->si_uid);
    }
    atomic_store(&g_state.shutting_down, true);
    /* Wake the poll loop. */
    if (g_shutdown_eventfd >= 0) {
        uint64_t one = 1;
        ssize_t r = write(g_shutdown_eventfd, &one, sizeof(one));
        (void) r;
    }
}

/* ── Accept loop ─────────────────────────────────────────── */

static int accept_loop(struct nsd_state *st) {
    /* poll(2) array: [admin, project_0, project_1, ..., shutdown_eventfd, watchdog_eventfd]. */
    /* The array is built once from the startup snapshot. CREATE_PROJECT
     * / DROP_PROJECT mutate the projects[] entries under g_projects_mu;
     * a future revision can rebuild the pollfd array on those events. */
    size_t nfds = 1 + st->n_projects + 1;  /* +1 for shutdown eventfd */
    struct pollfd *fds = calloc(nfds, sizeof(*fds));
    if (!fds) return -1;
    fds[0].fd = st->admin_listen_fd;
    fds[0].events = POLLIN;
    for (size_t i = 0; i < st->n_projects; i++) {
        fds[1 + i].fd = st->projects[i].listen_fd;
        fds[1 + i].events = POLLIN;
    }
    fds[nfds - 1].fd = g_shutdown_eventfd;
    fds[nfds - 1].events = POLLIN;

    while (!atomic_load(&st->shutting_down)) {
        int rc = poll(fds, nfds, NSD_WATCHDOG_INTERVAL_MS);
        if (rc < 0) {
            if (errno == EINTR) continue;
            nsd_event("nsd.poll.error", "errno", nsd_jnum(errno), NULL);
            break;
        }

        /* Watchdog notify on every poll wake (idle or active). */
        sd_notify(0, "WATCHDOG=1");

        if (rc == 0) continue;

        if (fds[nfds - 1].revents & POLLIN) {
            /* Shutdown signal. */
            uint64_t v;
            (void) read(g_shutdown_eventfd, &v, sizeof(v));
            break;
        }

        /* Iterate listeners. */
        for (size_t i = 0; i < nfds - 1; i++) {
            if (!(fds[i].revents & POLLIN)) continue;
            int peer = accept4(fds[i].fd, NULL, NULL,
                               SOCK_CLOEXEC | SOCK_NONBLOCK);
            if (peer < 0) {
                if (errno == EAGAIN || errno == EWOULDBLOCK) continue;
                nsd_event("nsd.accept.error", "errno", nsd_jnum(errno), NULL);
                continue;
            }
            int active = atomic_load(&st->active_connections);
            if (active >= NSD_MAX_CONNECTIONS) {
                nsd_event("nsd.accept.deny",
                          "reason", nsd_jstr("max-connections"),
                          "active", nsd_jnum(active),
                          NULL);
                close(peer); continue;
            }
            atomic_fetch_add(&st->active_connections, 1);

            struct conn_arg *a = calloc(1, sizeof(*a));
            if (!a) { close(peer); atomic_fetch_sub(&st->active_connections, 1); continue; }
            a->fd = peer;
            if (i == 0) {
                a->is_admin = true;
            } else {
                snprintf(a->project, sizeof(a->project), "%s",
                         st->projects[i - 1].slug);
            }

            pthread_t tid;
            pthread_attr_t attr;
            pthread_attr_init(&attr);
            pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
            if (pthread_create(&tid, &attr, conn_worker, a) != 0) {
                close(peer); free(a);
                atomic_fetch_sub(&st->active_connections, 1);
            }
            pthread_attr_destroy(&attr);
        }
    }
    free(fds);
    return 0;
}

/* ── Main ────────────────────────────────────────────────── */

int main(int argc, char *argv[]) {
    /* Argument handling: --help, --version. Defensive against arg-injection. */
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--version") == 0) {
            printf("ellul-namespaced %u (protocol %u)\n",
                   NSD_PROTOCOL_VERSION, NSD_PROTOCOL_VERSION);
            return 0;
        }
        if (strcmp(argv[i], "--help") == 0) {
            printf("usage: %s\n"
                   "  Reads /etc/ellul/feature-flags/nsd-enabled to gate startup.\n"
                   "  Reads /etc/ellul/billing-tier to choose manifest.\n"
                   "  Binds /run/ellul-ns/admin.sock + per-project sockets.\n",
                   argv[0]);
            return 0;
        }
        log_to_stderr("unknown arg: %s", argv[i]);
        return 64;
    }

    nsd_log_init();
    clock_gettime(CLOCK_MONOTONIC, &g_state.started_at);

    if (!feature_flag_enabled()) {
        nsd_event("nsd.startup.disabled-by-flag", NULL);
        log_to_stderr("feature flag absent at %s; exiting cleanly",
                      NSD_FEATURE_FLAG);
        return 0;
    }

    if (nsd_auth_probe_kernel() != 0) {
        log_to_stderr("kernel does not support SO_PEERPIDFD; refusing to start");
        return NSD_EX_CONFIG;
    }

    if (resolve_svc_and_group(&g_state) != 0) return 1;

    if (nsd_hmac_derive_shared_key(g_state.hmac_key) != 0) {
        log_to_stderr("HMAC key derivation failed");
        return 1;
    }

    if (load_manifest_pubkey(&g_state) != 0) return 1;
    load_manifest_pubkey_next(&g_state);

    int mr = nsd_manifest_load_for_tier(g_state.manifest_pubkey,
                                         g_state.has_next_key ? g_state.manifest_pubkey_next : NULL,
                                         &g_state.manifest);
    if (mr != 0) {
        log_to_stderr("manifest load failed (rc=%d)", mr);
        return 1;
    }

    /* BYOK master is best-effort: if /etc/ellul/byok-master.key is
     * missing or malformed (mid-rollout, mid-rotation), the daemon
     * continues to start. BYOK opcodes are gated on
     * nsd_byok_ready(state->byok) and return EINTERNAL when the master
     * isn't loaded — they fail closed without taking the daemon down.
     * Production hosts get the master at provisioning time via
     * apps/api/src/provisioning/shell/packages/ellul-namespaced.sh. */
    if (nsd_byok_load_master(&g_state.byok) != 0) {
        nsd_event("nsd.byok.master.unavailable", NULL);
        log_to_stderr("byok master not available; BYOK opcodes will return EINTERNAL");
        g_state.byok = NULL;
    }

    if (nsd_sock_ensure_run_dir(g_state.ns_gid) != 0) return 1;

    g_state.admin_listen_fd = nsd_sock_bind_admin(g_state.ns_gid);
    if (g_state.admin_listen_fd < 0) return 1;

    if (scan_existing_namespaces(&g_state) != 0) return 1;

    g_shutdown_eventfd = eventfd(0, EFD_CLOEXEC | EFD_NONBLOCK);
    if (g_shutdown_eventfd < 0) {
        log_to_stderr("eventfd: %s", strerror(errno));
        return 1;
    }

    /* Signal handlers — graceful shutdown on TERM/INT, ignore PIPE.
     * SA_SIGINFO so we capture si_pid / si_uid of the sender — without
     * it, when the daemon dies inside its first second we can't tell
     * whether systemd, agent-sync rollback, or something else killed it. */
    struct sigaction sa = {0};
    sa.sa_sigaction = on_term_signal;
    sa.sa_flags     = SA_SIGINFO | SA_RESTART;
    sigaction(SIGTERM, &sa, NULL);
    sigaction(SIGINT, &sa, NULL);
    signal(SIGPIPE, SIG_IGN);

    /* Spawn subexec helper BEFORE seccomp — its task chain stays unfiltered,
     * so trusted helper binaries (nsenter, ip, ipset, iptables-restore) it
     * forks aren't constrained by our daemon allowlist. Worker threads
     * delegate every fork+exec through it. */
    if (nsd_subexec_init(NSD_ENVP_SAFE) != 0) {
        log_to_stderr("subexec init failed");
        return 1;
    }

    /* Install seccomp last — anything earlier may need syscalls we banned. */
    if (nsd_daemon_seccomp_install() != 0) {
        log_to_stderr("seccomp install failed");
        return 1;
    }

    nsd_event("nsd.startup.ready",
              "svc_user", nsd_jstr(g_state.svc_user),
              "svc_uid", nsd_jnum(g_state.svc_uid),
              "ns_gid", nsd_jnum(g_state.ns_gid),
              "n_projects", nsd_jnum((long long)g_state.n_projects),
              "manifest_fp", nsd_jbytes_hex(g_state.manifest_pubkey_fp,
                                            NSD_FINGERPRINT_BYTES),
              NULL);

    sd_notify(0, "READY=1\nSTATUS=ready");

    int rc = accept_loop(&g_state);

    {
        int sender_pid = atomic_load(&g_term_sender_pid);
        int sender_uid = atomic_load(&g_term_sender_uid);
        int sig        = atomic_load(&g_term_signal);
        char comm[64] = "";
        if (sender_pid > 0) {
            char path[64];
            snprintf(path, sizeof(path), "/proc/%d/comm", sender_pid);
            int f = open(path, O_RDONLY | O_CLOEXEC);
            if (f >= 0) {
                ssize_t r = read(f, comm, sizeof(comm) - 1);
                if (r > 0) {
                    comm[r] = 0;
                    while (r > 0 && (comm[r-1] == '\n' || comm[r-1] == '\r')) comm[--r] = 0;
                }
                close(f);
            }
        }
        nsd_event("nsd.shutdown.signaled",
                  "signal",      nsd_jnum((long long)sig),
                  "sender_pid",  nsd_jnum((long long)sender_pid),
                  "sender_uid",  nsd_jnum((long long)sender_uid),
                  "sender_comm", nsd_jstr(comm),
                  NULL);
    }

    sd_notify(0, "STOPPING=1\nSTATUS=draining");

    /* Close all listeners — in-flight threads complete on their own. */
    if (g_state.admin_listen_fd >= 0) close(g_state.admin_listen_fd);
    for (size_t i = 0; i < g_state.n_projects; i++) {
        if (g_state.projects[i].listen_fd >= 0)
            close(g_state.projects[i].listen_fd);
    }

    /* Best-effort: wait up to 5s for active connections. */
    for (int t = 0; t < 50 && atomic_load(&g_state.active_connections) > 0; t++) {
        struct timespec ts = { .tv_sec = 0, .tv_nsec = 100 * 1000 * 1000 };
        nanosleep(&ts, NULL);
    }

    nsd_manifest_free(g_state.manifest);
    nsd_byok_free(g_state.byok);
    nsd_event("nsd.shutdown.ok", NULL);
    nsd_log_close();
    return rc;
}
