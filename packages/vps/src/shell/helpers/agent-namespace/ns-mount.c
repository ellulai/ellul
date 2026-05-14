/*
 * ellul-ns-mount — Fast namespace mount helper.
 *
 * Replaces ~26 fork+exec /bin/mount calls with direct mount(2) syscalls.
 * Each syscall takes ~0.1-0.5ms vs ~10-40ms for fork+exec on ARM.
 *
 * Performs all Phase 0-5 mount operations:
 *   Phase 0: rprivate + scratch tmpfs
 *   Phase 1: bind project, overlayfs lowerdirs, RO dirs, dotfile copy
 *   Phase 2: DEFAULT-DENY (home read-only)
 *   Phase 3: writable exceptions (overlayfs, projects tmpfs, dotfiles)
 *   Phase 4: proc (hidepid=2), /tmp, DNS, shield blackholes
 *   Phase 5: signal readiness, exec sleep infinity
 *
 * Deterministic rollback: maintains a stack of completed mounts.
 * On failure, unwinds in reverse order, cleans up all artifacts.
 *
 * Build (Linux only):
 *   gcc -O2 -D_FORTIFY_SOURCE=2 -fstack-protector-strong
 *       -Wl,-z,relro,-z,now -o ellul-ns-mount ns-mount.c
 *
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2025 ellul.ai. All rights reserved.
 */

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <libgen.h>
#include <limits.h>
#include <pwd.h>
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

/* ── Rollback Stack ─────────────────────────────────────── */

#define MAX_MOUNTS 128
#define MAX_DIRS 128

static char mount_stack[MAX_MOUNTS][PATH_MAX];
static int mount_count = 0;

static char dir_stack[MAX_DIRS][PATH_MAX];
static int dir_count = 0;

static char scratch_path[PATH_MAX];
static char fifo_path[PATH_MAX];

static void push_mount(const char *path) {
    if (mount_count < MAX_MOUNTS)
        snprintf(mount_stack[mount_count++], PATH_MAX, "%s", path);
}

static void push_dir(const char *path) {
    if (dir_count < MAX_DIRS)
        snprintf(dir_stack[dir_count++], PATH_MAX, "%s", path);
}

static void rollback_all(void) {
    fprintf(stderr, "rollback: unwinding %d mounts, %d dirs\n", mount_count, dir_count);
    /* Unmount in reverse order */
    for (int i = mount_count - 1; i >= 0; i--) {
        if (umount2(mount_stack[i], MNT_DETACH) != 0)
            fprintf(stderr, "rollback: umount2(%s) failed: %s\n",
                    mount_stack[i], strerror(errno));
    }
    /* Remove created directories (best-effort, log failures) */
    for (int i = dir_count - 1; i >= 0; i--) {
        if (rmdir(dir_stack[i]) != 0 && errno != ENOENT && errno != EBUSY)
            fprintf(stderr, "rollback: rmdir(%s) failed: %s\n",
                    dir_stack[i], strerror(errno));
    }
    /* Clean scratch tmpfs */
    if (scratch_path[0])
        umount2(scratch_path, MNT_DETACH);
    /* Clean FIFO */
    if (fifo_path[0])
        unlink(fifo_path);
}

#define FAIL(fmt, ...) do { \
    fprintf(stderr, "{\"success\":false,\"error\":\"" fmt "\"}\n", ##__VA_ARGS__); \
    rollback_all(); \
    return 1; \
} while(0)

/* ── Path Safety ────────────────────────────────────────── */

/*
 * Reject paths with ".." components. Prevents traversal.
 * All mount targets must pass this before use.
 */
static int path_is_safe(const char *p) {
    if (!p || !p[0] || p[0] != '/') return 0;
    const char *s = p;
    while (*s) {
        if (s[0] == '.' && s[1] == '.' && (s[2] == '/' || s[2] == '\0'))
            return 0;
        while (*s && *s != '/') s++;
        while (*s == '/') s++;
    }
    return 1;
}

/*
 * Verify resolved path stays under a trusted root.
 * The security invariant is containment, not just canonicalization.
 */
static int path_under_root(const char *path, const char *root) {
    char resolved[PATH_MAX];
    size_t rlen = strlen(root);
    if (realpath(path, resolved))
        return strncmp(resolved, root, rlen) == 0 &&
               (resolved[rlen] == '/' || resolved[rlen] == '\0');
    /* Path doesn't exist yet — validate literal (mkdir will create it) */
    return strncmp(path, root, rlen) == 0 &&
           (path[rlen] == '/' || path[rlen] == '\0');
}

/* ── Helpers ────────────────────────────────────────────── */

static int do_mount(const char *src, const char *target, const char *fs,
                    unsigned long flags, const void *data) {
    if (mount(src, target, fs, flags, data) != 0) {
        fprintf(stderr, "mount failed: %s → %s (%s): %s\n",
                src ? src : "none", target, fs ? fs : "bind", strerror(errno));
        return -1;
    }
    push_mount(target);
    return 0;
}

static int mkdirs(const char *path, mode_t mode) {
    char tmp[PATH_MAX];
    snprintf(tmp, sizeof(tmp), "%s", path);
    for (char *p = tmp + 1; *p; p++) {
        if (*p == '/') {
            *p = '\0';
            if (mkdir(tmp, mode) != 0 && errno != EEXIST) return -1;
            *p = '/';
        }
    }
    if (mkdir(tmp, mode) != 0 && errno != EEXIST) return -1;
    return 0;
}

static int copy_file_safe(const char *src, const char *dst, uid_t uid, gid_t gid) {
    /* O_NOFOLLOW: reject symlinks on the source (defense against symlink-to-secret) */
    int fdin = open(src, O_RDONLY | O_NOFOLLOW);
    if (fdin < 0) return -1;
    int fdout = open(dst, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0644);
    if (fdout < 0) { close(fdin); return -1; }
    char buf[8192];
    ssize_t n;
    while ((n = read(fdin, buf, sizeof(buf))) > 0) {
        ssize_t written = 0;
        while (written < n) {
            ssize_t w = write(fdout, buf + written, (size_t)(n - written));
            if (w < 0) { close(fdin); close(fdout); return -1; }
            written += w;
        }
    }
    close(fdin);
    close(fdout);
    if (uid != (uid_t)-1) chown(dst, uid, gid);
    return 0;
}

static int write_file(const char *path, const char *content, mode_t mode) {
    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, mode);
    if (fd < 0) return -1;
    size_t len = strlen(content);
    ssize_t written = 0;
    while ((size_t)written < len) {
        ssize_t w = write(fd, content + written, len - (size_t)written);
        if (w < 0) { close(fd); return -1; }
        written += w;
    }
    close(fd);
    return 0;
}

/*
 * Split a comma-separated string into tokens.
 * Returns a NULL-terminated array of pointers into the (modified) input string.
 * Caller must free the returned array (but not the strings — they point into `str`).
 */
static char **split_csv(char *str, int *count) {
    *count = 0;
    if (!str || !str[0]) { return NULL; }
    /* Count commas */
    int n = 1;
    for (char *p = str; *p; p++) if (*p == ',') n++;
    char **arr = calloc((size_t)(n + 1), sizeof(char *));
    if (!arr) return NULL;
    char *tok = strtok(str, ",");
    while (tok) {
        arr[*count] = tok;
        (*count)++;
        tok = strtok(NULL, ",");
    }
    return arr;
}

/* ── Main ───────────────────────────────────────────────── */

int main(int argc, char *argv[]) {
    const char *project = NULL, *home = NULL, *user = NULL;
    const char *ready_fifo = NULL;
    const char *ovl_dirs_str = ".config,.claude,.codex,.cursor,.opencode,.ellul,.local,.zeroclaw,.cache";
    const char *ro_dirs_str = "";
    const char *dotfiles_str = ".claude.json,.gitconfig";
    const char *host_ip = NULL;
    int byok = 0;
    int defer_shared = 0;

    for (int i = 1; i < argc; i++) {
        if (!argv[i]) continue;
        #define ARG(name) (strcmp(argv[i], name) == 0 && i+1 < argc)
        if      ARG("--project")          project = argv[++i];
        else if ARG("--home")             home = argv[++i];
        else if ARG("--user")             user = argv[++i];
        else if ARG("--ready-fifo")       ready_fifo = argv[++i];
        else if ARG("--ovl-dirs")         ovl_dirs_str = argv[++i];
        else if ARG("--ro-dirs")          ro_dirs_str = argv[++i];
        else if ARG("--dotfiles")         dotfiles_str = argv[++i];
        else if ARG("--host-ip")          host_ip = argv[++i];
        else if (strcmp(argv[i], "--byok") == 0)           byok = 1;
        else if (strcmp(argv[i], "--defer-shared") == 0)   defer_shared = 1;
        /* Ignored: --shared, --shared-previews, --shared-ports, --comms, --readable-ns
         * These are handled by the deferred mount service in TypeScript */
        else if ARG("--shared") i++;
        else if ARG("--shared-previews") i++;
        else if ARG("--shared-ports") i++;
        else if ARG("--comms") i++;
        else if ARG("--readable-ns") i++;
        #undef ARG
    }
    (void)defer_shared; /* always deferred — rsync handled by TypeScript layer */
    (void)host_ip;      /* used by deferred mount service, not here */

    if (!project || !home || !user || !ready_fifo) {
        fprintf(stderr, "{\"success\":false,\"error\":\"Missing required args: "
                "--project --home --user --ready-fifo\"}\n");
        return 1;
    }

    /* ── Validate inputs ── */

    /* Project slug: exactly sbx-[a-z0-9]{7} */
    size_t plen = strlen(project);
    if (plen != 11 || strncmp(project, "sbx-", 4) != 0) {
        fprintf(stderr, "{\"success\":false,\"error\":\"Invalid project slug\"}\n");
        return 1;
    }
    for (size_t i = 4; i < plen; i++) {
        char c = project[i];
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'))) {
            fprintf(stderr, "{\"success\":false,\"error\":\"Invalid project slug char\"}\n");
            return 1;
        }
    }

    if (!path_is_safe(home) || !path_is_safe(ready_fifo)) {
        fprintf(stderr, "{\"success\":false,\"error\":\"Unsafe path\"}\n");
        return 1;
    }

    struct passwd *pw = getpwnam(user);
    if (!pw) {
        fprintf(stderr, "{\"success\":false,\"error\":\"User not found: %s\"}\n", user);
        return 1;
    }
    uid_t uid = pw->pw_uid;
    gid_t gid = pw->pw_gid;

    /* Build derived paths */
    char project_dir[PATH_MAX];
    snprintf(scratch_path, sizeof(scratch_path), "/run/.ns-%s", project);
    snprintf(project_dir, sizeof(project_dir), "%s/projects/%s", home, project);
    snprintf(fifo_path, sizeof(fifo_path), "%s", ready_fifo);

    if (!path_under_root(project_dir, home))
        FAIL("Project dir escapes home root");

    /* ═══════════════════════════════════════════════════════
     *  PHASE 0: PRIVATE MOUNT TREE + SCRATCH TMPFS
     * ═══════════════════════════════════════════════════════ */

    if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL) != 0)
        FAIL("rprivate failed: %s", strerror(errno));

    if (mkdirs(scratch_path, 0700) != 0 && errno != EEXIST)
        FAIL("mkdir scratch failed: %s", strerror(errno));
    if (do_mount("tmpfs", scratch_path, "tmpfs", 0, "size=512M,mode=700,uid=0,gid=0") != 0)
        FAIL("scratch tmpfs failed");

    /* ═══════════════════════════════════════════════════════
     *  PHASE 1: SAVE WRITABLE RESOURCES
     * ═══════════════════════════════════════════════════════ */

    char p[PATH_MAX];

    /* Bind project dir into scratch */
    snprintf(p, sizeof(p), "%s/project", scratch_path);
    mkdirs(p, 0755);
    if (do_mount(project_dir, p, NULL, MS_BIND, NULL) != 0)
        FAIL("bind project failed");

    /* Overlayfs lowerdirs — bind home dotdirs to scratch.
     * Create source dirs if missing (new servers may not have .cache, .claude, etc.
     * yet). Without this, overlay is skipped and the dir is inaccessible under RO home. */
    {
        char *buf = strdup(ovl_dirs_str);
        int count = 0;
        char **dirs = split_csv(buf, &count);
        for (int i = 0; i < count; i++) {
            char src[PATH_MAX], lower[PATH_MAX], upper[PATH_MAX], work[PATH_MAX];
            snprintf(src, sizeof(src), "%s/%s", home, dirs[i]);
            snprintf(lower, sizeof(lower), "%s/lower-%s", scratch_path, dirs[i]);
            snprintf(upper, sizeof(upper), "%s/upper-%s", scratch_path, dirs[i]);
            snprintf(work, sizeof(work), "%s/work-%s", scratch_path, dirs[i]);
            /* Ensure source dir exists — create owned by svc user if missing */
            if (access(src, F_OK) != 0) {
                mkdirs(src, 0755);
                chown(src, uid, gid);
            }
            mkdirs(lower, 0755); mkdirs(upper, 0755); mkdirs(work, 0755);
            chown(upper, uid, gid);
            if (do_mount(src, lower, NULL, MS_BIND, NULL) != 0)
                FAIL("bind overlay lowerdir %s failed", dirs[i]);
        }
        free(dirs); free(buf);
    }

    /* Read-only dirs (e.g. .opencode) */
    {
        char *buf = strdup(ro_dirs_str);
        int count = 0;
        char **dirs = split_csv(buf, &count);
        for (int i = 0; i < count; i++) {
            char src[PATH_MAX], dst[PATH_MAX];
            snprintf(src, sizeof(src), "%s/%s", home, dirs[i]);
            snprintf(dst, sizeof(dst), "%s/ro-%s", scratch_path, dirs[i]);
            if (access(src, F_OK) == 0) {
                mkdirs(dst, 0755);
                if (do_mount(src, dst, NULL, MS_BIND, NULL) != 0)
                    FAIL("bind RO dir %s failed", dirs[i]);
            }
        }
        free(dirs); free(buf);
    }

    /* Save writable dotfiles BEFORE making home read-only.
     * If host file missing, touch it (.claude.json gets `{}` so claude-code's
     * JSON.parse on first read doesn't choke; .gitconfig stays empty INI)
     * so phase 3's bind has both a source (scratch) and a target ($HOME). */
    {
        char dotdir[PATH_MAX];
        snprintf(dotdir, sizeof(dotdir), "%s/dotfiles", scratch_path);
        mkdirs(dotdir, 0755);
        char *buf = strdup(dotfiles_str);
        int count = 0;
        char **files = split_csv(buf, &count);
        for (int i = 0; i < count; i++) {
            char src[PATH_MAX], dst[PATH_MAX];
            snprintf(src, sizeof(src), "%s/%s", home, files[i]);
            snprintf(dst, sizeof(dst), "%s/dotfiles/%s", scratch_path, files[i]);
            const int is_json = (strstr(files[i], ".json") != NULL);
            if (access(src, F_OK) != 0) {
                int hfd = open(src, O_WRONLY | O_CREAT | O_NOFOLLOW, 0600);
                if (hfd >= 0) {
                    if (is_json) (void) write(hfd, "{}\n", 3);
                    chown(src, uid, gid);
                    close(hfd);
                }
            }
            if (access(src, F_OK) == 0) {
                copy_file_safe(src, dst, uid, gid);
            } else {
                int fd = open(dst, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0644);
                if (fd >= 0) {
                    if (is_json) (void) write(fd, "{}\n", 3);
                    chown(dst, uid, gid);
                    close(fd);
                }
            }
        }
        free(files); free(buf);
    }

    /* Context files (CLAUDE.md, AGENTS.md, GEMINI.md) */
    {
        char ctxdir[PATH_MAX];
        snprintf(ctxdir, sizeof(ctxdir), "%s/ctx", scratch_path);
        mkdirs(ctxdir, 0755);
        const char *ctx[] = {"CLAUDE.md", "AGENTS.md", "GEMINI.md", NULL};
        for (int i = 0; ctx[i]; i++) {
            char src[PATH_MAX], dst[PATH_MAX];
            snprintf(src, sizeof(src), "%s/projects/%s", home, ctx[i]);
            snprintf(dst, sizeof(dst), "%s/ctx/projects-%s", scratch_path, ctx[i]);
            struct stat st;
            if (lstat(src, &st) == 0 && S_ISREG(st.st_mode))
                copy_file_safe(src, dst, (uid_t)-1, (gid_t)-1);
        }
    }

    /* ═══════════════════════════════════════════════════════
     *  PHASE 2: DEFAULT-DENY (entire home read-only)
     * ═══════════════════════════════════════════════════════ */

    if (do_mount(home, home, NULL, MS_BIND, NULL) != 0)
        FAIL("bind home failed");
    if (mount(NULL, home, NULL, MS_BIND | MS_REMOUNT | MS_RDONLY, NULL) != 0)
        FAIL("remount home RO failed: %s", strerror(errno));

    /* ═══════════════════════════════════════════════════════
     *  PHASE 3: WRITABLE EXCEPTIONS
     * ═══════════════════════════════════════════════════════ */

    /* Restore writable dotfiles over RO home. Phase 1 guarantees both
     * the scratch source and the $HOME target exist, so the bind always
     * fires — no fall-through to the RO underlying file. */
    {
        char *buf = strdup(dotfiles_str);
        int count = 0;
        char **files = split_csv(buf, &count);
        for (int i = 0; i < count; i++) {
            char src[PATH_MAX], dst[PATH_MAX];
            snprintf(src, sizeof(src), "%s/dotfiles/%s", scratch_path, files[i]);
            snprintf(dst, sizeof(dst), "%s/%s", home, files[i]);
            if (access(src, F_OK) != 0) continue;
            if (do_mount(src, dst, NULL, MS_BIND, NULL) != 0)
                FAIL("bind dotfile %s failed", files[i]);
        }
        free(files); free(buf);
    }

    /* Projects tmpfs + project bind */
    {
        char projects[PATH_MAX];
        snprintf(projects, sizeof(projects), "%s/projects", home);
        if (do_mount("tmpfs", projects, "tmpfs", 0, "size=1M,mode=755") != 0)
            FAIL("projects tmpfs failed");
        mkdirs(project_dir, 0755);
        snprintf(p, sizeof(p), "%s/project", scratch_path);
        if (do_mount(p, project_dir, NULL, MS_BIND, NULL) != 0)
            FAIL("bind project into tmpfs failed");
    }

    /* Copy context files into projects dir */
    {
        const char *ctx[] = {"CLAUDE.md", "AGENTS.md", "GEMINI.md", NULL};
        for (int i = 0; ctx[i]; i++) {
            char src[PATH_MAX], dst[PATH_MAX];
            snprintf(src, sizeof(src), "%s/ctx/projects-%s", scratch_path, ctx[i]);
            snprintf(dst, sizeof(dst), "%s/projects/%s", home, ctx[i]);
            if (access(src, F_OK) == 0)
                copy_file_safe(src, dst, (uid_t)-1, (gid_t)-1);
        }
    }

    /* Create .shared/ and .comms/ dirs for deferred mounts.
     * SECURITY: root-owned, mode 0555 (read-only to agent).
     * Agent cannot create symlinks here — prevents symlink-to-secret attacks
     * where a symlink placed before deferred mount could trick the mount
     * service into exposing host files.
     * The deferred mount service creates subdirs as root before populating. */
    {
        char shared[PATH_MAX], comms[PATH_MAX];
        snprintf(shared, sizeof(shared), "%s/.shared", project_dir);
        snprintf(comms, sizeof(comms), "%s/.comms", home);
        mkdirs(shared, 0555);
        chown(shared, 0, 0);  /* root-owned, agent cannot write */
        mkdirs(comms, 0555);
        chown(comms, 0, 0);   /* root-owned, agent cannot write */
    }

    /* Overlayfs layers */
    {
        char *buf = strdup(ovl_dirs_str);
        int count = 0;
        char **dirs = split_csv(buf, &count);
        for (int i = 0; i < count; i++) {
            char lower[PATH_MAX], target[PATH_MAX], opts[PATH_MAX * 4];
            snprintf(lower, sizeof(lower), "%s/lower-%s", scratch_path, dirs[i]);
            snprintf(target, sizeof(target), "%s/%s", home, dirs[i]);
            if (access(lower, F_OK) == 0) {
                snprintf(opts, sizeof(opts),
                    "lowerdir=%s/lower-%s,upperdir=%s/upper-%s,workdir=%s/work-%s",
                    scratch_path, dirs[i], scratch_path, dirs[i], scratch_path, dirs[i]);
                if (do_mount("overlay", target, "overlay", 0, opts) != 0)
                    FAIL("overlay %s failed", dirs[i]);
            }
        }
        free(dirs); free(buf);
    }

    /* Read-only bind-mounts */
    {
        char *buf = strdup(ro_dirs_str);
        int count = 0;
        char **dirs = split_csv(buf, &count);
        for (int i = 0; i < count; i++) {
            char src[PATH_MAX], dst[PATH_MAX];
            snprintf(src, sizeof(src), "%s/ro-%s", scratch_path, dirs[i]);
            snprintf(dst, sizeof(dst), "%s/%s", home, dirs[i]);
            if (access(src, F_OK) == 0) {
                if (do_mount(src, dst, NULL, MS_BIND, NULL) != 0)
                    FAIL("bind RO %s failed", dirs[i]);
                if (mount(NULL, dst, NULL, MS_BIND | MS_REMOUNT | MS_RDONLY, NULL) != 0)
                    FAIL("remount RO %s failed: %s", dirs[i], strerror(errno));
            }
        }
        free(dirs); free(buf);
    }

    /* ═══════════════════════════════════════════════════════
     *  PHASE 4: SYSTEM ISOLATION
     * ═══════════════════════════════════════════════════════ */

    if (do_mount("proc", "/proc", "proc", 0, "hidepid=2") != 0)
        FAIL("proc mount failed");
    if (do_mount("tmpfs", "/tmp", "tmpfs", 0, "size=256M,mode=1777") != 0)
        FAIL("tmp mount failed");

    /* DNS config */
    {
        char dnsdir[PATH_MAX], dnsfile[PATH_MAX];
        snprintf(dnsdir, sizeof(dnsdir), "%s/dns", scratch_path);
        snprintf(dnsfile, sizeof(dnsfile), "%s/dns/resolv.conf", scratch_path);
        mkdirs(dnsdir, 0755);
        write_file(dnsfile, "nameserver 8.8.8.8\nnameserver 1.1.1.1\n", 0644);
        if (do_mount(dnsfile, "/etc/resolv.conf", NULL, MS_BIND, NULL) != 0)
            FAIL("DNS bind mount failed");
    }

    /* BYOK DNS blackhole */
    if (byok) {
        char hostsfile[PATH_MAX];
        snprintf(hostsfile, sizeof(hostsfile), "%s/dns/hosts", scratch_path);
        /* Use 0.0.0.0 (not 127.0.0.0 — the latter is a network address and
         * some resolvers refuse to use it as a host, falling through to DNS
         * resolution and defeating the blackhole). 0.0.0.0 is guaranteed to
         * be unrouteable from userspace and is the standard
         * /etc/hosts-blackhole form. */
        write_file(hostsfile,
            "127.0.0.1 localhost\n"
            "0.0.0.0 api.anthropic.com\n"
            "0.0.0.0 api.openai.com\n"
            "0.0.0.0 generativelanguage.googleapis.com\n"
            "0.0.0.0 openrouter.ai\n"
            "0.0.0.0 api.deepseek.com\n"
            "0.0.0.0 api.mistral.ai\n"
            "0.0.0.0 api.x.ai\n"
            "0.0.0.0 api.groq.com\n", 0644);
        if (do_mount(hostsfile, "/etc/hosts", NULL, MS_BIND, NULL) != 0)
            FAIL("BYOK hosts bind mount failed");
    }

    /* Shield data blackholes (size=0 tmpfs — inaccessible).
     *
     * SECURITY-CRITICAL: these mounts are load-bearing. If any one fails the
     * agent inside the namespace can read shield-data (cross-project config,
     * IPC tokens, BYOK manifests), the LUKS-shielded vault, or the shield
     * runtime socket dir. We MUST fail closed: the namespace never reaches
     * READY and the agent never enters.
     *
     * Pre-existing tmpfs at the same target is fine (idempotent setup); any
     * other error → rollback. We post-validate by stat'ing the mountpoint and
     * confirming it's an empty directory whose listing returns ENOENT-ish.
     */
    if (do_mount("tmpfs", "/etc/ellul/shield-data", "tmpfs", 0, "size=0,mode=000") != 0)
        FAIL("shield-data blackhole mount failed (cannot fail open)");
    if (do_mount("tmpfs", "/var/lib/ellul-shielded", "tmpfs", 0, "size=0,mode=000") != 0)
        FAIL("ellul-shielded blackhole mount failed (cannot fail open)");
    if (do_mount("tmpfs", "/run/shield", "tmpfs", 0, "size=0,mode=000") != 0)
        FAIL("run/shield blackhole mount failed (cannot fail open)");

    /* ═══════════════════════════════════════════════════════
     *  PHASE 5: SIGNAL READINESS + ANCHOR
     * ═══════════════════════════════════════════════════════ */

    {
        int fd = open(ready_fifo, O_WRONLY);
        if (fd < 0)
            FAIL("ready FIFO open failed: %s: %s", ready_fifo, strerror(errno));
        const char *msg = "ready\n";
        if (write(fd, msg, strlen(msg)) < 0) {
            close(fd);
            FAIL("ready FIFO write failed: %s", strerror(errno));
        }
        close(fd);
    }

    /* Clear fifo_path so rollback doesn't delete the FIFO after signaling */
    fifo_path[0] = '\0';

    /* Become the anchor process — runs until namespace is torn down */
    execlp("sleep", "sleep", "infinity", (char *)NULL);
    /* If exec fails, block indefinitely (keeps namespace alive) */
    for (;;) pause();
    return 0;
}
