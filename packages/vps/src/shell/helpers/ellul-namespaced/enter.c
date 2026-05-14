/*
 * ellul-namespaced — ENTER + INJECT_ENV handlers.
 *
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 ellul.ai. All rights reserved.
 */

#define _GNU_SOURCE

#include "enter.h"
#include "byok.h"
#include "cbor_io.h"
#include "log.h"

#include <sodium.h>

#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/memfd.h>
#include <pwd.h>
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef CGROUP2_SUPER_MAGIC
#define CGROUP2_SUPER_MAGIC 0x63677270
#endif

#ifndef F_GET_SEALS
#define F_GET_SEALS  1034
#define F_SEAL_SEAL  0x0001
#define F_SEAL_SHRINK 0x0002
#define F_SEAL_GROW   0x0004
#define F_SEAL_WRITE  0x0008
#endif

#ifndef __NR_pidfd_open
#define __NR_pidfd_open 434
#endif

#define ENTER_REQUIRED_SEALS  (F_SEAL_WRITE | F_SEAL_GROW | F_SEAL_SHRINK)
#define ENTER_MAX_MEMFD_BYTES (64 * 1024)
#define ENTER_MAX_ARGV        128

static int sys_pidfd_open(pid_t pid, unsigned int flags) {
    return (int) syscall(__NR_pidfd_open, pid, flags);
}

/* ── Helpers ─────────────────────────────────────────────── */

static int read_anchor_pid(const char *project, pid_t *out_pid) {
    char path[256];
    snprintf(path, sizeof(path), "/run/.ns-%s/anchor.pid", project);
    int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return -1;
    struct stat sb;
    if (fstat(fd, &sb) != 0) { close(fd); return -1; }
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

static bool memfd_seals_ok(int fd) {
    int seals = fcntl(fd, F_GET_SEALS);
    if (seals < 0) return false;
    return (seals & ENTER_REQUIRED_SEALS) == ENTER_REQUIRED_SEALS;
}

/*
 * Read an entire memfd into out_buf (caller-owned, capped). Returns the
 * byte count, -1 on error.
 */
static ssize_t read_memfd_all(int fd, uint8_t *out_buf, size_t cap) {
    if (lseek(fd, 0, SEEK_SET) < 0) return -1;
    size_t got = 0;
    while (got < cap) {
        ssize_t r = read(fd, out_buf + got, cap - got);
        if (r > 0) { got += (size_t)r; continue; }
        if (r == 0) break;
        if (errno == EINTR) continue;
        return -1;
    }
    return (ssize_t)got;
}

/*
 * Parse a NUL-separated argv blob into argc / argv[]. Last entry must be
 * empty (the trailing NUL after the final string). argv strings point
 * into the buffer.
 */
static int parse_argv_blob(uint8_t *blob, size_t len, char **argv, int max_argv) {
    int n = 0;
    size_t i = 0;
    while (i < len && n < max_argv - 1) {
        argv[n++] = (char *)(blob + i);
        while (i < len && blob[i] != 0) i++;
        if (i >= len) return -1;  /* unterminated */
        blob[i++] = 0;
    }
    argv[n] = NULL;
    return n;
}

/*
 * Validate env entry shape: KEY=VALUE where KEY matches POSIX
 * `[A-Za-z_][A-Za-z0-9_]*`. Reject control characters anywhere.
 */
static bool env_entry_ok(const char *s) {
    if (!s || !*s) return false;
    if (!(isalpha((unsigned char)*s) || *s == '_')) return false;
    const char *p = s + 1;
    while (*p && *p != '=') {
        if (!(isalnum((unsigned char)*p) || *p == '_')) return false;
        p++;
    }
    if (*p != '=') return false;
    /* Reject control chars in the value. */
    for (const char *v = p + 1; *v; v++) {
        if ((unsigned char)*v < 0x20 || *v == 0x7f) return false;
    }
    return true;
}

/*
 * Drop all capabilities except CAP_SETUID / CAP_SETGID needed for the
 * setresuid call below; clear the bounding set for everything else.
 * Then setresgid + setresuid drops to the unprivileged user, which
 * automatically zeros effective and ambient caps as well (per setuid(2)).
 */
static int drop_privs_to_svc(uid_t svc_uid, gid_t svc_gid) {
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return -1;
    /* Clear all ambient caps. */
    if (prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0) != 0) return -1;
    /* Clear bounding set: drop every cap so even file capabilities can't
     * elevate this child or any of its descendants. CAP_LAST_CAP varies
     * by kernel; iterate up to a safe cap (40 is enough through 6.x). */
    for (int c = 0; c <= 40; c++) {
        /* Ignore EINVAL — caps that don't exist on this kernel. */
        (void) prctl(PR_CAPBSET_DROP, c, 0, 0, 0);
    }
    if (setgroups(0, NULL) != 0 && errno != EPERM) return -1;
    if (setresgid(svc_gid, svc_gid, svc_gid) != 0) return -1;
    if (setresuid(svc_uid, svc_uid, svc_uid) != 0) return -1;
    return 0;
}

/*
 * Build the canonical project workspace path that the agent CLI runs in.
 * Mirrors enter.sh's `cd $PROJECT_DIR`.
 */
static void project_dir(char *out, size_t cap, const char *home, const char *slug) {
    snprintf(out, cap, "%s/projects/%s", home, slug);
}

/*
 * Validate a peer-supplied cgroup-v2 path for adapterScope ENTERs.
 * Required shape:
 *   /sys/fs/cgroup/ellul.slice/ellul-user-workload.slice/
 *   ellul-user-workload-sbx-<short>.slice/
 *   ellul-pool-sbx-<short>-<adapter>-<scope>.scope[/]
 *
 * <short>  = project[4..]  (project minus "sbx-"), bound to the per-project
 *            socket so a hostile bridge cannot redirect ENTER into another
 *            project's pool slice.
 * <adapter> ∈ { claude, opencode, cursor, codex }.
 * <scope>   matches [A-Za-z0-9_-]{1,32}.
 *
 * Pure string check; never opens or resolves. Caller does the
 * openat/fstatfs/openat sequence on success.
 */
static bool target_cgroup_path_ok(const char *path, const char *project) {
    if (!path || !project) return false;
    if (strncmp(project, "sbx-", 4) != 0) return false;
    const char *short_id = project + 4;
    size_t short_len = strlen(short_id);
    if (short_len == 0 || short_len > 32) return false;
    for (size_t i = 0; i < short_len; i++) {
        char c = short_id[i];
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'))) return false;
    }
    size_t plen = strlen(path);
    if (plen == 0 || plen >= 256) return false;
    /* Strip optional trailing slash for canonical form. */
    char buf[256];
    memcpy(buf, path, plen);
    if (buf[plen - 1] == '/') { buf[plen - 1] = 0; plen--; }
    else { buf[plen] = 0; }
    /* No "..", no "//" — defeat path normalization games before any other
     * check. The fixed-prefix walk below makes both impossible anyway, but
     * rejecting them up front keeps the logic auditable. */
    for (size_t i = 0; i + 1 < plen; i++) {
        if (buf[i] == '.' && buf[i + 1] == '.') return false;
        if (buf[i] == '/' && buf[i + 1] == '/') return false;
    }
    static const char prefix[] =
        "/sys/fs/cgroup/ellul.slice/ellul-user-workload.slice/";
    size_t prefix_len = sizeof(prefix) - 1;
    if (plen <= prefix_len) return false;
    if (memcmp(buf, prefix, prefix_len) != 0) return false;
    /* Per-project slice component. */
    char want_slice[80];
    int wn = snprintf(want_slice, sizeof(want_slice),
                      "ellul-user-workload-sbx-%s.slice/", short_id);
    if (wn <= 0 || (size_t)wn >= sizeof(want_slice)) return false;
    if (plen <= prefix_len + (size_t)wn) return false;
    if (memcmp(buf + prefix_len, want_slice, (size_t)wn) != 0) return false;
    /* Final component: pool unit. */
    const char *tail = buf + prefix_len + (size_t)wn;
    static const char pool_prefix[] = "ellul-pool-sbx-";
    size_t pool_prefix_len = sizeof(pool_prefix) - 1;
    if (strncmp(tail, pool_prefix, pool_prefix_len) != 0) return false;
    const char *p = tail + pool_prefix_len;
    if (strncmp(p, short_id, short_len) != 0) return false;
    p += short_len;
    if (*p != '-') return false;
    p++;
    static const char *const adapters[] = {
        "claude", "opencode", "cursor", "codex", NULL
    };
    size_t adapter_len = 0;
    for (size_t i = 0; adapters[i]; i++) {
        size_t al = strlen(adapters[i]);
        if (memcmp(p, adapters[i], al) == 0 && p[al] == '-') {
            adapter_len = al;
            break;
        }
    }
    if (adapter_len == 0) return false;
    p += adapter_len;
    if (*p != '-') return false;
    p++;
    /* Scope id. */
    size_t scope_len = 0;
    while (*p && *p != '.') {
        char c = *p;
        bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                  (c >= '0' && c <= '9') || c == '_' || c == '-';
        if (!ok) return false;
        p++;
        scope_len++;
        if (scope_len > 32) return false;
    }
    if (scope_len == 0) return false;
    if (strcmp(p, ".scope") != 0) return false;
    return true;
}

/*
 * Move self into a peer-supplied cgroup-v2 path. Same defence shape as
 * join_anchor_cgroup: O_DIRECTORY|O_NOFOLLOW open, fstatfs(CGROUP2_SUPER_MAGIC),
 * O_NOFOLLOW openat on cgroup.procs. The path itself is the only peer-
 * supplied input the daemon takes here — target_cgroup_path_ok validates
 * shape and binds it to ses->project before this is called.
 *
 * Must be called BEFORE setns(CLONE_NEWPID) so cgroup.procs sees the host
 * PID. Returns 0 on success, -1 on any failure.
 */
static int join_target_cgroup(const char *target_path, pid_t self_pid,
                              const char *project) {
    if (!target_cgroup_path_ok(target_path, project)) return -1;
    int cg_dfd = open(target_path,
                      O_DIRECTORY | O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (cg_dfd < 0) return -1;
    struct statfs sfb;
    if (fstatfs(cg_dfd, &sfb) != 0 ||
        sfb.f_type != (typeof(sfb.f_type)) CGROUP2_SUPER_MAGIC) {
        close(cg_dfd); return -1;
    }
    int procs_fd = openat(cg_dfd, "cgroup.procs",
                          O_WRONLY | O_NOFOLLOW | O_CLOEXEC);
    close(cg_dfd);
    if (procs_fd < 0) return -1;
    char pidbuf[16];
    int pn = snprintf(pidbuf, sizeof(pidbuf), "%d\n", (int)self_pid);
    if (pn <= 0 || pn >= (int)sizeof(pidbuf)) { close(procs_fd); return -1; }
    ssize_t total = 0;
    while (total < pn) {
        ssize_t k = write(procs_fd, pidbuf + total, (size_t)(pn - total));
        if (k < 0) {
            if (errno == EINTR) continue;
            close(procs_fd); return -1;
        }
        total += k;
    }
    close(procs_fd);
    return 0;
}

/*
 * Move self into the anchor's cgroup-v2 hierarchy.
 *
 * Reads the anchor's cgroup path via /proc/self/fd/<pidfd>/cgroup (kernel
 * resolves through the pidfd target atomically — PID reuse is impossible).
 * The path must contain "/ellul-ns-<project>.service" as a path component;
 * a foreign cgroup fails the suffix match. Opens the absolute cgroup
 * directory with O_DIRECTORY|O_CLOEXEC, asserts via fstatfs that the
 * resulting fd is on cgroup2-fs (defeats symlink-to-non-cgroup attacks),
 * then openat(cgroup.procs, O_WRONLY|O_NOFOLLOW) and writes self_pid.
 *
 * Must be called BEFORE setns(CLONE_NEWPID) so the kernel sees our
 * host-side PID. Returns 0 on success, -1 on any failure.
 */
static int join_anchor_cgroup(int anchor_pidfd, pid_t self_pid,
                              const char *project) {
    char proc_cg[64];
    snprintf(proc_cg, sizeof(proc_cg), "/proc/self/fd/%d/cgroup", anchor_pidfd);
    int fd = open(proc_cg, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return -1;
    char line[512] = {0};
    ssize_t got = 0;
    while ((size_t)got < sizeof(line) - 1) {
        ssize_t r = read(fd, line + got, sizeof(line) - 1 - (size_t)got);
        if (r < 0) { if (errno == EINTR) continue; close(fd); return -1; }
        if (r == 0) break;
        got += r;
    }
    close(fd);

    /* Find the cgroup-v2 line "0::<path>". */
    const char *cg_rel = NULL;
    {
        const char *p = line;
        while (*p) {
            if (p[0] == '0' && p[1] == ':' && p[2] == ':') {
                cg_rel = p + 3;
                break;
            }
            const char *eol = strchr(p, '\n');
            if (!eol) break;
            p = eol + 1;
        }
    }
    if (!cg_rel || cg_rel[0] != '/') return -1;

    char rel_path[384];
    size_t rel_len = strcspn(cg_rel, "\n");
    if (rel_len == 0 || rel_len >= sizeof(rel_path)) return -1;
    memcpy(rel_path, cg_rel, rel_len);
    rel_path[rel_len] = 0;

    /* Project-bound suffix: prevents redirection into a foreign anchor. */
    char want[160];
    int wn = snprintf(want, sizeof(want), "/ellul-ns-%s.service", project);
    if (wn <= 0 || wn >= (int)sizeof(want)) return -1;
    const char *m = strstr(rel_path, want);
    if (!m) return -1;
    size_t after = (size_t)(m - rel_path) + (size_t)wn;
    if (rel_path[after] != 0 && rel_path[after] != '/') return -1;

    char abs_path[448];
    int an = snprintf(abs_path, sizeof(abs_path), "/sys/fs/cgroup%s", rel_path);
    if (an <= 0 || an >= (int)sizeof(abs_path)) return -1;

    int cg_dfd = open(abs_path, O_DIRECTORY | O_RDONLY | O_CLOEXEC);
    if (cg_dfd < 0) return -1;
    struct statfs sfb;
    if (fstatfs(cg_dfd, &sfb) != 0 ||
        sfb.f_type != (typeof(sfb.f_type)) CGROUP2_SUPER_MAGIC) {
        close(cg_dfd); return -1;
    }
    int procs_fd = openat(cg_dfd, "cgroup.procs",
                          O_WRONLY | O_NOFOLLOW | O_CLOEXEC);
    close(cg_dfd);
    if (procs_fd < 0) return -1;

    char pidbuf[16];
    int pn = snprintf(pidbuf, sizeof(pidbuf), "%d\n", (int)self_pid);
    if (pn <= 0 || pn >= (int)sizeof(pidbuf)) { close(procs_fd); return -1; }
    ssize_t total = 0;
    while (total < pn) {
        ssize_t k = write(procs_fd, pidbuf + total, (size_t)(pn - total));
        if (k < 0) { if (errno == EINTR) continue; close(procs_fd); return -1; }
        total += k;
    }
    close(procs_fd);
    return 0;
}

/* ── ENTER handler ───────────────────────────────────────── */

extern const char *nsd_state_svc_user(const struct nsd_state *st);
extern uid_t        nsd_state_svc_uid(const struct nsd_state *st);
extern const struct nsd_byok_state *nsd_state_byok(const struct nsd_state *st);

/*
 * Inline-unwrap a single env entry whose value carries the
 * `__byok-v1:<provider>:<base64-wrapped>` marker. On no marker, returns
 * NULL with *out_fatal=false (entry is fine as-is). On a marker that
 * unwraps cleanly, returns a malloc'd KEY=PLAINTEXT replacement string
 * with *out_fatal=false. On a marker that fails to parse / decode /
 * unwrap, returns NULL with *out_fatal=true (caller MUST fail the
 * spawn — surfacing the bad-key state via execve of a plaintext
 * marker would corrupt the agent's env).
 *
 * Plaintext is sodium_memzero'd inside this function before return;
 * the caller's malloc'd replacement string is the only copy on the
 * heap. The replacement is a normal C string — execve copies it into
 * the new process image, then the worker's heap is freed by the
 * kernel either on successful execve or on _exit.
 */
static char *unwrap_env_marker(const char *entry,
                               const struct nsd_byok_state *byok,
                               const char *project,
                               bool *out_fatal) {
    *out_fatal = false;
    const char *eq = strchr(entry, '=');
    if (!eq) return NULL;
    size_t key_len = (size_t)(eq - entry);
    const char *value = eq + 1;
    static const char marker[] = "__byok-v1:";
    if (strncmp(value, marker, sizeof(marker) - 1) != 0) return NULL;

    /* Marker present — from here, any failure is fatal. */
    *out_fatal = true;
    if (!byok || !nsd_byok_ready(byok)) return NULL;

    const char *p = value + sizeof(marker) - 1;
    const char *colon = strchr(p, ':');
    if (!colon) return NULL;
    size_t provider_len = (size_t)(colon - p);
    if (provider_len == 0 || provider_len > NSD_BYOK_PROVIDER_MAX) return NULL;
    if (!nsd_byok_provider_ok(p, provider_len)) return NULL;
    const char *b64 = colon + 1;
    size_t b64_len = strlen(b64);
    if (b64_len == 0) return NULL;

    uint8_t wrapped[NSD_BYOK_WRAPPED_MAX];
    size_t wrapped_len = 0;
    /* sodium_base64_VARIANT_ORIGINAL: standard +/= alphabet (matches the
     * bridge's Buffer.toString("base64")). */
    if (sodium_base642bin(wrapped, sizeof(wrapped), b64, b64_len,
                          NULL, &wrapped_len, NULL,
                          sodium_base64_VARIANT_ORIGINAL) != 0) {
        return NULL;
    }
    uint8_t plaintext[NSD_BYOK_PLAINTEXT_MAX];
    size_t plaintext_len = 0;
    int rc = nsd_byok_unwrap(byok, project, p, provider_len,
                             wrapped, wrapped_len,
                             plaintext, sizeof(plaintext), &plaintext_len);
    sodium_memzero(wrapped, sizeof(wrapped));
    if (rc != NSD_OK) {
        sodium_memzero(plaintext, sizeof(plaintext));
        return NULL;
    }
    /* Reject plaintexts containing control chars — the env validator
     * already checked the original entry value, but the unwrapped
     * plaintext is fresh attacker-controlled input (the bridge could
     * wrap a malicious plaintext). Defence-in-depth. */
    for (size_t i = 0; i < plaintext_len; i++) {
        if (plaintext[i] < 0x20 || plaintext[i] == 0x7f) {
            sodium_memzero(plaintext, sizeof(plaintext));
            return NULL;
        }
    }
    size_t total = key_len + 1 + plaintext_len + 1;
    char *out = malloc(total);
    if (!out) {
        sodium_memzero(plaintext, sizeof(plaintext));
        return NULL;
    }
    memcpy(out, entry, key_len);
    out[key_len] = '=';
    memcpy(out + key_len + 1, plaintext, plaintext_len);
    out[total - 1] = 0;
    sodium_memzero(plaintext, sizeof(plaintext));
    /* Successful unwrap; not fatal. */
    *out_fatal = false;
    return out;
}

int nsd_enter_run(int conn_fd,
                  struct nsd_session *ses,
                  struct nsd_state *state,
                  uint64_t request_id,
                  int *fd_array, size_t fd_count,
                  const char *target_cgroup) {
    if (!ses->project) return -NSD_EPROTO;
    if (fd_count < 4 || fd_count > 5) return -NSD_EFD_KIND;
    /* If the bridge passed a target cgroup, validate it up front so a
     * malformed path fails the request rather than the worker (which
     * would surface as exit 122 — caller can't tell parse from runtime). */
    if (target_cgroup && !target_cgroup_path_ok(target_cgroup, ses->project)) {
        nsd_event("nsd.enter.deny",
                  "project", nsd_jstr(ses->project),
                  "reason", nsd_jstr("target-cgroup-bad"),
                  NULL);
        return -NSD_EPROTO;
    }

    int argv_memfd = fd_array[0];
    int env_memfd  = (fd_count == 5) ? fd_array[1] : -1;
    int stdin_fd   = (fd_count == 5) ? fd_array[2] : fd_array[1];
    int stdout_fd  = (fd_count == 5) ? fd_array[3] : fd_array[2];
    int stderr_fd  = (fd_count == 5) ? fd_array[4] : fd_array[3];

    /* Validate memfd seals. */
    if (!memfd_seals_ok(argv_memfd)) {
        nsd_event("nsd.enter.deny",
                  "project", nsd_jstr(ses->project),
                  "reason", nsd_jstr("argv-memfd-not-sealed"),
                  NULL);
        return -NSD_EFD_KIND;
    }
    if (env_memfd >= 0 && !memfd_seals_ok(env_memfd)) {
        nsd_event("nsd.enter.deny",
                  "project", nsd_jstr(ses->project),
                  "reason", nsd_jstr("env-memfd-not-sealed"),
                  NULL);
        return -NSD_EFD_KIND;
    }

    /* Read and parse argv. */
    uint8_t *argv_blob = malloc(ENTER_MAX_MEMFD_BYTES);
    if (!argv_blob) return -NSD_EINTERNAL;
    ssize_t alen = read_memfd_all(argv_memfd, argv_blob, ENTER_MAX_MEMFD_BYTES);
    if (alen < 0) { free(argv_blob); return -NSD_EFD_KIND; }
    char *argv[ENTER_MAX_ARGV];
    int argc = parse_argv_blob(argv_blob, (size_t)alen, argv, ENTER_MAX_ARGV);
    if (argc < 1) {
        free(argv_blob);
        nsd_event("nsd.enter.deny",
                  "project", nsd_jstr(ses->project),
                  "reason", nsd_jstr("argv-malformed"),
                  NULL);
        return -NSD_EPROTO;
    }

    /* Read and parse env (optional). */
    uint8_t *env_blob = NULL;
    char *envp[ENTER_MAX_ARGV];
    int envc = 0;
    if (env_memfd >= 0) {
        env_blob = malloc(ENTER_MAX_MEMFD_BYTES);
        if (!env_blob) { free(argv_blob); return -NSD_EINTERNAL; }
        ssize_t elen = read_memfd_all(env_memfd, env_blob, ENTER_MAX_MEMFD_BYTES);
        if (elen < 0) { free(env_blob); free(argv_blob); return -NSD_EFD_KIND; }
        envc = parse_argv_blob(env_blob, (size_t)elen, envp, ENTER_MAX_ARGV);
        if (envc < 0) { free(env_blob); free(argv_blob); return -NSD_EPROTO; }
        for (int i = 0; i < envc; i++) {
            if (!env_entry_ok(envp[i])) {
                free(env_blob); free(argv_blob);
                nsd_event("nsd.enter.deny",
                          "project", nsd_jstr(ses->project),
                          "reason", nsd_jstr("env-entry-bad"),
                          NULL);
                return -NSD_EPROTO;
            }
        }
        envp[envc] = NULL;
    }

    /* Resolve anchor PID + open pidfd. */
    pid_t anchor_pid;
    if (read_anchor_pid(ses->project, &anchor_pid) != 0) {
        free(env_blob); free(argv_blob);
        return -NSD_EANCHOR_DEAD;
    }
    int pidfd = sys_pidfd_open(anchor_pid, 0);
    if (pidfd < 0) {
        free(env_blob); free(argv_blob);
        return -NSD_EANCHOR_DEAD;
    }

    /* Fork the worker. */
    pid_t child = fork();
    if (child < 0) {
        close(pidfd); free(env_blob); free(argv_blob);
        return -NSD_EINTERNAL;
    }

    if (child == 0) {
        /* CHILD. Re-arm signal handlers; daemon's were inherited. */
        struct sigaction sa = {0};
        sa.sa_handler = SIG_DFL;
        for (int s = 1; s < 32; s++) sigaction(s, &sa, NULL);

        /* Move stdio onto 0/1/2. dup3 with O_CLOEXEC=0 (default) so the
         * exec'd binary inherits them. */
        if (dup2(stdin_fd, 0) < 0) _exit(127);
        if (dup2(stdout_fd, 1) < 0) _exit(127);
        if (dup2(stderr_fd, 2) < 0) _exit(127);
        /* Close everything else above 2 — keep pidfd open; setns needs it. */
        long max_fd = sysconf(_SC_OPEN_MAX);
        if (max_fd <= 0) max_fd = 1024;
        for (int f = 3; f < max_fd; f++) {
            if (f == pidfd) continue;
            close(f);
        }

        /* Move self into the right cgroup BEFORE joining the project's PID NS
         * so cgroup.procs sees our true host PID. Failure is fatal — billing
         * the child to the daemon's own cgroup is the regression we close.
         * adapterScope path: peer-supplied target cgroup (already validated
         * + project-bound). Default path: derive from the anchor's pidfd. */
        if (target_cgroup) {
            if (join_target_cgroup(target_cgroup, getpid(),
                                    ses->project) != 0) _exit(122);
        } else {
            if (join_anchor_cgroup(pidfd, getpid(), ses->project) != 0) _exit(122);
        }

        /* Join the anchor's mount + PID + net namespaces. */
        if (setns(pidfd, CLONE_NEWNS | CLONE_NEWPID | CLONE_NEWNET) != 0) _exit(126);

        /* Drop privileges to $SVC_USER. */
        struct passwd *pw = getpwnam(nsd_state_svc_user(state));
        if (!pw) _exit(125);
        uid_t svc_uid = pw->pw_uid;
        gid_t svc_gid = pw->pw_gid;
        if (drop_privs_to_svc(svc_uid, svc_gid) != 0) _exit(124);

        /* cd to project workspace. */
        char workdir[256];
        project_dir(workdir, sizeof(workdir),
                    pw->pw_dir ? pw->pw_dir : "/home", ses->project);
        if (chdir(workdir) != 0) {
            /* Fall back to home — the agent CLIs handle that. */
            (void) chdir(pw->pw_dir ? pw->pw_dir : "/");
        }

        /* Inline-unwrap any __byok-v1: env markers BEFORE execve. The
         * unwrapped plaintext lives only in the child's environ — never
         * on disk, never in the daemon's log. A failure to unwrap
         * (master rotated, secret rotated, ciphertext tampered, etc.)
         * is fatal: replacing the marker with a literal string would
         * exfil the marker as the agent's API key, and silently zeroing
         * the value would make the agent run with no key. Both are
         * worse than failing the spawn outright. */
        const struct nsd_byok_state *byok = nsd_state_byok(state);
        for (int i = 0; i < envc; i++) {
            bool fatal = false;
            char *replacement = unwrap_env_marker(envp[i], byok,
                                                   ses->project, &fatal);
            if (fatal) _exit(120);
            if (replacement) envp[i] = replacement;
        }

        /* Build the seccomp wrapper invocation. The wrapper applies the
         * denylist filter (allowlist mode is per-binary opt-in via
         * ELLUL_SECCOMP_MODE), then execs the target argv. We prepend
         * the wrapper's path so the target is its first non-self arg. */
        char *wrapped[ENTER_MAX_ARGV + 2];
        wrapped[0] = (char *)"/usr/local/bin/ellul-seccomp-exec";
        for (int i = 0; i <= argc; i++) wrapped[1 + i] = argv[i];

        /* Use child's envp if provided, else inherit (which is sparse
         * since we haven't unset anything from daemon's env). */
        char *const *use_envp = (envc > 0) ? (char *const *)envp : NULL;
        if (use_envp) execve(wrapped[0], wrapped, use_envp);
        else          execv(wrapped[0], wrapped);
        _exit(127);
    }

    /* PARENT. Hold a pidfd for the child so we can waitid(P_PIDFD). */
    int child_pidfd = sys_pidfd_open(child, 0);
    /* Either way, the kernel cleans up; we don't strictly need pidfd
     * for waitid since waitpid(child, ...) works because we ARE the
     * parent. But pidfd keeps the option open for future async wait. */
    (void) child_pidfd;
    close(pidfd);  /* anchor pidfd no longer needed */

    /* Send ENTER_RESPONSE before blocking on the child. */
    {
        uint8_t buf[64];
        buf[0] = NSD_OP_ENTER_RESPONSE;
        struct nsd_encoder enc;
        nsd_enc_init(&enc, buf + 1, sizeof(buf) - 1);
        nsd_enc_map_open(&enc, 3);
        nsd_enc_kv_uint(&enc, 1, request_id);
        nsd_enc_kv_bool(&enc, 2, true);
        nsd_enc_kv_uint(&enc, 3, (uint64_t)child);
        bool of; size_t n = nsd_enc_finish(&enc, &of);
        if (!of) (void) nsd_frame_write(conn_fd, buf, n + 1);
    }

    /* We've sent the response; close the bridge's stdio fds in the
     * daemon — the child has its own dup'd copies. The bridge keeps
     * the OTHER ends of these pipes. */
    close(stdin_fd);
    close(stdout_fd);
    close(stderr_fd);
    if (env_memfd >= 0) close(env_memfd);
    close(argv_memfd);
    free(env_blob);
    free(argv_blob);

    /* Block until child exits, then emit EXIT_NOTIFY. */
    int wstatus = 0;
    if (waitpid(child, &wstatus, 0) < 0) {
        nsd_event("nsd.enter.waitpid-fail",
                  "project", nsd_jstr(ses->project),
                  "errno", nsd_jnum(errno),
                  NULL);
    }
    int exit_code = WIFEXITED(wstatus) ? WEXITSTATUS(wstatus)
                  : (WIFSIGNALED(wstatus) ? -WTERMSIG(wstatus) : -255);

    /* Send EXIT_NOTIFY (server-initiated). */
    uint8_t buf[64];
    buf[0] = NSD_OP_EXIT_NOTIFY;
    struct nsd_encoder enc;
    nsd_enc_init(&enc, buf + 1, sizeof(buf) - 1);
    nsd_enc_map_open(&enc, 3);
    nsd_enc_kv_uint(&enc, 1, request_id);
    nsd_enc_kv_uint(&enc, 2, (uint64_t)child);
    nsd_enc_kv_int(&enc, 3, (int64_t)exit_code);
    bool of; size_t fn = nsd_enc_finish(&enc, &of);
    if (!of) (void) nsd_frame_write(conn_fd, buf, fn + 1);

    nsd_event("nsd.enter.done",
              "project", nsd_jstr(ses->project),
              "child_pid", nsd_jnum(child),
              "exit_code", nsd_jnum(exit_code),
              NULL);
    return 0;
}

/* ── INJECT_ENV handler ──────────────────────────────────── */

int nsd_inject_env_run(int conn_fd,
                       struct nsd_session *ses,
                       struct nsd_state *state,
                       uint64_t request_id,
                       int *fd_array, size_t fd_count,
                       char *out_path, size_t out_path_cap) {
    (void) conn_fd; (void) state;
    if (!ses->project) return -NSD_EPROTO;
    if (fd_count != 1) return -NSD_EFD_KIND;

    int env_memfd = fd_array[0];
    if (!memfd_seals_ok(env_memfd)) {
        nsd_event("nsd.inject_env.deny",
                  "project", nsd_jstr(ses->project),
                  "reason", nsd_jstr("env-memfd-not-sealed"),
                  NULL);
        return -NSD_EFD_KIND;
    }

    /* Read env content. */
    uint8_t *env_blob = malloc(ENTER_MAX_MEMFD_BYTES);
    if (!env_blob) return -NSD_EINTERNAL;
    ssize_t elen = read_memfd_all(env_memfd, env_blob, ENTER_MAX_MEMFD_BYTES);
    if (elen < 0) { free(env_blob); return -NSD_EFD_KIND; }
    /* Validate every entry. */
    char *envp[ENTER_MAX_ARGV];
    int envc = parse_argv_blob(env_blob, (size_t)elen, envp, ENTER_MAX_ARGV);
    if (envc < 0) { free(env_blob); return -NSD_EPROTO; }
    for (int i = 0; i < envc; i++) {
        if (!env_entry_ok(envp[i])) { free(env_blob); return -NSD_EPROTO; }
    }

    /* Read anchor PID + pidfd. */
    pid_t anchor_pid;
    if (read_anchor_pid(ses->project, &anchor_pid) != 0) {
        free(env_blob);
        return -NSD_EANCHOR_DEAD;
    }
    int pidfd = sys_pidfd_open(anchor_pid, 0);
    if (pidfd < 0) {
        free(env_blob);
        return -NSD_EANCHOR_DEAD;
    }

    /* Fork worker — same isolation pattern as ENTER. The worker setns'es
     * into the anchor's mount NS and writes the env file to a daemon-
     * controlled inode. The path is built from request_id; bridge cannot
     * specify it. */
    int report_pipe[2];
    if (pipe2(report_pipe, O_CLOEXEC) != 0) {
        close(pidfd); free(env_blob);
        return -NSD_EINTERNAL;
    }

    pid_t child = fork();
    if (child < 0) {
        close(report_pipe[0]); close(report_pipe[1]);
        close(pidfd); free(env_blob);
        return -NSD_EINTERNAL;
    }
    if (child == 0) {
        close(report_pipe[0]);
        if (setns(pidfd, CLONE_NEWNS) != 0) {
            uint8_t b = 1;
            (void) write(report_pipe[1], &b, 1);
            _exit(126);
        }
        char path[128];
        snprintf(path, sizeof(path), "/run/ellul-ns-env-%llu",
                 (unsigned long long)request_id);
        int wfd = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW |
                       O_CLOEXEC, 0600);
        if (wfd < 0) {
            uint8_t b = 2;
            (void) write(report_pipe[1], &b, 1);
            _exit(125);
        }
        /* Write env in shell-sourceable format: export KEY='VALUE'\n */
        for (int i = 0; i < envc; i++) {
            const char *eq = strchr(envp[i], '=');
            if (!eq) continue;
            size_t klen = (size_t)(eq - envp[i]);
            const char *val = eq + 1;
            char line[1024];
            int n = snprintf(line, sizeof(line), "export %.*s='", (int)klen, envp[i]);
            if (n < 0 || (size_t)n >= sizeof(line) - 4) continue;
            /* Shell-escape single quotes in val: '"'"' */
            size_t pos = (size_t)n;
            for (const char *v = val; *v; v++) {
                if (*v == '\'') {
                    if (pos + 5 >= sizeof(line)) break;
                    memcpy(line + pos, "'\\''", 4);
                    pos += 4;
                } else {
                    if (pos + 1 >= sizeof(line)) break;
                    line[pos++] = *v;
                }
            }
            if (pos + 2 >= sizeof(line)) continue;
            line[pos++] = '\'';
            line[pos++] = '\n';
            (void) write(wfd, line, pos);
        }
        struct passwd *pw = getpwnam(nsd_state_svc_user(state));
        if (pw) (void) fchown(wfd, pw->pw_uid, pw->pw_gid);
        close(wfd);
        uint8_t b = 0;
        (void) write(report_pipe[1], &b, 1);
        _exit(0);
    }

    close(report_pipe[1]);
    uint8_t status = 99;
    (void) read(report_pipe[0], &status, 1);
    close(report_pipe[0]);
    close(pidfd);
    free(env_blob);
    int wstatus = 0;
    waitpid(child, &wstatus, 0);

    if (status != 0) {
        nsd_event("nsd.inject_env.fail",
                  "project", nsd_jstr(ses->project),
                  "step", nsd_jnum(status),
                  NULL);
        return -NSD_ESTAGE_FAILED;
    }
    snprintf(out_path, out_path_cap, "/run/ellul-ns-env-%llu",
             (unsigned long long)request_id);
    nsd_event("nsd.inject_env.ok",
              "project", nsd_jstr(ses->project),
              "path", nsd_jstr(out_path),
              NULL);
    return 0;
}
