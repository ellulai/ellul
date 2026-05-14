/*
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 ellul.ai. All rights reserved.
 */

#define _GNU_SOURCE

#include "mount_stage.h"
#include "daemon_subexec.h"
#include "log.h"

#include <arpa/inet.h>
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <netdb.h>
#include <pwd.h>
#include <sched.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/poll.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#include <sodium.h>

/* ── Linux 5.2+ syscall numbers ──────────────────────────── */

#ifndef __NR_fsopen
#define __NR_fsopen        430
#endif
#ifndef __NR_fsconfig
#define __NR_fsconfig      431
#endif
#ifndef __NR_fsmount
#define __NR_fsmount       432
#endif
#ifndef __NR_move_mount
#define __NR_move_mount    429
#endif
#ifndef __NR_open_tree
#define __NR_open_tree     428
#endif
#ifndef __NR_mount_setattr
#define __NR_mount_setattr 442
#endif
#ifndef __NR_clone3
#define __NR_clone3        435
#endif
#ifndef __NR_pidfd_open
#define __NR_pidfd_open    434
#endif
#ifndef __NR_pidfd_send_signal
#define __NR_pidfd_send_signal 424
#endif

/* fsconfig commands */
#ifndef FSCONFIG_SET_FLAG
#define FSCONFIG_SET_FLAG    0
#define FSCONFIG_SET_STRING  1
#define FSCONFIG_SET_BINARY  2
#define FSCONFIG_SET_PATH    3
#define FSCONFIG_SET_FD      5
#define FSCONFIG_CMD_CREATE  6
#define FSCONFIG_CMD_RECONFIGURE 7
#endif
#ifndef FSOPEN_CLOEXEC
#define FSOPEN_CLOEXEC       0x00000001
#endif
#ifndef FSMOUNT_CLOEXEC
#define FSMOUNT_CLOEXEC      0x00000001
#endif

/* mount_setattr */
#ifndef MOUNT_ATTR_RDONLY
#define MOUNT_ATTR_RDONLY    0x00000001
#define MOUNT_ATTR_NOSUID    0x00000002
#define MOUNT_ATTR_NODEV     0x00000004
#define MOUNT_ATTR_NOEXEC    0x00000008
#endif
#ifndef AT_RECURSIVE
#define AT_RECURSIVE         0x8000
#endif
#ifndef AT_NO_AUTOMOUNT
#define AT_NO_AUTOMOUNT      0x800
#endif
#ifndef AT_EMPTY_PATH
#define AT_EMPTY_PATH        0x1000
#endif

/* open_tree / move_mount */
#ifndef OPEN_TREE_CLONE
#define OPEN_TREE_CLONE      1
#endif
#ifndef OPEN_TREE_CLOEXEC
#define OPEN_TREE_CLOEXEC    O_CLOEXEC
#endif
#ifndef MOVE_MOUNT_F_EMPTY_PATH
#define MOVE_MOUNT_F_EMPTY_PATH 0x00000004
#define MOVE_MOUNT_T_EMPTY_PATH 0x00000040
#endif

#ifndef MS_PRIVATE
#define MS_PRIVATE           (1<<18)
#define MS_REC               (1<<14)
#endif

#ifndef CLONE_INTO_CGROUP
#define CLONE_INTO_CGROUP    0x200000000ULL
#endif

/* clone3 */
struct nsd_clone_args {
    uint64_t flags;
    uint64_t pidfd;
    uint64_t child_tid;
    uint64_t parent_tid;
    uint64_t exit_signal;
    uint64_t stack;
    uint64_t stack_size;
    uint64_t tls;
    uint64_t set_tid;
    uint64_t set_tid_size;
    uint64_t cgroup;
};

struct nsd_mount_attr {
    uint64_t attr_set;
    uint64_t attr_clr;
    uint64_t propagation;
    uint64_t userns_fd;
};

/* ── Syscall wrappers ────────────────────────────────────── */

static int sys_fsopen(const char *fs, unsigned f) {
    return (int)syscall(__NR_fsopen, fs, f);
}
static int sys_fsconfig(int fd, unsigned cmd, const char *k, const void *v, int aux) {
    return (int)syscall(__NR_fsconfig, fd, cmd, k, v, aux);
}
static int sys_fsmount(int fd, unsigned flags, unsigned attr) {
    return (int)syscall(__NR_fsmount, fd, flags, attr);
}
static int sys_move_mount(int from_dfd, const char *from,
                          int to_dfd, const char *to, unsigned flags) {
    return (int)syscall(__NR_move_mount, from_dfd, from, to_dfd, to, flags);
}
static int sys_open_tree(int dfd, const char *path, unsigned flags) {
    return (int)syscall(__NR_open_tree, dfd, path, flags);
}
static int sys_mount_setattr(int dfd, const char *path, unsigned flags,
                             struct nsd_mount_attr *a, size_t sz) {
    return (int)syscall(__NR_mount_setattr, dfd, path, flags, a, sz);
}
static int sys_clone3(struct nsd_clone_args *a, size_t sz) {
    return (int)syscall(__NR_clone3, a, sz);
}
static int sys_pidfd_open(pid_t pid, unsigned flags) {
    return (int)syscall(__NR_pidfd_open, pid, flags);
}
static int sys_pidfd_signal(int pidfd, int sig) {
    return (int)syscall(__NR_pidfd_send_signal, pidfd, sig, NULL, 0);
}

/* ── Constants ───────────────────────────────────────────── */

#define NSD_MOUNT_OVL_DIRS \
    ".config", ".claude", ".codex", ".cursor", ".opencode", \
    ".ellul", ".local", ".zeroclaw", ".cache", \
    ".bun", ".npm"
static const char *const NSD_OVL_DIRS[] = { NSD_MOUNT_OVL_DIRS, NULL };

static const char *const NSD_DOTFILES[] = { ".claude.json", ".gitconfig", NULL };

static const char *const NSD_CTX_FILES[] = { "CLAUDE.md", "AGENTS.md", "GEMINI.md", NULL };

/* Inside the agent namespace these directories are tmpfs blackholes — agent
 * can stat the path but never enumerate or read what's behind it on the host.
 * Each entry below is something an escaped agent could otherwise probe:
 *   /etc/ellul/shield-data      passkey + JWT secret store
 *   /etc/ellul                   vault root (auth db, secrets, settings)
 *   /etc/ellul-bootstrap        per-boot identity (server-id, signing keys)
 *   /var/lib/ellul-shielded     LUKS-shielded vault contents
 *   /var/lib/ellul              BYOK per-project secret root
 *   /run/shield                  shield socket dir (legacy)
 *   /run/ellul-ns                daemon admin + per-project socket dir —
 *                                without this an agent can connect to the
 *                                socket; auth would still reject it but
 *                                hiding the entry-point is defence in depth */
static const char *const NSD_SHIELD_BLACKHOLES[] = {
    "/etc/ellul",
    "/etc/ellul-bootstrap",
    "/var/lib/ellul-shielded",
    "/var/lib/ellul",
    "/run/shield",
    "/run/ellul-ns",
    NULL,
};

static const char *const NSD_BYOK_DOMAINS[] = {
    "api.anthropic.com",
    "api.openai.com",
    "generativelanguage.googleapis.com",
    "openrouter.ai",
    "api.deepseek.com",
    "api.mistral.ai",
    "api.x.ai",
    "api.groq.com",
    NULL,
};

static const char *const NSD_EGRESS_DOMAINS[] = {
    "opencode.ai", "api.cursor.com", "cursor.sh",
    "api2.cursor.sh", "repo42.cursor.sh",
    "models.dev",
    "anthropic.com", "api.anthropic.com", "console.anthropic.com",
    "claude.ai", "claude.com",
    "openai.com", "api.openai.com", "auth.openai.com",
    "chatgpt.com",
    "generativelanguage.googleapis.com", "googleapis.com",
    "registry.npmjs.org", "pypi.org", "files.pythonhosted.org",
    "crates.io", "static.crates.io",
    "proxy.golang.org", "sum.golang.org", "rubygems.org",
    "github.com", "codeload.github.com", "raw.githubusercontent.com",
    "objects.githubusercontent.com", "ghcr.io",
    "docker.io", "docker.com", "registry-1.docker.io",
    NULL,
};

static const char ETC_HOSTS_BEGIN[] = "# === ELLUL_EGRESS_BEGIN ===";
static const char ETC_HOSTS_END[]   = "# === ELLUL_EGRESS_END ===";

static const char *const NSD_BIN_IP        = "/usr/sbin/ip";
static const char *const NSD_BIN_IPTABLES  = "/usr/sbin/iptables";
static const char *const NSD_BIN_IPTRESTOR = "/usr/sbin/iptables-restore";
static const char *const NSD_BIN_IPSET     = "/usr/sbin/ipset";
static const char *const NSD_BIN_SLEEP     = "/usr/bin/sleep";

char *const NSD_ENVP_SAFE[] = {
    (char *)"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    (char *)"LANG=C.UTF-8",
    NULL,
};

#define NSD_READY_TIMEOUT_S      60
#define NSD_PHASE_BUF_BYTES      64
#define NSD_ERR_BUF_BYTES        256
#define NSD_REPORT_OK            0
#define NSD_REPORT_FAIL          1

/* ── Helpers ─────────────────────────────────────────────── */

static bool slug_ok(const char *s) {
    if (!s || strlen(s) != NSD_PROJECT_SLUG_LEN) return false;
    if (strncmp(s, "sbx-", 4) != 0) return false;
    for (int i = 4; i < NSD_PROJECT_SLUG_LEN; i++) {
        char c = s[i];
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'))) return false;
    }
    return true;
}

static bool path_under(const char *path, const char *root) {
    size_t r = strlen(root);
    if (strncmp(path, root, r) != 0) return false;
    return path[r] == '/' || path[r] == '\0';
}

static int read_file_trim(const char *path, char *out, size_t cap) {
    int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return -1;
    ssize_t n = read(fd, out, cap - 1);
    close(fd);
    if (n <= 0) return -1;
    while (n > 0 && (out[n-1] == '\n' || out[n-1] == '\r' ||
                     out[n-1] == ' '  || out[n-1] == '\t')) n--;
    out[n] = 0;
    return (int)n;
}

static int write_file_atomic(const char *path, const char *content,
                             size_t len, mode_t mode, uid_t uid, gid_t gid) {
    char tmp[PATH_MAX];
    int n = snprintf(tmp, sizeof(tmp), "%s.tmp.%d", path, (int)getpid());
    if (n <= 0 || n >= (int)sizeof(tmp)) return -1;
    int fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC, mode);
    if (fd < 0) return -1;
    size_t off = 0;
    while (off < len) {
        ssize_t w = write(fd, content + off, len - off);
        if (w < 0) {
            if (errno == EINTR) continue;
            close(fd); unlink(tmp); return -1;
        }
        off += (size_t)w;
    }
    if (uid != (uid_t)-1) {
        if (fchown(fd, uid, gid) != 0) { close(fd); unlink(tmp); return -1; }
    }
    if (fsync(fd) != 0) { close(fd); unlink(tmp); return -1; }
    close(fd);
    if (rename(tmp, path) != 0) { unlink(tmp); return -1; }
    return 0;
}

/* ── HMAC IP derivation (mirrors NamespaceSpawn.ts + spawn.sh) ── */

static int derive_ips(const char *project, char host_ip[16], char ns_ip[16]) {
    char key[256];
    int n = read_file_trim("/etc/ellul/jwt-secret", key, sizeof(key));
    if (n <= 0) {
        n = read_file_trim("/etc/machine-id", key, sizeof(key));
    }
    if (n <= 0) return -1;

    uint8_t hash[crypto_auth_hmacsha256_BYTES];
    crypto_auth_hmacsha256_state st;
    crypto_auth_hmacsha256_init(&st, (const unsigned char *)key, (size_t)n);
    crypto_auth_hmacsha256_update(&st, (const unsigned char *)project, strlen(project));
    crypto_auth_hmacsha256_final(&st, hash);
    sodium_memzero(key, sizeof(key));

    int o1 = (hash[0] % 55) + 200;
    int o2 = hash[1];
    int o3 = hash[2] & 0xFC;
    snprintf(host_ip, 16, "10.%d.%d.%d", o1, o2, o3 + 1);
    snprintf(ns_ip,   16, "10.%d.%d.%d", o1, o2, o3 + 2);
    return 0;
}

/* ── Subprocess runner ───────────────────────────────────── */

static int run_argv(const char *path, char *const argv[]) {
    char errbuf[512];
    int exit_st = -1, sig_st = 0;
    int rc = nsd_subexec_run(path, argv, NULL, 0,
                             errbuf, sizeof(errbuf), NULL,
                             &exit_st, &sig_st);
    if (rc != 0) {
        char argv_join[512];
        size_t off = 0;
        for (int i = 0; argv[i] && off < sizeof(argv_join) - 2; i++) {
            int n = snprintf(argv_join + off, sizeof(argv_join) - off, "%s%s", i ? " " : "", argv[i]);
            if (n < 0) break;
            off += (size_t)n;
        }
        argv_join[sizeof(argv_join) - 1] = 0;
        nsd_event("nsd.subexec.exec.fail",
                  "path", nsd_jstr(path),
                  "argv", nsd_jstr(argv_join),
                  "exit", nsd_jnum((long long)exit_st),
                  "signal", nsd_jnum((long long)sig_st),
                  "stderr", nsd_jstr(errbuf),
                  NULL);
    }
    return rc;
}

static int run_argv_stdin(const char *path, char *const argv[],
                          const char *input, size_t input_len) {
    char errbuf[512];
    int exit_st = -1, sig_st = 0;
    int rc = nsd_subexec_run(path, argv, input, input_len,
                             errbuf, sizeof(errbuf), NULL,
                             &exit_st, &sig_st);
    if (rc != 0) {
        nsd_event("nsd.subexec.exec.fail",
                  "path", nsd_jstr(path),
                  "stdin_bytes", nsd_jnum((long long)input_len),
                  "exit", nsd_jnum((long long)exit_st),
                  "signal", nsd_jnum((long long)sig_st),
                  "stderr", nsd_jstr(errbuf),
                  NULL);
    }
    return rc;
}

/* Worker dies on phase failure; kernel reaps the namespace and unmounts the
 * staging tree atomically. No userspace rollback needed — the namespace's
 * mount table goes with the PID NS. */

struct nsd_stage {
    const struct nsd_mount_stage_input *in;

    int  home_dfd;
    int  scratch_dfd;
    int  proc_dfd;
    int  cgroup_dfd;
    int  netns_fd;

    int  report_w;

    char phase[NSD_PHASE_BUF_BYTES];
    char errbuf[NSD_ERR_BUF_BYTES];
};

static void stage_set_phase(struct nsd_stage *s, const char *p) {
    snprintf(s->phase, sizeof(s->phase), "%s", p ? p : "");
}
static void stage_set_err(struct nsd_stage *s, const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(s->errbuf, sizeof(s->errbuf), fmt, ap);
    va_end(ap);
}

/* ── New-mount-API helpers ───────────────────────────────── */

static int mkdirat_idem(int dfd, const char *name, mode_t mode) {
    if (mkdirat(dfd, name, mode) == 0) return 0;
    if (errno == EEXIST) return 0;
    return -1;
}

static int chownat_if(int dfd, const char *name, uid_t uid, gid_t gid) {
    return fchownat(dfd, name, uid, gid, AT_SYMLINK_NOFOLLOW);
}

static unsigned mm_to_flags(const char *to_name) {
    unsigned f = MOVE_MOUNT_F_EMPTY_PATH;
    if (!to_name || to_name[0] == 0) f |= MOVE_MOUNT_T_EMPTY_PATH;
    return f;
}

/* Single-event surface for mount_tmpfs failures: emit one structured event
 * naming the new-mount-API call that returned non-zero plus its errno, so
 * a stage failure can be diagnosed without per-step log spam. */
static void emit_mount_tmpfs_fail(const char *step, int e,
                                  const char *target_name) {
    nsd_event("nsd.stage.mount.fail",
              "fs",          nsd_jstr("tmpfs"),
              "step",        nsd_jstr(step),
              "errno",       nsd_jnum((long long)e),
              "target_name", nsd_jstr(target_name ? target_name : ""),
              NULL);
}

static int mount_tmpfs(int target_dfd, const char *target_name,
                       const char *size_opt, const char *mode_opt,
                       const char *uid_opt, const char *gid_opt) {
    int fs = sys_fsopen("tmpfs", FSOPEN_CLOEXEC);
    if (fs < 0)                                                            { emit_mount_tmpfs_fail("fsopen",          errno, target_name); return -1; }
    int rc = -1;
    if (size_opt && sys_fsconfig(fs, FSCONFIG_SET_STRING, "size", size_opt, 0) != 0) { emit_mount_tmpfs_fail("fsconfig.size",   errno, target_name); goto out; }
    if (mode_opt && sys_fsconfig(fs, FSCONFIG_SET_STRING, "mode", mode_opt, 0) != 0) { emit_mount_tmpfs_fail("fsconfig.mode",   errno, target_name); goto out; }
    if (uid_opt  && sys_fsconfig(fs, FSCONFIG_SET_STRING, "uid",  uid_opt,  0) != 0) { emit_mount_tmpfs_fail("fsconfig.uid",    errno, target_name); goto out; }
    if (gid_opt  && sys_fsconfig(fs, FSCONFIG_SET_STRING, "gid",  gid_opt,  0) != 0) { emit_mount_tmpfs_fail("fsconfig.gid",    errno, target_name); goto out; }
    if (sys_fsconfig(fs, FSCONFIG_CMD_CREATE, NULL, NULL, 0) != 0)         { emit_mount_tmpfs_fail("fsconfig.create", errno, target_name); goto out; }
    int mfd = sys_fsmount(fs, FSMOUNT_CLOEXEC, 0);
    if (mfd < 0)                                                           { emit_mount_tmpfs_fail("fsmount",         errno, target_name); goto out; }
    if (sys_move_mount(mfd, "", target_dfd, target_name ? target_name : "",
                       mm_to_flags(target_name)) != 0) {
        emit_mount_tmpfs_fail("move_mount", errno, target_name);
        close(mfd); goto out;
    }
    close(mfd);
    rc = 0;
out:
    close(fs);
    return rc;
}

static int mount_proc_hidepid2(int target_dfd, const char *target_name) {
    int fs = sys_fsopen("proc", FSOPEN_CLOEXEC);
    if (fs < 0) return -1;
    int rc = -1;
    if (sys_fsconfig(fs, FSCONFIG_SET_STRING, "hidepid", "2", 0) != 0) goto out;
    if (sys_fsconfig(fs, FSCONFIG_CMD_CREATE, NULL, NULL, 0) != 0) goto out;
    int mfd = sys_fsmount(fs, FSMOUNT_CLOEXEC, 0);
    if (mfd < 0) goto out;
    if (sys_move_mount(mfd, "", target_dfd, target_name ? target_name : "",
                       mm_to_flags(target_name)) != 0) {
        close(mfd); goto out;
    }
    close(mfd);
    rc = 0;
out:
    close(fs);
    return rc;
}

static int mount_overlay(int target_dfd, const char *target_name,
                         const char *lowerdir, const char *upperdir,
                         const char *workdir) {
    int fs = sys_fsopen("overlay", FSOPEN_CLOEXEC);
    if (fs < 0) return -1;
    int rc = -1;
    if (sys_fsconfig(fs, FSCONFIG_SET_STRING, "source", "overlay", 0) != 0) {
        /* "source" not required on every kernel; ignore. */
    }
    if (sys_fsconfig(fs, FSCONFIG_SET_STRING, "lowerdir", lowerdir, 0) != 0) goto out;
    if (sys_fsconfig(fs, FSCONFIG_SET_STRING, "upperdir", upperdir, 0) != 0) goto out;
    if (sys_fsconfig(fs, FSCONFIG_SET_STRING, "workdir",  workdir,  0) != 0) goto out;
    if (sys_fsconfig(fs, FSCONFIG_CMD_CREATE, NULL, NULL, 0) != 0) goto out;
    int mfd = sys_fsmount(fs, FSMOUNT_CLOEXEC, 0);
    if (mfd < 0) goto out;
    if (sys_move_mount(mfd, "", target_dfd, target_name ? target_name : "",
                       mm_to_flags(target_name)) != 0) {
        close(mfd); goto out;
    }
    close(mfd);
    rc = 0;
out:
    close(fs);
    return rc;
}

static int mount_bind_at(int src_dfd, const char *src_name,
                         int dst_dfd, const char *dst_name) {
    unsigned ot_flags = OPEN_TREE_CLONE | OPEN_TREE_CLOEXEC | AT_NO_AUTOMOUNT;
    if (!src_name || src_name[0] == 0) ot_flags |= AT_EMPTY_PATH;
    int tree = sys_open_tree(src_dfd, src_name ? src_name : "", ot_flags);
    if (tree < 0) return -1;
    if (sys_move_mount(tree, "", dst_dfd, dst_name ? dst_name : "",
                       mm_to_flags(dst_name)) != 0) {
        close(tree); return -1;
    }
    close(tree);
    return 0;
}

static int mount_setattr_ro(int dfd, const char *path) {
    struct nsd_mount_attr a = { .attr_set = MOUNT_ATTR_RDONLY };
    unsigned flags = AT_NO_AUTOMOUNT;
    if (!path || path[0] == 0) flags |= AT_EMPTY_PATH;
    return sys_mount_setattr(dfd, path ? path : "", flags, &a, sizeof(a));
}

/* ── Stale cleanup ───────────────────────────────────────── */

static void kill_pidfile(const char *path) {
    int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return;
    char buf[32] = {0};
    ssize_t r = read(fd, buf, sizeof(buf) - 1);
    close(fd);
    if (r <= 0) return;
    long pid = strtol(buf, NULL, 10);
    if (pid <= 1 || pid > (1L << 22)) return;
    int pidfd = sys_pidfd_open((pid_t)pid, 0);
    if (pidfd < 0) return;
    (void) sys_pidfd_signal(pidfd, SIGKILL);
    /* No waitpid — process isn't our child. Wait briefly for kernel to reap. */
    for (int i = 0; i < 50; i++) {
        if (sys_pidfd_signal(pidfd, 0) != 0 && errno == ESRCH) break;
        struct timespec ts = { .tv_sec = 0, .tv_nsec = 20 * 1000 * 1000 };
        nanosleep(&ts, NULL);
    }
    close(pidfd);
}

static void rm_recursive(const char *path) {
    DIR *d = opendir(path);
    if (!d) return;
    struct dirent *e;
    while ((e = readdir(d)) != NULL) {
        if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0) continue;
        char child[PATH_MAX];
        snprintf(child, sizeof(child), "%s/%s", path, e->d_name);
        struct stat sb;
        if (lstat(child, &sb) == 0 && S_ISDIR(sb.st_mode)) rm_recursive(child);
        else unlink(child);
    }
    closedir(d);
    rmdir(path);
}

static void exec_silent(const char *bin, char *const argv[]) {
    int exit_st = -1, sig_st = 0;
    (void) nsd_subexec_run(bin, argv, NULL, 0, NULL, 0, NULL, &exit_st, &sig_st);
}

static void stale_cleanup(const char *project) {
    char run_dir[PATH_MAX];
    char anchor_pid[PATH_MAX];
    char ready_sentinel[PATH_MAX];
    char ns_name[64];
    char short_id[16];
    char veth_host[32];

    snprintf(run_dir,        sizeof(run_dir),        "/run/.ns-%s",         project);
    snprintf(anchor_pid,     sizeof(anchor_pid),     "/run/.ns-%s/anchor.pid", project);
    snprintf(ready_sentinel, sizeof(ready_sentinel), "/run/.ns-ready-%s",   project);
    snprintf(ns_name,        sizeof(ns_name),        "ellul-%s",            project);
    snprintf(short_id,       sizeof(short_id),       "%s",                  project + 4);
    snprintf(veth_host,      sizeof(veth_host),      "ea-%s",               short_id);

    kill_pidfile(anchor_pid);

    char *ip_link_del[] = {
        (char *)NSD_BIN_IP, (char *)"link", (char *)"del", veth_host, NULL
    };
    exec_silent(NSD_BIN_IP, ip_link_del);

    /* netns file lives in PID 1's mount NS (created via nsenter) — must
     * also delete via PID 1's mount NS or stale state survives. */
    char *ip_netns_del[] = {
        (char *)"/usr/bin/nsenter", (char *)"--target", (char *)"1", (char *)"--mount",
        (char *)"--", (char *)NSD_BIN_IP, (char *)"netns", (char *)"del", ns_name, NULL
    };
    exec_silent("/usr/bin/nsenter", ip_netns_del);

    rm_recursive(run_dir);
    unlink(ready_sentinel);
}

/* ── Network setup ───────────────────────────────────────── */

static int sysctl_via_pid1(const char *key, const char *value) {
    /* Daemon's systemd unit has ProtectKernelTunables=true → /proc/sys is RO
     * in our mount NS. Route the write via PID 1's mount NS using nsenter. */
    char arg[256];
    snprintf(arg, sizeof(arg), "echo %s > /proc/sys/%s", value, key);
    char *argv[] = {
        (char *)"/usr/bin/nsenter",
        (char *)"--target", (char *)"1", (char *)"--mount",
        (char *)"--", (char *)"/usr/bin/sh", (char *)"-c", arg, NULL
    };
    return run_argv("/usr/bin/nsenter", argv);
}

static int ensure_egress_ipset(void) {
    char *list_argv[] = {
        (char *)NSD_BIN_IPSET, (char *)"list", (char *)"-n", (char *)"ellul-egress", NULL
    };
    if (run_argv(NSD_BIN_IPSET, list_argv) == 0) return 0;
    char *create_argv[] = {
        (char *)NSD_BIN_IPSET, (char *)"create", (char *)"ellul-egress",
        (char *)"hash:ip", (char *)"family", (char *)"inet",
        (char *)"hashsize", (char *)"1024",
        (char *)"maxelem", (char *)"65536",
        (char *)"timeout", (char *)"3600",
        NULL
    };
    return run_argv(NSD_BIN_IPSET, create_argv);
}

struct egress_buf {
    char  *data;
    size_t len;
    size_t cap;
};

static int eb_grow(struct egress_buf *b, size_t need) {
    if (b->len + need + 1 <= b->cap) return 0;
    size_t newcap = b->cap ? b->cap * 2 : 4096;
    while (newcap < b->len + need + 1) newcap *= 2;
    char *p = realloc(b->data, newcap);
    if (!p) return -1;
    b->data = p;
    b->cap = newcap;
    return 0;
}

static int eb_appendf(struct egress_buf *b, const char *fmt, ...) {
    va_list ap, ap2;
    va_start(ap, fmt);
    va_copy(ap2, ap);
    int n = vsnprintf(NULL, 0, fmt, ap);
    va_end(ap);
    if (n < 0) { va_end(ap2); return -1; }
    if (eb_grow(b, (size_t)n) != 0) { va_end(ap2); return -1; }
    vsnprintf(b->data + b->len, b->cap - b->len, fmt, ap2);
    va_end(ap2);
    b->len += (size_t)n;
    return 0;
}

static int read_zone_file(const char *path, char *buf, size_t bufsz) {
    int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return -1;
    ssize_t n = read(fd, buf, bufsz - 1);
    close(fd);
    if (n <= 0) return -1;
    while (n > 0 && (buf[n-1] == '\n' || buf[n-1] == '\r')) n--;
    buf[n] = '\0';
    return 0;
}

static void resolve_domain_to_egress(struct egress_buf *hosts_block, const char *domain) {
    struct addrinfo hints = { .ai_family = AF_INET, .ai_socktype = SOCK_STREAM };
    struct addrinfo *res = NULL;
    if (getaddrinfo(domain, NULL, &hints, &res) != 0) return;
    for (struct addrinfo *p = res; p; p = p->ai_next) {
        char ipbuf[INET_ADDRSTRLEN];
        struct sockaddr_in *sa = (struct sockaddr_in *)p->ai_addr;
        if (!inet_ntop(AF_INET, &sa->sin_addr, ipbuf, sizeof(ipbuf))) continue;
        char *ipset_add[] = {
            (char *)NSD_BIN_IPSET, (char *)"add", (char *)"ellul-egress",
            ipbuf, (char *)"-exist", NULL
        };
        (void) run_argv(NSD_BIN_IPSET, ipset_add);
        (void) eb_appendf(hosts_block, "%s %s\n", ipbuf, domain);
    }
    freeaddrinfo(res);
}

static int populate_egress_allowlist(struct egress_buf *hosts_block) {
    if (eb_appendf(hosts_block, "%s\n", ETC_HOSTS_BEGIN) != 0) return -1;

    for (int i = 0; NSD_EGRESS_DOMAINS[i]; i++)
        resolve_domain_to_egress(hosts_block, NSD_EGRESS_DOMAINS[i]);

    char pz[256] = {0}, az[256] = {0}, api_pz[512] = {0};
    if (read_zone_file("/etc/ellul/platform-zone", pz, sizeof(pz)) == 0 && pz[0]) {
        resolve_domain_to_egress(hosts_block, pz);
        snprintf(api_pz, sizeof(api_pz), "api.%s", pz);
        resolve_domain_to_egress(hosts_block, api_pz);
    }
    if (read_zone_file("/etc/ellul/app-zone", az, sizeof(az)) == 0 && az[0])
        resolve_domain_to_egress(hosts_block, az);

    if (eb_appendf(hosts_block, "%s\n", ETC_HOSTS_END) != 0) return -1;
    return 0;
}

static int merge_etc_hosts(const char *block, size_t block_len) {
    int fd = open("/etc/hosts", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return -1;
    struct stat sb;
    if (fstat(fd, &sb) != 0) { close(fd); return -1; }
    size_t cap = (size_t)sb.st_size + block_len + 4096;
    char *cur = malloc((size_t)sb.st_size + 1);
    if (!cur) { close(fd); return -1; }
    ssize_t r = 0;
    size_t off = 0;
    while (off < (size_t)sb.st_size) {
        r = read(fd, cur + off, (size_t)sb.st_size - off);
        if (r < 0) {
            if (errno == EINTR) continue;
            free(cur); close(fd); return -1;
        }
        if (r == 0) break;
        off += (size_t)r;
    }
    close(fd);
    cur[off] = 0;

    char *out = malloc(cap);
    if (!out) { free(cur); return -1; }
    size_t out_len = 0;
    char *line = cur;
    bool skip = false;
    while (line < cur + off) {
        char *eol = strchr(line, '\n');
        size_t llen = eol ? (size_t)(eol - line) + 1 : (size_t)(cur + off - line);
        if (strncmp(line, ETC_HOSTS_BEGIN, sizeof(ETC_HOSTS_BEGIN) - 1) == 0) {
            skip = true;
        }
        if (!skip) {
            memcpy(out + out_len, line, llen);
            out_len += llen;
        }
        if (skip && strncmp(line, ETC_HOSTS_END, sizeof(ETC_HOSTS_END) - 1) == 0) {
            skip = false;
        }
        if (!eol) break;
        line = eol + 1;
    }
    if (out_len > 0 && out[out_len - 1] != '\n') out[out_len++] = '\n';
    memcpy(out + out_len, block, block_len);
    out_len += block_len;

    int rc = write_file_atomic("/etc/hosts", out, out_len, 0644, 0, 0);
    free(out);
    free(cur);
    return rc;
}

static int network_setup(const struct nsd_mount_stage_input *in,
                         const char *host_ip, const char *ns_ip,
                         const char *ns_name, const char *veth_host,
                         const char *veth_ns,
                         char *err, size_t err_cap) {
    char host_cidr[24], ns_cidr[24];
    snprintf(host_cidr, sizeof(host_cidr), "%s/30", host_ip);
    snprintf(ns_cidr,   sizeof(ns_cidr),   "%s/32", ns_ip);

    char *netns_add[] = {
        (char *)"/usr/bin/nsenter", (char *)"--target", (char *)"1", (char *)"--mount",
        (char *)"--", (char *)NSD_BIN_IP, (char *)"netns", (char *)"add", (char *)ns_name, NULL
    };
    if (run_argv("/usr/bin/nsenter", netns_add) != 0) {
        snprintf(err, err_cap, "ip netns add %s failed", ns_name);
        return -1;
    }

    char *veth_add[] = {
        (char *)NSD_BIN_IP, (char *)"link", (char *)"add", (char *)veth_host,
        (char *)"type", (char *)"veth", (char *)"peer", (char *)"name", (char *)veth_ns, NULL
    };
    if (run_argv(NSD_BIN_IP, veth_add) != 0) {
        snprintf(err, err_cap, "ip link add veth pair failed");
        return -1;
    }

    char *veth_move[] = {
        (char *)NSD_BIN_IP, (char *)"link", (char *)"set", (char *)veth_ns,
        (char *)"netns", (char *)ns_name, NULL
    };
    if (run_argv(NSD_BIN_IP, veth_move) != 0) {
        snprintf(err, err_cap, "ip link set %s netns %s failed", veth_ns, ns_name);
        return -1;
    }

    char *host_addr[] = {
        (char *)NSD_BIN_IP, (char *)"addr", (char *)"add", (char *)host_cidr,
        (char *)"dev", (char *)veth_host, NULL
    };
    if (run_argv(NSD_BIN_IP, host_addr) != 0) {
        snprintf(err, err_cap, "ip addr add %s failed", host_cidr);
        return -1;
    }

    char *host_up[] = {
        (char *)NSD_BIN_IP, (char *)"link", (char *)"set", (char *)veth_host, (char *)"up", NULL
    };
    if (run_argv(NSD_BIN_IP, host_up) != 0) {
        snprintf(err, err_cap, "ip link set %s up failed", veth_host);
        return -1;
    }

    (void) sysctl_via_pid1("net/ipv4/ip_forward", "1");
    char rl_key[128];
    snprintf(rl_key, sizeof(rl_key), "net/ipv4/conf/%s/route_localnet", veth_host);
    (void) sysctl_via_pid1(rl_key, "1");

    if (ensure_egress_ipset() != 0) {
        snprintf(err, err_cap, "ipset create ellul-egress failed");
        return -1;
    }

    struct egress_buf hosts_block = {0};
    (void) populate_egress_allowlist(&hosts_block);
    if (hosts_block.len > 0) {
        (void) merge_etc_hosts(hosts_block.data, hosts_block.len);
    }
    free(hosts_block.data);

    struct egress_buf rules = {0};
    if (eb_appendf(&rules,
        "*nat\n"
        "-A POSTROUTING -s %s -j MASQUERADE\n"
        "-A PREROUTING -s %s -d %s/32 -p tcp --dport 18790 -j DNAT --to-destination 127.0.0.1:18790\n"
        "-A PREROUTING -s %s -d %s/32 -p tcp --dport 7701 -j DNAT --to-destination 127.0.0.1:7701\n"
        "-A PREROUTING -s %s -d %s/32 -p tcp --dport 7702 -j DNAT --to-destination 127.0.0.1:7702\n"
        "COMMIT\n"
        "*filter\n"
        "-I OUTPUT -d %s -j ACCEPT\n"
        "-I FORWARD -d %s -m state --state RELATED,ESTABLISHED -j ACCEPT\n"
        "-I FORWARD -s %s -j ACCEPT\n"
        "-I FORWARD -s %s -m set ! --match-set ellul-egress dst -j DROP\n"
        "-I FORWARD -s %s -d 192.168.0.0/16 -j DROP\n"
        "-I FORWARD -s %s -d 172.16.0.0/12 -j DROP\n"
        "-I FORWARD -s %s -d 10.0.0.0/8 -j DROP\n"
        "-I FORWARD -s %s -d 169.254.0.0/16 -j DROP\n"
        "-I FORWARD -s %s -d %s/30 -j ACCEPT\n"
        "-I FORWARD -s %s -p tcp --dport 53 -j DROP\n"
        "-I FORWARD -s %s -p udp --dport 53 -j DROP\n"
        "COMMIT\n",
        ns_cidr, ns_cidr, host_ip, ns_cidr, host_ip, ns_cidr, host_ip,
        ns_cidr, ns_cidr, ns_cidr, ns_cidr,
        ns_cidr, ns_cidr, ns_cidr, ns_cidr,
        ns_cidr, host_ip, ns_cidr, ns_cidr) != 0) {
        snprintf(err, err_cap, "iptables rule buffer alloc failed");
        free(rules.data);
        return -1;
    }

    char *ipt_restore[] = {
        (char *)NSD_BIN_IPTRESTOR, (char *)"--noflush", NULL
    };
    if (run_argv_stdin(NSD_BIN_IPTRESTOR, ipt_restore, rules.data, rules.len) != 0) {
        snprintf(err, err_cap, "iptables-restore failed");
        free(rules.data);
        return -1;
    }
    free(rules.data);

    char ns_addr_arg[24];
    snprintf(ns_addr_arg, sizeof(ns_addr_arg), "%s/30", ns_ip);

    char *exec_lo_up[] = {
        (char *)NSD_BIN_IP, (char *)"netns", (char *)"exec", (char *)ns_name,
        (char *)NSD_BIN_IP, (char *)"link", (char *)"set", (char *)"lo", (char *)"up", NULL
    };
    if (run_argv(NSD_BIN_IP, exec_lo_up) != 0) {
        snprintf(err, err_cap, "ns lo up failed");
        return -1;
    }
    char *exec_addr[] = {
        (char *)NSD_BIN_IP, (char *)"netns", (char *)"exec", (char *)ns_name,
        (char *)NSD_BIN_IP, (char *)"addr", (char *)"add", (char *)ns_addr_arg,
        (char *)"dev", (char *)veth_ns, NULL
    };
    if (run_argv(NSD_BIN_IP, exec_addr) != 0) {
        snprintf(err, err_cap, "ns addr add failed");
        return -1;
    }
    char *exec_up[] = {
        (char *)NSD_BIN_IP, (char *)"netns", (char *)"exec", (char *)ns_name,
        (char *)NSD_BIN_IP, (char *)"link", (char *)"set", (char *)veth_ns, (char *)"up", NULL
    };
    if (run_argv(NSD_BIN_IP, exec_up) != 0) {
        snprintf(err, err_cap, "ns veth up failed");
        return -1;
    }
    char *exec_route[] = {
        (char *)NSD_BIN_IP, (char *)"netns", (char *)"exec", (char *)ns_name,
        (char *)NSD_BIN_IP, (char *)"route", (char *)"add", (char *)"default",
        (char *)"via", (char *)host_ip, NULL
    };
    if (run_argv(NSD_BIN_IP, exec_route) != 0) {
        snprintf(err, err_cap, "ns default route failed");
        return -1;
    }

    char *ns_input_lo[] = {
        (char *)NSD_BIN_IP, (char *)"netns", (char *)"exec", (char *)ns_name,
        (char *)NSD_BIN_IPTABLES, (char *)"-A", (char *)"INPUT",
        (char *)"-i", (char *)"lo", (char *)"-j", (char *)"ACCEPT", NULL
    };
    (void) run_argv(NSD_BIN_IP, ns_input_lo);
    char *ns_input_est[] = {
        (char *)NSD_BIN_IP, (char *)"netns", (char *)"exec", (char *)ns_name,
        (char *)NSD_BIN_IPTABLES, (char *)"-A", (char *)"INPUT",
        (char *)"-m", (char *)"state", (char *)"--state", (char *)"ESTABLISHED,RELATED",
        (char *)"-j", (char *)"ACCEPT", NULL
    };
    (void) run_argv(NSD_BIN_IP, ns_input_est);
    char host_only[24];
    snprintf(host_only, sizeof(host_only), "%s/32", host_ip);
    char *ns_input_host[] = {
        (char *)NSD_BIN_IP, (char *)"netns", (char *)"exec", (char *)ns_name,
        (char *)NSD_BIN_IPTABLES, (char *)"-A", (char *)"INPUT",
        (char *)"-s", host_only, (char *)"-j", (char *)"ACCEPT", NULL
    };
    (void) run_argv(NSD_BIN_IP, ns_input_host);
    char *ns_input_drop[] = {
        (char *)NSD_BIN_IP, (char *)"netns", (char *)"exec", (char *)ns_name,
        (char *)NSD_BIN_IPTABLES, (char *)"-A", (char *)"INPUT",
        (char *)"-j", (char *)"DROP", NULL
    };
    (void) run_argv(NSD_BIN_IP, ns_input_drop);

    (void) in;
    return 0;
}

/* ── Cleanup script (consumed by teardown) ───────────────── */

static int write_cleanup_script(const char *project, const char *host_ip,
                                const char *ns_ip, const char *ns_name,
                                const char *veth_host) {
    char path[PATH_MAX];
    snprintf(path, sizeof(path), "/run/.ns-%s/ns-cleanup.sh", project);

    char ns_cidr[24], host_only[24];
    snprintf(ns_cidr, sizeof(ns_cidr), "%s/32", ns_ip);
    snprintf(host_only, sizeof(host_only), "%s/32", host_ip);

    char buf[4096];
    int n = snprintf(buf, sizeof(buf),
        "#!/bin/bash\n"
        "iptables -D OUTPUT -d %s -j ACCEPT 2>/dev/null || true\n"
        "iptables -D FORWARD -s %s -p udp --dport 53 -j DROP 2>/dev/null || true\n"
        "iptables -D FORWARD -s %s -p tcp --dport 53 -j DROP 2>/dev/null || true\n"
        "iptables -D FORWARD -s %s -d %s/30 -j ACCEPT 2>/dev/null || true\n"
        "iptables -D FORWARD -s %s -d 169.254.0.0/16 -j DROP 2>/dev/null || true\n"
        "iptables -D FORWARD -s %s -d 10.0.0.0/8 -j DROP 2>/dev/null || true\n"
        "iptables -D FORWARD -s %s -d 172.16.0.0/12 -j DROP 2>/dev/null || true\n"
        "iptables -D FORWARD -s %s -d 192.168.0.0/16 -j DROP 2>/dev/null || true\n"
        "iptables -D FORWARD -s %s -m set ! --match-set ellul-egress dst -j DROP 2>/dev/null || true\n"
        "iptables -D FORWARD -s %s -j ACCEPT 2>/dev/null || true\n"
        "iptables -D FORWARD -d %s -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || true\n"
        "iptables -t nat -D POSTROUTING -s %s -j MASQUERADE 2>/dev/null || true\n"
        "iptables -t nat -D PREROUTING -s %s -d %s -p tcp --dport 18790 "
            "-j DNAT --to-destination 127.0.0.1:18790 2>/dev/null || true\n"
        "iptables -t nat -D PREROUTING -s %s -d %s -p tcp --dport 7701 "
            "-j DNAT --to-destination 127.0.0.1:7701 2>/dev/null || true\n"
        "iptables -t nat -D PREROUTING -s %s -d %s -p tcp --dport 7702 "
            "-j DNAT --to-destination 127.0.0.1:7702 2>/dev/null || true\n"
        "ip link del %s 2>/dev/null || true\n"
        "ip netns del %s 2>/dev/null || true\n",
        ns_cidr,
        ns_cidr, ns_cidr,
        ns_cidr, host_ip,
        ns_cidr, ns_cidr, ns_cidr, ns_cidr, ns_cidr, ns_cidr, ns_cidr,
        ns_cidr,
        ns_cidr, host_only, ns_cidr, host_only, ns_cidr, host_only,
        veth_host, ns_name);
    if (n <= 0 || (size_t)n >= sizeof(buf)) return -1;
    return write_file_atomic(path, buf, (size_t)n, 0700, 0, 0);
}

/* ── Cgroup setup ────────────────────────────────────────── */

static int cgroup_create(int cgroup_dfd, const char *project,
                         char unit_out[128]) {
    snprintf(unit_out, 128, "ellul-ns-%s.service", project);
    if (mkdirat_idem(cgroup_dfd, "ellul-namespaces.slice", 0755) != 0) return -1;
    int slice_dfd = openat(cgroup_dfd, "ellul-namespaces.slice",
                           O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (slice_dfd < 0) return -1;
    int rc = mkdirat_idem(slice_dfd, unit_out, 0755);
    close(slice_dfd);
    return rc;
}

/* ── Worker phases ───────────────────────────────────────── */

static int phase_0_rprivate_scratch(struct nsd_stage *s) {
    stage_set_phase(s, "0-rprivate-scratch");

    struct nsd_mount_attr a = { .propagation = MS_PRIVATE };
    if (sys_mount_setattr(AT_FDCWD, "/", AT_RECURSIVE, &a, sizeof(a)) != 0) {
        stage_set_err(s, "rprivate /: %s", strerror(errno));
        return -1;
    }

    char scratch_path[64];
    snprintf(scratch_path, sizeof(scratch_path), "/run/.ns-%s", s->in->project);
    if (mount_tmpfs(s->scratch_dfd, "", "512M", "700", "0", "0") != 0) {
        stage_set_err(s, "scratch tmpfs: %s", strerror(errno));
        return -1;
    }

    /* Path resolution from the worker's mount NS now sees the new tmpfs at
     * scratch_path. The pre-fork dirfd points to the underlying inode that
     * the new mount shadows; reopen via the path so subsequent openat lands
     * inside the new tmpfs. */
    if (s->scratch_dfd >= 0) close(s->scratch_dfd);
    s->scratch_dfd = open(scratch_path, O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (s->scratch_dfd < 0) {
        stage_set_err(s, "scratch reopen: %s", strerror(errno));
        return -1;
    }
    return 0;
}

static int phase_1_save_writable(struct nsd_stage *s) {
    stage_set_phase(s, "1-save-writable");

    if (mkdirat_idem(s->scratch_dfd, "project", 0755) != 0) {
        stage_set_err(s, "mkdir scratch/project: %s", strerror(errno));
        return -1;
    }
    char project_rel[64];
    snprintf(project_rel, sizeof(project_rel), "projects/%s", s->in->project);
    if (mount_bind_at(s->home_dfd, project_rel, s->scratch_dfd, "project") != 0) {
        stage_set_err(s, "bind project: %s", strerror(errno));
        return -1;
    }

    for (int i = 0; NSD_OVL_DIRS[i]; i++) {
        char lower[64], upper[64], work[64];
        snprintf(lower, sizeof(lower), "lower-%s", NSD_OVL_DIRS[i]);
        snprintf(upper, sizeof(upper), "upper-%s", NSD_OVL_DIRS[i]);
        snprintf(work,  sizeof(work),  "work-%s",  NSD_OVL_DIRS[i]);

        if (faccessat(s->home_dfd, NSD_OVL_DIRS[i], F_OK, AT_SYMLINK_NOFOLLOW) != 0) {
            mkdirat_idem(s->home_dfd, NSD_OVL_DIRS[i], 0755);
            chownat_if(s->home_dfd, NSD_OVL_DIRS[i], s->in->svc_uid, s->in->svc_gid);
        }
        if (mkdirat_idem(s->scratch_dfd, lower, 0755) != 0 ||
            mkdirat_idem(s->scratch_dfd, upper, 0755) != 0 ||
            mkdirat_idem(s->scratch_dfd, work,  0755) != 0) {
            stage_set_err(s, "mkdir overlay scratch %s: %s",
                          NSD_OVL_DIRS[i], strerror(errno));
            return -1;
        }
        chownat_if(s->scratch_dfd, upper, s->in->svc_uid, s->in->svc_gid);
        if (mount_bind_at(s->home_dfd, NSD_OVL_DIRS[i],
                          s->scratch_dfd, lower) != 0) {
            stage_set_err(s, "bind overlay lowerdir %s: %s",
                          NSD_OVL_DIRS[i], strerror(errno));
            return -1;
        }
    }

    if (mkdirat_idem(s->scratch_dfd, "dotfiles", 0755) != 0) {
        stage_set_err(s, "mkdir dotfiles: %s", strerror(errno));
        return -1;
    }
    for (int i = 0; NSD_DOTFILES[i]; i++) {
        const char *df = NSD_DOTFILES[i];
        bool is_json = strstr(df, ".json") != NULL;
        int hfd = openat(s->home_dfd, df, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
        if (hfd < 0) {
            int cfd = openat(s->home_dfd, df,
                             O_WRONLY | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0600);
            if (cfd >= 0) {
                if (is_json) (void) write(cfd, "{}\n", 3);
                fchown(cfd, s->in->svc_uid, s->in->svc_gid);
                close(cfd);
            }
            hfd = openat(s->home_dfd, df, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
        }
        char dst_rel[64];
        snprintf(dst_rel, sizeof(dst_rel), "dotfiles/%s", df);
        int dfd = openat(s->scratch_dfd, dst_rel,
                         O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC, 0644);
        if (dfd < 0) {
            if (hfd >= 0) close(hfd);
            stage_set_err(s, "open dotfile dst %s: %s", df, strerror(errno));
            return -1;
        }
        if (hfd >= 0) {
            char buf[8192];
            ssize_t r;
            while ((r = read(hfd, buf, sizeof(buf))) > 0) {
                ssize_t off = 0;
                while (off < r) {
                    ssize_t w = write(dfd, buf + off, (size_t)(r - off));
                    if (w < 0) { if (errno == EINTR) continue; break; }
                    off += w;
                }
            }
            close(hfd);
        } else if (is_json) {
            (void) write(dfd, "{}\n", 3);
        }
        fchown(dfd, s->in->svc_uid, s->in->svc_gid);
        close(dfd);
    }

    if (mkdirat_idem(s->scratch_dfd, "ctx", 0755) != 0) {
        stage_set_err(s, "mkdir ctx: %s", strerror(errno));
        return -1;
    }
    int proj_root_dfd = openat(s->home_dfd, "projects",
                                O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (proj_root_dfd >= 0) {
        for (int i = 0; NSD_CTX_FILES[i]; i++) {
            int sfd = openat(proj_root_dfd, NSD_CTX_FILES[i],
                             O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
            if (sfd < 0) continue;
            char dst_rel[96];
            snprintf(dst_rel, sizeof(dst_rel), "ctx/projects-%s", NSD_CTX_FILES[i]);
            int dfd = openat(s->scratch_dfd, dst_rel,
                             O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC, 0644);
            if (dfd >= 0) {
                char buf[8192];
                ssize_t r;
                while ((r = read(sfd, buf, sizeof(buf))) > 0) {
                    ssize_t off = 0;
                    while (off < r) {
                        ssize_t w = write(dfd, buf + off, (size_t)(r - off));
                        if (w < 0) { if (errno == EINTR) continue; break; }
                        off += w;
                    }
                }
                close(dfd);
            }
            close(sfd);
        }
        close(proj_root_dfd);
    }

    if (mkdirat_idem(s->scratch_dfd, "dns", 0755) != 0) {
        stage_set_err(s, "mkdir dns: %s", strerror(errno));
        return -1;
    }
    int dns_dfd = openat(s->scratch_dfd, "dns",
                         O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (dns_dfd < 0) {
        stage_set_err(s, "open scratch/dns: %s", strerror(errno));
        return -1;
    }
    int dns_fd = openat(dns_dfd, "resolv.conf",
                         O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC, 0644);
    if (dns_fd < 0) {
        close(dns_dfd);
        stage_set_err(s, "open scratch/dns/resolv.conf: %s", strerror(errno));
        return -1;
    }
    static const char dns_body[] =
        "nameserver 8.8.8.8\nnameserver 1.1.1.1\n";
    (void) write(dns_fd, dns_body, sizeof(dns_body) - 1);
    close(dns_fd);

    if (s->in->byok) {
        int hosts_fd = openat(dns_dfd, "hosts",
                              O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC, 0644);
        if (hosts_fd < 0) {
            close(dns_dfd);
            stage_set_err(s, "open scratch/dns/hosts: %s", strerror(errno));
            return -1;
        }
        static const char hdr[] = "127.0.0.1 localhost\n";
        (void) write(hosts_fd, hdr, sizeof(hdr) - 1);
        for (int i = 0; NSD_BYOK_DOMAINS[i]; i++) {
            char line[256];
            int ln = snprintf(line, sizeof(line), "0.0.0.0 %s\n", NSD_BYOK_DOMAINS[i]);
            if (ln > 0) (void) write(hosts_fd, line, (size_t)ln);
        }
        close(hosts_fd);
    }
    close(dns_dfd);
    return 0;
}

static int phase_2_default_deny_home(struct nsd_stage *s) {
    stage_set_phase(s, "2-default-deny-home");

    int tree = sys_open_tree(s->home_dfd, "",
                              OPEN_TREE_CLONE | OPEN_TREE_CLOEXEC |
                              AT_EMPTY_PATH | AT_NO_AUTOMOUNT);
    if (tree < 0) {
        stage_set_err(s, "open_tree home: %s", strerror(errno));
        return -1;
    }
    struct nsd_mount_attr a = { .attr_set = MOUNT_ATTR_RDONLY };
    if (sys_mount_setattr(tree, "", AT_EMPTY_PATH, &a, sizeof(a)) != 0) {
        close(tree);
        stage_set_err(s, "set RO home clone: %s", strerror(errno));
        return -1;
    }
    if (sys_move_mount(tree, "", s->home_dfd, "",
                       MOVE_MOUNT_F_EMPTY_PATH | MOVE_MOUNT_T_EMPTY_PATH) != 0) {
        close(tree);
        stage_set_err(s, "move RO home onto home: %s", strerror(errno));
        return -1;
    }
    close(tree);

    /* Pre-fork home_dfd points to the underlying mount; reopen via path so
     * phase 3's targets land on the just-stacked RO bind, not the layer
     * underneath. */
    close(s->home_dfd);
    s->home_dfd = open(s->in->home, O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (s->home_dfd < 0) {
        stage_set_err(s, "home reopen: %s", strerror(errno));
        return -1;
    }
    return 0;
}

static int phase_3_writable_exceptions(struct nsd_stage *s) {
    stage_set_phase(s, "3-writable-exceptions");

    for (int i = 0; NSD_DOTFILES[i]; i++) {
        char src_rel[64];
        snprintf(src_rel, sizeof(src_rel), "dotfiles/%s", NSD_DOTFILES[i]);
        if (faccessat(s->scratch_dfd, src_rel, F_OK, AT_SYMLINK_NOFOLLOW) != 0) continue;
        if (mount_bind_at(s->scratch_dfd, src_rel,
                          s->home_dfd, NSD_DOTFILES[i]) != 0) {
            stage_set_err(s, "bind dotfile %s: %s",
                          NSD_DOTFILES[i], strerror(errno));
            return -1;
        }
    }

    if (mount_tmpfs(s->home_dfd, "projects", "1M", "755", NULL, NULL) != 0) {
        stage_set_err(s, "tmpfs home/projects: %s", strerror(errno));
        return -1;
    }
    int projects_dfd = openat(s->home_dfd, "projects",
                              O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (projects_dfd < 0) {
        stage_set_err(s, "open home/projects: %s", strerror(errno));
        return -1;
    }
    if (mkdirat_idem(projects_dfd, s->in->project, 0755) != 0) {
        close(projects_dfd);
        stage_set_err(s, "mkdir home/projects/<slug>: %s", strerror(errno));
        return -1;
    }
    if (mount_bind_at(s->scratch_dfd, "project", projects_dfd, s->in->project) != 0) {
        close(projects_dfd);
        stage_set_err(s, "bind project into projects: %s", strerror(errno));
        return -1;
    }
    /* Context files copy into the new tmpfs projects/ layer. */
    for (int i = 0; NSD_CTX_FILES[i]; i++) {
        char src_rel[96];
        snprintf(src_rel, sizeof(src_rel), "ctx/projects-%s", NSD_CTX_FILES[i]);
        int sfd = openat(s->scratch_dfd, src_rel, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
        if (sfd < 0) continue;
        int dfd = openat(projects_dfd, NSD_CTX_FILES[i],
                          O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC, 0644);
        if (dfd >= 0) {
            char buf[8192]; ssize_t r;
            while ((r = read(sfd, buf, sizeof(buf))) > 0) {
                ssize_t off = 0;
                while (off < r) {
                    ssize_t w = write(dfd, buf + off, (size_t)(r - off));
                    if (w < 0) { if (errno == EINTR) continue; break; }
                    off += w;
                }
            }
            close(dfd);
        }
        close(sfd);
    }
    /* .shared and .comms placeholders: root-owned, mode 0555 — agent cannot
     * symlink-attack the deferred mount targets. */
    int proj_dfd = openat(projects_dfd, s->in->project,
                          O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    close(projects_dfd);
    if (proj_dfd < 0) {
        stage_set_err(s, "open projects/<slug>: %s", strerror(errno));
        return -1;
    }
    mkdirat_idem(proj_dfd, ".shared", 0555);
    fchownat(proj_dfd, ".shared", 0, 0, 0);
    close(proj_dfd);
    mkdirat_idem(s->home_dfd, ".comms", 0555);
    fchownat(s->home_dfd, ".comms", 0, 0, 0);

    for (int i = 0; NSD_OVL_DIRS[i]; i++) {
        char lower[64], upper[64], work[64];
        char lower_abs[PATH_MAX], upper_abs[PATH_MAX], work_abs[PATH_MAX];
        snprintf(lower, sizeof(lower), "lower-%s", NSD_OVL_DIRS[i]);
        snprintf(upper, sizeof(upper), "upper-%s", NSD_OVL_DIRS[i]);
        snprintf(work,  sizeof(work),  "work-%s",  NSD_OVL_DIRS[i]);
        snprintf(lower_abs, sizeof(lower_abs), "/proc/self/fd/%d/%s",
                 s->scratch_dfd, lower);
        snprintf(upper_abs, sizeof(upper_abs), "/proc/self/fd/%d/%s",
                 s->scratch_dfd, upper);
        snprintf(work_abs,  sizeof(work_abs),  "/proc/self/fd/%d/%s",
                 s->scratch_dfd, work);

        if (faccessat(s->scratch_dfd, lower, F_OK, AT_SYMLINK_NOFOLLOW) != 0) continue;
        if (mount_overlay(s->home_dfd, NSD_OVL_DIRS[i],
                          lower_abs, upper_abs, work_abs) != 0) {
            stage_set_err(s, "overlay %s: %s", NSD_OVL_DIRS[i], strerror(errno));
            return -1;
        }
    }
    return 0;
}

static int phase_4_system_isolation(struct nsd_stage *s) {
    stage_set_phase(s, "4-system-isolation");

    if (mount_proc_hidepid2(s->proc_dfd, "") != 0) {
        stage_set_err(s, "proc hidepid=2: %s", strerror(errno));
        return -1;
    }

    int tmp_dfd = open("/tmp", O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (tmp_dfd < 0) {
        stage_set_err(s, "open /tmp: %s", strerror(errno));
        return -1;
    }
    if (mount_tmpfs(tmp_dfd, "", "256M", "1777", NULL, NULL) != 0) {
        close(tmp_dfd);
        stage_set_err(s, "tmpfs /tmp: %s", strerror(errno));
        return -1;
    }
    close(tmp_dfd);

    int etc_dfd = open("/etc", O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (etc_dfd < 0) {
        stage_set_err(s, "open /etc: %s", strerror(errno));
        return -1;
    }
    if (mount_bind_at(s->scratch_dfd, "dns/resolv.conf",
                      etc_dfd, "resolv.conf") != 0) {
        close(etc_dfd);
        stage_set_err(s, "bind /etc/resolv.conf: %s", strerror(errno));
        return -1;
    }
    if (s->in->byok) {
        if (mount_bind_at(s->scratch_dfd, "dns/hosts",
                          etc_dfd, "hosts") != 0) {
            close(etc_dfd);
            stage_set_err(s, "bind BYOK /etc/hosts: %s", strerror(errno));
            return -1;
        }
    }
    close(etc_dfd);

    /* Shield blackholes — load-bearing. Any failure is fail-closed: agent
     * MUST NOT see shield-data, the LUKS-shielded vault, or the shield socket
     * dir. We post-validate each blackhole stays empty. */
    for (int i = 0; NSD_SHIELD_BLACKHOLES[i]; i++) {
        const char *target = NSD_SHIELD_BLACKHOLES[i];
        int t_dfd = open(target, O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (t_dfd < 0) {
            if (mkdir(target, 0755) != 0 && errno != EEXIST) {
                stage_set_err(s, "shield mkdir %s: %s", target, strerror(errno));
                return -1;
            }
            t_dfd = open(target, O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
            if (t_dfd < 0) {
                stage_set_err(s, "shield open %s: %s", target, strerror(errno));
                return -1;
            }
        }
        if (mount_tmpfs(t_dfd, "", "0", "000", "0", "0") != 0) {
            close(t_dfd);
            stage_set_err(s, "shield blackhole %s: %s", target, strerror(errno));
            return -1;
        }
        close(t_dfd);
        /* The pre-mount t_dfd points at the underlying inode that the new
         * tmpfs now shadows; reading its dirents would still see the host
         * directory's contents and falsely fail the post-validate. Re-open
         * via path so the new fd resolves through the tmpfs root. */
        int verify_dfd = open(target, O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (verify_dfd < 0) {
            stage_set_err(s, "shield verify-open %s: %s", target, strerror(errno));
            return -1;
        }
        DIR *d = fdopendir(verify_dfd);
        if (d) {
            int n = 0;
            struct dirent *e;
            while ((e = readdir(d)) != NULL) {
                if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0) continue;
                n++;
                break;
            }
            closedir(d);
            if (n != 0) {
                stage_set_err(s, "shield %s not empty after blackhole", target);
                return -1;
            }
        } else {
            close(verify_dfd);
            stage_set_err(s, "shield fdopendir %s: %s", target, strerror(errno));
            return -1;
        }
    }
    return 0;
}

static int phase_5_signal_anchor(struct nsd_stage *s) {
    stage_set_phase(s, "5-signal-anchor");

    uint8_t ok = NSD_REPORT_OK;
    if (write(s->report_w, &ok, 1) != 1) {
        stage_set_err(s, "ready write: %s", strerror(errno));
        return -1;
    }
    close(s->report_w);
    s->report_w = -1;

    /* Anchor lives forever in clock_nanosleep loop. Cannot use the older
     * execve(/usr/bin/sleep) + pause() pattern: pause() is not in the
     * daemon seccomp allowlist (the filter inherits across execve), so a
     * silent execve failure dropped us into a pause() loop that the
     * kernel immediately SIGSYS-killed. clock_nanosleep IS allowlisted.
     * SIGTERM / SIGINT default to terminate — ignore them so any
     * cross-cgroup signal cascade doesn't reap us. */
    {
        struct sigaction sa = {0};
        sa.sa_handler = SIG_IGN;
        sigaction(SIGTERM, &sa, NULL);
        sigaction(SIGINT,  &sa, NULL);
        signal(SIGPIPE, SIG_IGN);
    }
    /* /proc/1/comm hygiene from inside the agent's PID namespace: anchor
     * is PID 1 there, and an inquisitive agent reading /proc/1/comm would
     * otherwise see the daemon binary name. Rename to a generic label. */
    (void) prctl(PR_SET_NAME, "ellul-anchor", 0, 0, 0);
    for (;;) {
        struct timespec ts = { .tv_sec = 365L * 24L * 3600L, .tv_nsec = 0 };
        (void) clock_nanosleep(CLOCK_MONOTONIC, 0, &ts, NULL);
    }
    return -1;
}

/* ── Worker entry ────────────────────────────────────────── */

static void worker_report_fail(int report_w, const char *phase, const char *err) {
    uint8_t fail = NSD_REPORT_FAIL;
    (void) write(report_w, &fail, 1);
    uint16_t pl = (uint16_t)(strlen(phase ? phase : ""));
    uint8_t plb[2] = { (uint8_t)(pl >> 8), (uint8_t)(pl & 0xff) };
    (void) write(report_w, plb, 2);
    if (pl > 0) (void) write(report_w, phase, pl);
    uint16_t el = (uint16_t)(strlen(err ? err : ""));
    uint8_t elb[2] = { (uint8_t)(el >> 8), (uint8_t)(el & 0xff) };
    (void) write(report_w, elb, 2);
    if (el > 0) (void) write(report_w, err, el);
    close(report_w);
}

static void worker_main(struct nsd_stage *s) {
    if (s->netns_fd >= 0) {
        if (setns(s->netns_fd, CLONE_NEWNET) != 0) {
            worker_report_fail(s->report_w, "netns-join", strerror(errno));
            _exit(1);
        }
        close(s->netns_fd);
        s->netns_fd = -1;
    }

    /* Re-open the dirfds the parent prepared, this time inside our own mount
     * namespace. The parent's fds reference vfsmounts from its mount NS;
     * after CLONE_NEWNS the kernel's check_mnt() rejects move_mount whose
     * target dfd resolves to a foreign-NS vfsmount with EINVAL. Re-opening
     * via the same path yields a fd whose vfsmount lives in our NS. */
    {
        char scratch_path[64];
        snprintf(scratch_path, sizeof(scratch_path), "/run/.ns-%s", s->in->project);
        if (s->scratch_dfd >= 0) close(s->scratch_dfd);
        s->scratch_dfd = open(scratch_path, O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (s->scratch_dfd < 0) {
            worker_report_fail(s->report_w, "reopen-scratch", strerror(errno));
            _exit(1);
        }
        if (s->home_dfd >= 0) close(s->home_dfd);
        s->home_dfd = open(s->in->home, O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (s->home_dfd < 0) {
            worker_report_fail(s->report_w, "reopen-home", strerror(errno));
            _exit(1);
        }
        if (s->proc_dfd >= 0) close(s->proc_dfd);
        s->proc_dfd = open("/proc", O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (s->proc_dfd < 0) {
            worker_report_fail(s->report_w, "reopen-proc", strerror(errno));
            _exit(1);
        }
    }

    if (phase_0_rprivate_scratch(s) != 0)   goto fail;
    if (phase_1_save_writable(s)    != 0)   goto fail;
    if (phase_2_default_deny_home(s) != 0)  goto fail;
    if (phase_3_writable_exceptions(s) != 0) goto fail;
    if (phase_4_system_isolation(s) != 0)   goto fail;
    if (phase_5_signal_anchor(s)    != 0)   goto fail;

    /* Unreachable on success — phase 5 execve's. */
fail:
    worker_report_fail(s->report_w, s->phase, s->errbuf);
    _exit(1);
}

/* ── Parent: ready report read + mount staging coordinator ── */

static int read_report(int fd, char *phase, size_t phase_cap,
                       char *err, size_t err_cap) {
    uint8_t status;
    ssize_t r = read(fd, &status, 1);
    if (r != 1) return -1;
    if (status == NSD_REPORT_OK) return 0;
    uint8_t pl[2];
    if (read(fd, pl, 2) != 2) return -1;
    uint16_t plen = ((uint16_t)pl[0] << 8) | pl[1];
    if (plen > 0 && plen < phase_cap) {
        ssize_t pr = read(fd, phase, plen);
        if (pr > 0) phase[pr] = 0;
    }
    uint8_t el[2];
    if (read(fd, el, 2) != 2) return -1;
    uint16_t elen = ((uint16_t)el[0] << 8) | el[1];
    if (elen > 0 && elen < err_cap) {
        ssize_t er = read(fd, err, elen);
        if (er > 0) err[er] = 0;
    }
    return 1;
}

static int await_ready(int fd, int timeout_s,
                       char *phase, size_t phase_cap,
                       char *err, size_t err_cap) {
    struct pollfd p = { .fd = fd, .events = POLLIN };
    int pr = poll(&p, 1, timeout_s * 1000);
    if (pr <= 0) {
        snprintf(err, err_cap, "ready timeout after %ds", timeout_s);
        return -1;
    }
    int rr = read_report(fd, phase, phase_cap, err, err_cap);
    if (rr < 0) {
        snprintf(err, err_cap, "ready read: %s", strerror(errno));
        return -1;
    }
    if (rr > 0) return -1;
    return 0;
}

/* ── Public entry ────────────────────────────────────────── */

int nsd_mount_stage_run(const struct nsd_mount_stage_input *in,
                        struct nsd_mount_stage_result *out) {
    memset(out, 0, sizeof(*out));
    if (!slug_ok(in->project) || !in->home || !in->svc_user) {
        out->errcode = NSD_EPROTO;
        return -NSD_EPROTO;
    }
    if (!path_under(in->home, "/home")) {
        out->errcode = NSD_EPROTO;
        return -NSD_EPROTO;
    }

    char run_dir[PATH_MAX], anchor_pid_path[PATH_MAX], ready_path[PATH_MAX];
    snprintf(run_dir,         sizeof(run_dir),         "/run/.ns-%s", in->project);
    snprintf(anchor_pid_path, sizeof(anchor_pid_path), "%s/anchor.pid", run_dir);
    snprintf(ready_path,      sizeof(ready_path),      "/run/.ns-ready-%s", in->project);

    /* Heal pre-existing 0700 dir from older builds — chmod even on the
     * idempotent path so the bridge can traverse to read anchor.pid. Hard
     * fail if it can't be set; silently leaving 0700 here re-triggers the
     * URL-rewrite bug ("session.create returned no payload"). */
    if (chmod(run_dir, 0755) != 0 && errno != ENOENT) {
        out->errcode = NSD_EINTERNAL;
        snprintf(out->err_tail, sizeof(out->err_tail),
                 "chmod %s 0755: %s", run_dir, strerror(errno));
        return -NSD_EINTERNAL;
    }

    /* Idempotent fast path — bridge re-issues SETUP every reconcile tick
     * (every ~30s). If we tear down + recreate every time, the bridge's
     * stored anchor_pid goes stale between SETUP and the next ENTER, and
     * /proc/$ANCHOR_PID/root copies in enter.sh fail with ENOENT. Keep
     * the existing anchor only when it's still alive AND still in the
     * project's leaf cgroup — `kill(pid,0)` alone isn't enough because
     * Linux reuses PIDs and the file may name a corpse that's been
     * recycled by some unrelated process. */
    {
        FILE *fp = fopen(anchor_pid_path, "r");
        if (fp) {
            long pid = 0;
            if (fscanf(fp, "%ld", &pid) == 1 && pid > 0 && pid < INT_MAX) {
                fclose(fp); fp = NULL;
                /* Verify the PID is still our anchor by reading its cgroup
                 * line and matching the expected leaf path. If the PID was
                 * recycled, the cgroup won't match. If the anchor died and
                 * the empty cgroup was reaped, the read fails. Either way
                 * we fall through to the recreate path. */
                char cg_path[64];
                snprintf(cg_path, sizeof(cg_path), "/proc/%ld/cgroup", pid);
                int cg_fd = open(cg_path, O_RDONLY | O_CLOEXEC);
                if (cg_fd >= 0) {
                    char cg_buf[512];
                    ssize_t cg_n = read(cg_fd, cg_buf, sizeof(cg_buf) - 1);
                    close(cg_fd);
                    if (cg_n > 0) {
                        cg_buf[cg_n] = 0;
                        char want[160];
                        snprintf(want, sizeof(want),
                                 "ellul-namespaces.slice/ellul-ns-%s.service",
                                 in->project);
                        if (strstr(cg_buf, want) != NULL) {
                            /* Verify net-version before idempotent skip.
                               Missing marker means DNAT rules may be absent
                               (namespace from older binary); fall through to
                               stale-cleanup + full re-stage. */
                            char nv_path[PATH_MAX];
                            snprintf(nv_path, sizeof(nv_path),
                                     "/run/.ns-%s/net-version",
                                     in->project);
                            int nv_fd = open(nv_path,
                                             O_RDONLY | O_CLOEXEC);
                            if (nv_fd >= 0) {
                                char nv_buf[16];
                                ssize_t nv_n = read(nv_fd, nv_buf,
                                                    sizeof(nv_buf) - 1);
                                close(nv_fd);
                                if (nv_n > 0) {
                                    nv_buf[nv_n] = 0;
                                    if (atoi(nv_buf) >= 1) {
                                        char ns_unit[128];
                                        snprintf(ns_unit, sizeof(ns_unit),
                                                 "ellul-ns-%s.service",
                                                 in->project);
                                        snprintf(out->unit_name,
                                                 sizeof(out->unit_name),
                                                 "%s", ns_unit);
                                        out->anchor_pid = (pid_t)pid;
                                        out->success    = true;
                                        out->errcode    = 0;
                                        nsd_phase("nsd-stage", in->project,
                                                  "idempotent-skip", "ok",
                                                  NULL);
                                        return 0;
                                    }
                                }
                            }
                            /* net-version missing or stale — fall through
                               to stale-cleanup + full re-stage */
                            nsd_phase("nsd-stage", in->project,
                                      "stale-net-restage", "begin", NULL);
                        }
                    }
                }
            }
            if (fp) fclose(fp);
        }
    }

    nsd_phase("nsd-stage", in->project, "stale-cleanup", "begin", NULL);
    stale_cleanup(in->project);
    nsd_phase("nsd-stage", in->project, "stale-cleanup", "end", NULL);

    /* 0755 so the bridge (running as $SVC_USER) can traverse this directory
     * and read anchor.pid — its `isProjectNamespaceRunning` precondition
     * for `getNsVethIp(...)` URL rewriting. With 0700, getNsVethIp returns
     * null, opencode session.create gets the unrewritten 0.0.0.0 URL, and
     * the request lands on the host instead of the namespace. anchor.pid
     * itself (PID number) is non-sensitive. mkdir EEXIST → chmod fixes
     * pre-existing 0700 dirs from older builds. */
    if (mkdir(run_dir, 0755) != 0 && errno != EEXIST) {
        out->errcode = NSD_EINTERNAL;
        snprintf(out->err_tail, sizeof(out->err_tail),
                 "mkdir %s: %s", run_dir, strerror(errno));
        return -NSD_EINTERNAL;
    }
    /* chmod separately so a pre-existing 0700 dir from an older build
     * gets its perms widened on next setup — mkdir alone doesn't change
     * permissions of an existing dir. */
    (void) chmod(run_dir, 0755);

    char host_ip[16], ns_ip[16], ns_name[64], short_id[16];
    char veth_host[32], veth_ns[32];
    if (derive_ips(in->project, host_ip, ns_ip) != 0) {
        out->errcode = NSD_EINTERNAL;
        snprintf(out->err_tail, sizeof(out->err_tail),
                 "derive ips: jwt-secret/machine-id missing");
        return -NSD_EINTERNAL;
    }
    snprintf(ns_name,   sizeof(ns_name),   "ellul-%s", in->project);
    snprintf(short_id,  sizeof(short_id),  "%s",       in->project + 4);
    snprintf(veth_host, sizeof(veth_host), "ea-%s",    short_id);
    snprintf(veth_ns,   sizeof(veth_ns),   "vn-%s",    short_id);

    nsd_phase("nsd-stage", in->project, "network-setup", "begin", NULL);
    char neterr[128] = {0};
    if (network_setup(in, host_ip, ns_ip, ns_name, veth_host, veth_ns,
                      neterr, sizeof(neterr)) != 0) {
        snprintf(out->err_tail, sizeof(out->err_tail), "%s", neterr);
        out->errcode = NSD_ESTAGE_FAILED;
        nsd_phase("nsd-stage", in->project, "network-setup", "fail", neterr);
        stale_cleanup(in->project);
        return -NSD_ESTAGE_FAILED;
    }
    nsd_phase("nsd-stage", in->project, "network-setup", "end", NULL);

    char netns_path[64];
    snprintf(netns_path, sizeof(netns_path), "/var/run/netns/%s", ns_name);
    int netns_fd = open(netns_path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (netns_fd < 0) {
        out->errcode = NSD_EINTERNAL;
        snprintf(out->err_tail, sizeof(out->err_tail),
                 "open netns %s: %s", netns_path, strerror(errno));
        stale_cleanup(in->project);
        return -NSD_EINTERNAL;
    }

    int home_dfd = open(in->home,
                         O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (home_dfd < 0) {
        close(netns_fd);
        out->errcode = NSD_EINTERNAL;
        snprintf(out->err_tail, sizeof(out->err_tail),
                 "open home %s: %s", in->home, strerror(errno));
        stale_cleanup(in->project);
        return -NSD_EINTERNAL;
    }
    int scratch_dfd = open(run_dir, O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (scratch_dfd < 0) {
        close(home_dfd); close(netns_fd);
        out->errcode = NSD_EINTERNAL;
        snprintf(out->err_tail, sizeof(out->err_tail),
                 "open scratch %s: %s", run_dir, strerror(errno));
        stale_cleanup(in->project);
        return -NSD_EINTERNAL;
    }
    int proc_dfd = open("/proc", O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    int cgroup_dfd = open("/sys/fs/cgroup", O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (proc_dfd < 0 || cgroup_dfd < 0) {
        if (proc_dfd >= 0) close(proc_dfd);
        if (cgroup_dfd >= 0) close(cgroup_dfd);
        close(scratch_dfd); close(home_dfd); close(netns_fd);
        out->errcode = NSD_EINTERNAL;
        snprintf(out->err_tail, sizeof(out->err_tail), "host dirfd open failed");
        stale_cleanup(in->project);
        return -NSD_EINTERNAL;
    }

    if (cgroup_create(cgroup_dfd, in->project, out->unit_name) != 0) {
        close(home_dfd); close(scratch_dfd); close(proc_dfd);
        close(cgroup_dfd); close(netns_fd);
        out->errcode = NSD_EINTERNAL;
        snprintf(out->err_tail, sizeof(out->err_tail), "cgroup create: %s", strerror(errno));
        stale_cleanup(in->project);
        return -NSD_EINTERNAL;
    }

    char leaf_rel[256];
    snprintf(leaf_rel, sizeof(leaf_rel),
             "ellul-namespaces.slice/ellul-ns-%s.service", in->project);
    int leaf_dfd = openat(cgroup_dfd, leaf_rel,
                          O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (leaf_dfd < 0) {
        close(home_dfd); close(scratch_dfd); close(proc_dfd);
        close(cgroup_dfd); close(netns_fd);
        out->errcode = NSD_EINTERNAL;
        snprintf(out->err_tail, sizeof(out->err_tail),
                 "open leaf cgroup: %s", strerror(errno));
        stale_cleanup(in->project);
        return -NSD_EINTERNAL;
    }

    int report_pipe[2];
    if (pipe2(report_pipe, O_CLOEXEC) != 0) {
        close(leaf_dfd);
        close(home_dfd); close(scratch_dfd); close(proc_dfd);
        close(cgroup_dfd); close(netns_fd);
        out->errcode = NSD_EINTERNAL;
        snprintf(out->err_tail, sizeof(out->err_tail),
                 "pipe2: %s", strerror(errno));
        stale_cleanup(in->project);
        return -NSD_EINTERNAL;
    }

    struct nsd_stage *stage = calloc(1, sizeof(*stage));
    if (!stage) {
        close(report_pipe[0]); close(report_pipe[1]);
        close(leaf_dfd);
        close(home_dfd); close(scratch_dfd); close(proc_dfd);
        close(cgroup_dfd); close(netns_fd);
        out->errcode = NSD_EINTERNAL;
        stale_cleanup(in->project);
        return -NSD_EINTERNAL;
    }
    stage->in = in;
    stage->home_dfd      = home_dfd;
    stage->scratch_dfd   = scratch_dfd;
    stage->proc_dfd      = proc_dfd;
    stage->cgroup_dfd    = cgroup_dfd;
    stage->netns_fd      = netns_fd;
    stage->report_w      = report_pipe[1];

    int worker_pidfd = -1;
    struct nsd_clone_args ca = {
        .flags       = CLONE_NEWNS | CLONE_NEWPID | CLONE_PIDFD |
                       CLONE_INTO_CGROUP,
        .pidfd       = (uint64_t)(uintptr_t)&worker_pidfd,
        .cgroup      = (uint64_t)leaf_dfd,
        .exit_signal = SIGCHLD,
    };
    pid_t worker_pid = sys_clone3(&ca, sizeof(ca));
    if (worker_pid < 0) {
        free(stage);
        close(report_pipe[0]); close(report_pipe[1]);
        close(leaf_dfd);
        close(home_dfd); close(scratch_dfd); close(proc_dfd);
        close(cgroup_dfd); close(netns_fd);
        out->errcode = NSD_EINTERNAL;
        snprintf(out->err_tail, sizeof(out->err_tail),
                 "clone3: %s", strerror(errno));
        stale_cleanup(in->project);
        return -NSD_EINTERNAL;
    }

    if (worker_pid == 0) {
        close(report_pipe[0]);
        close(leaf_dfd);
        close(cgroup_dfd);
        worker_main(stage);
        _exit(1);
    }

    close(report_pipe[1]);
    stage->report_w = -1;
    close(netns_fd);
    close(home_dfd);
    close(scratch_dfd);
    close(proc_dfd);
    close(leaf_dfd);
    close(cgroup_dfd);

    char phase_buf[NSD_PHASE_BUF_BYTES] = {0};
    char err_buf[NSD_ERR_BUF_BYTES] = {0};
    if (await_ready(report_pipe[0], NSD_READY_TIMEOUT_S,
                    phase_buf, sizeof(phase_buf),
                    err_buf, sizeof(err_buf)) != 0) {
        close(report_pipe[0]);
        if (worker_pidfd >= 0) {
            (void) sys_pidfd_signal(worker_pidfd, SIGKILL);
            siginfo_t si;
            (void) waitid(P_PIDFD, (id_t)worker_pidfd, &si, WEXITED);
            close(worker_pidfd);
        }
        free(stage);
        snprintf(out->phase_tail, sizeof(out->phase_tail), "%s", phase_buf);
        snprintf(out->err_tail,   sizeof(out->err_tail),   "%s", err_buf);
        out->errcode = NSD_ESTAGE_FAILED;
        nsd_phase("nsd-stage", in->project, "stage", "fail", err_buf);
        stale_cleanup(in->project);
        return -NSD_ESTAGE_FAILED;
    }
    close(report_pipe[0]);
    free(stage);
    if (worker_pidfd >= 0) close(worker_pidfd);

    if (write_cleanup_script(in->project, host_ip, ns_ip, ns_name, veth_host) != 0) {
        nsd_phase("nsd-stage", in->project, "cleanup-script", "fail",
                  strerror(errno));
    }

    {
        char net_ver_path[PATH_MAX];
        snprintf(net_ver_path, sizeof(net_ver_path),
                 "/run/.ns-%s/net-version", in->project);
        (void) write_file_atomic(net_ver_path, "1\n", 2, 0644, 0, 0);
    }

    char pidbuf[32];
    int pn = snprintf(pidbuf, sizeof(pidbuf), "%d\n", (int)worker_pid);
    (void) write_file_atomic(anchor_pid_path, pidbuf, (size_t)pn, 0644, 0, 0);

    int rfd = open(ready_path, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC, 0644);
    if (rfd >= 0) close(rfd);

    out->success = true;
    out->errcode = NSD_OK;
    out->anchor_pid = worker_pid;
    snprintf(out->phase_tail, sizeof(out->phase_tail), "ready");
    nsd_phase("nsd-stage", in->project, "stage", "end", NULL);
    return 0;
}
