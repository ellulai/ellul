/*
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 ellul.ai. All rights reserved.
 */

#define _GNU_SOURCE

#include "daemon_subexec.h"
#include "log.h"

#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

#define NSD_SUBEXEC_ERR_CAP   512
#define NSD_SUBEXEC_MSG_MAX   65536
#define NSD_SUBEXEC_ARGV_MAX  64

struct sub_response {
    int32_t  exit_status;
    int32_t  signal_status;
    uint32_t stderr_len;
    /* followed by stderr_len bytes of stderr */
};

static pthread_mutex_t g_call_lock = PTHREAD_MUTEX_INITIALIZER;
static int             g_helper_sock = -1;
static pid_t           g_helper_pid  = -1;
static int             g_initialized = 0;

/* ── Helper-side: serve one request ─────────────────────── */

static void helper_serve_one(int sock, char *const envp[],
                             const uint8_t *buf, size_t len) {
    /* Wire format (little-endian):
     *   u16 path_len, u16 argv_count, u32 stdin_len,
     *   char[path_len] path,
     *   [u16 arg_len, char[arg_len]] × argv_count,
     *   char[stdin_len] stdin */
    if (len < 8) return;
    size_t off = 0;
    uint16_t path_len  = buf[off] | (buf[off+1] << 8); off += 2;
    uint16_t argv_cnt  = buf[off] | (buf[off+1] << 8); off += 2;
    uint32_t stdin_len = buf[off] | (buf[off+1] << 8) | (buf[off+2] << 16) | (buf[off+3] << 24); off += 4;
    if (path_len == 0 || path_len > 4096) return;
    if (argv_cnt == 0 || argv_cnt > NSD_SUBEXEC_ARGV_MAX) return;
    if (off + path_len > len) return;
    char *path = malloc(path_len + 1);
    if (!path) return;
    memcpy(path, buf + off, path_len);
    path[path_len] = 0; off += path_len;

    char **argv = calloc(argv_cnt + 1, sizeof(char *));
    if (!argv) { free(path); return; }
    int argv_filled = 0;
    for (uint16_t i = 0; i < argv_cnt; i++) {
        if (off + 2 > len) goto fail;
        uint16_t arg_len = buf[off] | (buf[off+1] << 8); off += 2;
        if (arg_len > 4096) goto fail;
        if (off + arg_len > len) goto fail;
        argv[i] = malloc((size_t)arg_len + 1);
        if (!argv[i]) goto fail;
        memcpy(argv[i], buf + off, arg_len);
        argv[i][arg_len] = 0; off += arg_len;
        argv_filled = i + 1;
    }
    argv[argv_cnt] = NULL;

    if (off + stdin_len > len) goto fail;
    const uint8_t *stdin_data = buf + off;

    /* Set up pipes. */
    int errpipe[2];
    int inpipe[2] = { -1, -1 };
    if (pipe2(errpipe, O_CLOEXEC) != 0) goto fail;
    if (stdin_len > 0 && pipe2(inpipe, O_CLOEXEC) != 0) {
        close(errpipe[0]); close(errpipe[1]);
        goto fail;
    }

    pid_t p = fork();
    if (p < 0) {
        close(errpipe[0]); close(errpipe[1]);
        if (inpipe[0] >= 0) { close(inpipe[0]); close(inpipe[1]); }
        goto fail;
    }
    if (p == 0) {
        if (stdin_len > 0) {
            dup2(inpipe[0], 0);
            close(inpipe[0]); close(inpipe[1]);
        } else {
            int dn = open("/dev/null", O_RDWR | O_CLOEXEC);
            if (dn >= 0) { dup2(dn, 0); close(dn); }
        }
        dup2(errpipe[1], 2);
        close(errpipe[0]); close(errpipe[1]);
        execve(path, argv, envp);
        _exit(127);
    }
    close(errpipe[1]);
    if (inpipe[0] >= 0) close(inpipe[0]);

    if (stdin_len > 0) {
        size_t written = 0;
        while (written < stdin_len) {
            ssize_t w = write(inpipe[1], stdin_data + written, stdin_len - written);
            if (w < 0) { if (errno == EINTR) continue; break; }
            written += (size_t)w;
        }
        close(inpipe[1]);
    }

    char errbuf[NSD_SUBEXEC_ERR_CAP];
    size_t errlen = 0;
    while (errlen < sizeof(errbuf)) {
        ssize_t r = read(errpipe[0], errbuf + errlen, sizeof(errbuf) - errlen);
        if (r < 0) { if (errno == EINTR) continue; break; }
        if (r == 0) break;
        errlen += (size_t)r;
    }
    while (errlen > 0 && (errbuf[errlen-1] == '\n' || errbuf[errlen-1] == '\r')) errlen--;
    close(errpipe[0]);

    int st;
    while (waitpid(p, &st, 0) < 0) {
        if (errno != EINTR) { st = 0; break; }
    }

    /* Pack response: header + stderr */
    uint8_t out[sizeof(struct sub_response) + NSD_SUBEXEC_ERR_CAP];
    int32_t  exit_st = WIFEXITED(st)   ? WEXITSTATUS(st) : -1;
    int32_t  sig_st  = WIFSIGNALED(st) ? WTERMSIG(st)    : 0;
    uint32_t err32   = (uint32_t)errlen;
    memcpy(out + 0, &exit_st, 4);
    memcpy(out + 4, &sig_st,  4);
    memcpy(out + 8, &err32,   4);
    memcpy(out + 12, errbuf, errlen);
    (void) send(sock, out, 12 + errlen, 0);

    for (int i = 0; i < argv_filled; i++) free(argv[i]);
    free(argv); free(path);
    return;

fail: {
    /* Send a failure response so the caller doesn't block. */
    int32_t  exit_st = -1;
    int32_t  sig_st  = 0;
    uint32_t err32   = 0;
    uint8_t out[12];
    memcpy(out + 0, &exit_st, 4);
    memcpy(out + 4, &sig_st,  4);
    memcpy(out + 8, &err32,   4);
    (void) send(sock, out, 12, 0);
    for (int i = 0; i < argv_filled; i++) free(argv[i]);
    free(argv); free(path);
}
}

static void helper_main_loop(int sock, char *const envp[]) {
    /* Restore default disposition for child reaper. The parent installed
     * SIGTERM handlers we don't want here. */
    struct sigaction sa = {0};
    sa.sa_handler = SIG_DFL;
    sigaction(SIGTERM, &sa, NULL);
    sigaction(SIGINT,  &sa, NULL);
    signal(SIGPIPE, SIG_IGN);

    uint8_t *buf = malloc(NSD_SUBEXEC_MSG_MAX);
    if (!buf) _exit(1);

    for (;;) {
        ssize_t n = recv(sock, buf, NSD_SUBEXEC_MSG_MAX, 0);
        if (n < 0) {
            if (errno == EINTR) continue;
            break;
        }
        if (n == 0) break;  /* parent closed */
        helper_serve_one(sock, envp, buf, (size_t)n);
    }
    free(buf);
    _exit(0);
}

/* ── Daemon-side ────────────────────────────────────────── */

int nsd_subexec_init(char *const envp[]) {
    if (g_initialized) return 0;

    int sv[2];
    if (socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, sv) != 0) {
        nsd_event("nsd.subexec.socketpair-fail", "errno", nsd_jnum(errno), NULL);
        return -1;
    }

    pid_t p = fork();
    if (p < 0) {
        close(sv[0]); close(sv[1]);
        nsd_event("nsd.subexec.fork-fail", "errno", nsd_jnum(errno), NULL);
        return -1;
    }
    if (p == 0) {
        close(sv[0]);
        helper_main_loop(sv[1], envp);
        _exit(0);
    }
    close(sv[1]);
    g_helper_sock = sv[0];
    g_helper_pid  = p;
    g_initialized = 1;

    nsd_event("nsd.subexec.ready", "helper_pid", nsd_jnum((long long)p), NULL);
    return 0;
}

int nsd_subexec_run(const char *path, char *const argv[],
                    const char *stdin_data, size_t stdin_len,
                    char *errbuf, size_t errcap, size_t *errlen,
                    int *exit_status, int *signal_status) {
    if (!g_initialized) { errno = ENXIO; return -1; }

    /* Build request message. */
    size_t path_len = strlen(path);
    if (path_len == 0 || path_len > 4096) { errno = EINVAL; return -1; }
    if (stdin_len > NSD_SUBEXEC_MSG_MAX - 16384) { errno = EMSGSIZE; return -1; }

    uint16_t argv_cnt = 0;
    while (argv[argv_cnt] != NULL) {
        if (argv_cnt >= NSD_SUBEXEC_ARGV_MAX) { errno = E2BIG; return -1; }
        argv_cnt++;
    }

    size_t need = 8 + path_len;
    for (uint16_t i = 0; i < argv_cnt; i++) {
        size_t al = strlen(argv[i]);
        if (al > 4096) { errno = E2BIG; return -1; }
        need += 2 + al;
    }
    need += stdin_len;
    if (need > NSD_SUBEXEC_MSG_MAX) { errno = EMSGSIZE; return -1; }

    uint8_t *buf = malloc(need);
    if (!buf) { errno = ENOMEM; return -1; }

    size_t off = 0;
    buf[off++] = (uint8_t)(path_len & 0xff);
    buf[off++] = (uint8_t)((path_len >> 8) & 0xff);
    buf[off++] = (uint8_t)(argv_cnt & 0xff);
    buf[off++] = (uint8_t)((argv_cnt >> 8) & 0xff);
    buf[off++] = (uint8_t)(stdin_len & 0xff);
    buf[off++] = (uint8_t)((stdin_len >> 8) & 0xff);
    buf[off++] = (uint8_t)((stdin_len >> 16) & 0xff);
    buf[off++] = (uint8_t)((stdin_len >> 24) & 0xff);
    memcpy(buf + off, path, path_len); off += path_len;
    for (uint16_t i = 0; i < argv_cnt; i++) {
        size_t al = strlen(argv[i]);
        buf[off++] = (uint8_t)(al & 0xff);
        buf[off++] = (uint8_t)((al >> 8) & 0xff);
        memcpy(buf + off, argv[i], al); off += al;
    }
    if (stdin_len > 0) { memcpy(buf + off, stdin_data, stdin_len); off += stdin_len; }

    pthread_mutex_lock(&g_call_lock);
    ssize_t snd = send(g_helper_sock, buf, off, 0);
    free(buf);
    if (snd < 0 || (size_t)snd != off) {
        pthread_mutex_unlock(&g_call_lock);
        nsd_event("nsd.subexec.send-fail", "errno", nsd_jnum(errno),
                  "snd", nsd_jnum((long long)snd), NULL);
        return -1;
    }

    uint8_t resp[12 + NSD_SUBEXEC_ERR_CAP + 16];
    ssize_t rc;
    do {
        rc = recv(g_helper_sock, resp, sizeof(resp), 0);
    } while (rc < 0 && errno == EINTR);
    pthread_mutex_unlock(&g_call_lock);

    if (rc < 12) {
        nsd_event("nsd.subexec.recv-fail", "errno", nsd_jnum(errno),
                  "rc", nsd_jnum((long long)rc), NULL);
        return -1;
    }

    int32_t  exit_st;
    int32_t  sig_st;
    uint32_t err32;
    memcpy(&exit_st, resp + 0, 4);
    memcpy(&sig_st,  resp + 4, 4);
    memcpy(&err32,   resp + 8, 4);
    if ((size_t)rc < 12 + err32) err32 = (uint32_t)(rc - 12);

    if (errbuf && errcap > 0) {
        size_t n = err32 < errcap - 1 ? err32 : errcap - 1;
        memcpy(errbuf, resp + 12, n);
        errbuf[n] = 0;
        if (errlen) *errlen = n;
    } else if (errlen) {
        *errlen = err32;
    }
    if (exit_status)   *exit_status   = exit_st;
    if (signal_status) *signal_status = sig_st;
    return (exit_st == 0 && sig_st == 0) ? 0 : -1;
}
