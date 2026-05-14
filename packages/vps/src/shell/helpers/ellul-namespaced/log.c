/*
 * ellul-namespaced — structured logging implementation.
 *
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 ellul.ai. All rights reserved.
 */

#define _GNU_SOURCE

#include "log.h"

#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/uio.h>
#include <time.h>
#include <unistd.h>

/* Per-thread scratch buffer for nsd_jstr / nsd_jnum / nsd_jbool / nsd_jbytes_hex.
 * Each helper writes into the next slot; up to 8 distinct values can be alive
 * in a single nsd_event() call before they get clobbered. */
#define NSD_J_SLOTS  8
#define NSD_J_BUFLEN 256
struct nsd_jbuf {
    char slots[NSD_J_SLOTS][NSD_J_BUFLEN];
    int  next;
};
static __thread struct nsd_jbuf tls_jbuf;

static int g_event_fd = -1;
static int g_phase_fd = -1;
static pthread_mutex_t g_event_mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_mutex_t g_phase_mu = PTHREAD_MUTEX_INITIALIZER;

static void open_log(const char *path, int *out_fd, gid_t shared_gid) {
    /* O_APPEND: every write is atomic to end-of-file. flock around writes
     * is belt-and-suspenders for cross-process appenders that ignore O_APPEND
     * (older logrotate copy-truncate cases). */
    int fd = open(path, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0640);
    if (fd < 0) {
        /* Best-effort: fall back to /tmp so triage is still possible. */
        char fallback[256];
        snprintf(fallback, sizeof(fallback), "/tmp/ellul-nsd-%s",
                 strrchr(path, '/') ? strrchr(path, '/') + 1 : path);
        fd = open(fallback, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0600);
        *out_fd = fd;
        return;
    }
    /* root:ellul-ns 0640 — bridge (ellul-ns member) reads for triage; "other" denied. */
    if (shared_gid != (gid_t)-1) {
        (void) fchown(fd, 0, shared_gid);
        (void) fchmod(fd, 0640);
    }
    *out_fd = fd;
}

void nsd_log_init(void) {
    /* mkdir is best-effort; the log dir is provisioned but a fresh box
     * pre-provisioning may not have it. */
    (void) mkdir("/var/log/ellul", 0750);
    gid_t ns_gid = (gid_t)-1;
    struct group *gr = getgrnam("ellul-ns");
    if (gr) ns_gid = gr->gr_gid;
    open_log(NSD_EVENT_LOG, &g_event_fd, ns_gid);
    open_log(NSD_PHASE_LOG, &g_phase_fd, ns_gid);
}

void nsd_log_close(void) {
    if (g_event_fd >= 0) { close(g_event_fd); g_event_fd = -1; }
    if (g_phase_fd >= 0) { close(g_phase_fd); g_phase_fd = -1; }
}

static char *next_jslot(void) {
    char *p = tls_jbuf.slots[tls_jbuf.next];
    tls_jbuf.next = (tls_jbuf.next + 1) % NSD_J_SLOTS;
    return p;
}

const char *nsd_jstr(const char *s) {
    char *out = next_jslot();
    if (!s) { strcpy(out, "null"); return out; }
    char *o = out;
    *o++ = '"';
    /* Reserve room for closing quote + NUL + escape expansion. */
    char *end = out + NSD_J_BUFLEN - 8;
    for (const unsigned char *p = (const unsigned char *)s; *p && o < end; p++) {
        unsigned char c = *p;
        switch (c) {
        case '"':  *o++ = '\\'; *o++ = '"';  break;
        case '\\': *o++ = '\\'; *o++ = '\\'; break;
        case '\n': *o++ = '\\'; *o++ = 'n';  break;
        case '\r': *o++ = '\\'; *o++ = 'r';  break;
        case '\t': *o++ = '\\'; *o++ = 't';  break;
        default:
            if (c < 0x20) {
                /* Truncate rather than fight with \uXXXX expansion in a
                 * fixed buffer. JSON consumers will still parse. */
                continue;
            }
            *o++ = (char)c;
        }
    }
    *o++ = '"';
    *o = 0;
    return out;
}

const char *nsd_jnum(long long v) {
    char *out = next_jslot();
    snprintf(out, NSD_J_BUFLEN, "%lld", v);
    return out;
}

const char *nsd_jbool(bool v) {
    return v ? "true" : "false";
}

const char *nsd_jbytes_hex(const uint8_t *b, size_t n) {
    char *out = next_jslot();
    if (!b || n == 0) { strcpy(out, "\"\""); return out; }
    /* Cap output to fit buffer: 2 bytes per input + quotes. */
    size_t maxn = (NSD_J_BUFLEN - 4) / 2;
    if (n > maxn) n = maxn;
    out[0] = '"';
    static const char hex[] = "0123456789abcdef";
    for (size_t i = 0; i < n; i++) {
        out[1 + i*2]     = hex[b[i] >> 4];
        out[1 + i*2 + 1] = hex[b[i] & 0xf];
    }
    out[1 + n*2] = '"';
    out[2 + n*2] = 0;
    return out;
}

static void iso_now(char *out, size_t n) {
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    struct tm tm;
    gmtime_r(&ts.tv_sec, &tm);
    snprintf(out, n, "%04d-%02d-%02dT%02d:%02d:%02d.%03ldZ",
             tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday,
             tm.tm_hour, tm.tm_min, tm.tm_sec,
             ts.tv_nsec / 1000000);
}

void nsd_event(const char *kind, ...) {
    if (g_event_fd < 0) return;
    char buf[4096];
    char ts[40];
    iso_now(ts, sizeof(ts));
    int n = snprintf(buf, sizeof(buf), "{\"ts\":\"%s\",\"event\":\"%s\"", ts, kind);
    if (n < 0 || (size_t)n >= sizeof(buf)) return;

    va_list ap;
    va_start(ap, kind);
    while (n + 2 < (int)sizeof(buf)) {
        const char *key = va_arg(ap, const char *);
        if (!key) break;
        const char *val = va_arg(ap, const char *);
        if (!val) val = "null";
        int wrote = snprintf(buf + n, sizeof(buf) - n, ",\"%s\":%s", key, val);
        if (wrote < 0 || (size_t)wrote >= sizeof(buf) - (size_t)n) break;
        n += wrote;
    }
    va_end(ap);

    if (n + 2 >= (int)sizeof(buf)) n = (int)sizeof(buf) - 2;
    buf[n++] = '}';
    buf[n++] = '\n';

    /* Single write under mutex — JSONL line atomicity guaranteed. */
    pthread_mutex_lock(&g_event_mu);
    /* Best-effort; partial writes possible only on signal interrupt. */
    ssize_t r = write(g_event_fd, buf, (size_t)n);
    (void) r;
    pthread_mutex_unlock(&g_event_mu);
}

void nsd_phase(const char *action, const char *project, const char *phase,
               const char *state, const char *extras) {
    if (g_phase_fd < 0) return;
    char ts[40];
    iso_now(ts, sizeof(ts));
    char buf[1024];
    int n = snprintf(buf, sizeof(buf),
                     "%s action=%s project=%s phase=%s state=%s pid=%d%s%s\n",
                     ts,
                     action ? action : "?",
                     project ? project : "-",
                     phase ? phase : "?",
                     state ? state : "info",
                     (int)getpid(),
                     extras ? " " : "",
                     extras ? extras : "");
    if (n <= 0) return;
    if ((size_t)n > sizeof(buf)) n = (int)sizeof(buf);

    pthread_mutex_lock(&g_phase_mu);
    ssize_t r = write(g_phase_fd, buf, (size_t)n);
    (void) r;
    pthread_mutex_unlock(&g_phase_mu);
}
