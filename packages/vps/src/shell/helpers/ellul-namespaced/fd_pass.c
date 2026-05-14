/*
 * ellul-fd-pass — bridge-side helper for SCM_RIGHTS file-descriptor passing.
 *
 * Node's net.Socket has no public API for sendmsg(2) ancillary data, and
 * memfd_create / F_ADD_SEALS aren't exposed via fs either. This helper
 * does both: builds the sealed argv/env memfds from content the bridge
 * provides via pipes, then sendmsg's the bundle (memfds + bridge stdio
 * fds inherited via child_process.stdio array) to the daemon socket.
 *
 * Argument shape:
 *   ellul-fd-pass --target=PATH \
 *       --frame-fd=N \
 *       [--argv-fd=N] [--env-fd=N] \
 *       --fd=NAME:FILENO[,NAME:FILENO]...
 *
 * Where:
 *   --target     unix-socket path (e.g. /run/ellul-ns/<project>/ctl.sock)
 *   --frame-fd   read the body frame (CBOR + 16-byte HMAC trailer) from
 *                this fd, with a 4-byte BE length prefix
 *   --argv-fd    optional. Read NUL-terminated argv content from this fd;
 *                helper creates a memfd, writes content, applies seals
 *                (F_SEAL_WRITE|F_SEAL_GROW|F_SEAL_SHRINK), prepends as
 *                first ancillary fd
 *   --env-fd     optional. Same as --argv-fd but for env content; appears
 *                after the argv memfd in the ancillary fd list
 *   --fd         comma-separated NAME:fileno pairs for already-open fds
 *                (typically stdin/stdout/stderr inherited via Node stdio)
 *
 * Wire shape:
 *   helper writes the frame as the SOLE message of a sendmsg(2) call, with
 *   the FDs in cmsghdr SCM_RIGHTS in the declared order. After sendmsg, the
 *   helper acts as a half-duplex pump: it forwards bytes from `--target`
 *   (responses + EXIT_NOTIFY) back to its stdout, length-prefixed by the
 *   daemon's framing. Bridge reads its stdout to get those frames.
 *
 * Bridge-side stdin to the helper is forwarded straight to the target
 * socket (so additional bridge-initiated requests on the same connection
 * can flow through), but the current pipeline uses one connection per
 * spawn so this is just a no-op pump for now.
 *
 * Exit codes:
 *   0   — clean disconnect by daemon
 *   64  — usage / argv parse error
 *   65  — invalid argument
 *   66  — connect/sendmsg failed
 *   1   — other I/O error
 *
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 ellul.ai. All rights reserved.
 */

#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <linux/memfd.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/un.h>
#include <unistd.h>

#ifndef F_ADD_SEALS
#define F_ADD_SEALS    1033
#endif
#ifndef F_SEAL_SHRINK
#define F_SEAL_SHRINK  0x0002
#define F_SEAL_GROW    0x0004
#define F_SEAL_WRITE   0x0008
#endif
#ifndef MFD_CLOEXEC
#define MFD_CLOEXEC    0x0001
#endif
#ifndef MFD_ALLOW_SEALING
#define MFD_ALLOW_SEALING 0x0002
#endif

#ifndef __NR_memfd_create
#define __NR_memfd_create 319
#endif

static int sys_memfd_create(const char *name, unsigned int flags) {
    return (int) syscall(__NR_memfd_create, name, flags);
}

#define HELPER_MAX_FDS         8
#define HELPER_MAX_FRAME       (64 * 1024)
#define HELPER_MAX_TARGET_PATH 108  /* sun_path */
#define HELPER_MAX_MEMFD       (64 * 1024)

struct fd_spec {
    char name[32];
    int  fileno;
};

static void usage(const char *prog) {
    fprintf(stderr,
        "usage: %s --target=PATH --frame-fd=N --fd=NAME:FILENO[,NAME:FILENO]...\n",
        prog);
}

static int parse_args(int argc, char **argv,
                      char *target, size_t target_cap,
                      int *frame_fd,
                      int *argv_fd, int *env_fd,
                      struct fd_spec *fds, size_t fds_cap, size_t *fds_n) {
    target[0] = 0;
    *frame_fd = -1;
    *argv_fd = -1;
    *env_fd = -1;
    *fds_n = 0;

    for (int i = 1; i < argc; i++) {
        const char *a = argv[i];
        if (strncmp(a, "--target=", 9) == 0) {
            const char *v = a + 9;
            if (strlen(v) >= target_cap) return 65;
            strncpy(target, v, target_cap - 1);
            target[target_cap - 1] = 0;
        } else if (strncmp(a, "--frame-fd=", 11) == 0) {
            char *end;
            long v = strtol(a + 11, &end, 10);
            if (*end != 0 || v < 0 || v > 1024) return 65;
            *frame_fd = (int)v;
        } else if (strncmp(a, "--argv-fd=", 10) == 0) {
            char *end;
            long v = strtol(a + 10, &end, 10);
            if (*end != 0 || v < 0 || v > 1024) return 65;
            *argv_fd = (int)v;
        } else if (strncmp(a, "--env-fd=", 9) == 0) {
            char *end;
            long v = strtol(a + 9, &end, 10);
            if (*end != 0 || v < 0 || v > 1024) return 65;
            *env_fd = (int)v;
        } else if (strncmp(a, "--fd=", 5) == 0) {
            const char *list = a + 5;
            char buf[512];
            if (strlen(list) >= sizeof(buf)) return 65;
            strcpy(buf, list);
            char *p = buf;
            while (p && *p) {
                char *comma = strchr(p, ',');
                if (comma) *comma = 0;
                char *colon = strchr(p, ':');
                if (!colon) return 65;
                *colon = 0;
                if (*fds_n >= fds_cap) return 65;
                struct fd_spec *fs = &fds[(*fds_n)++];
                if (strlen(p) >= sizeof(fs->name)) return 65;
                strncpy(fs->name, p, sizeof(fs->name) - 1);
                fs->name[sizeof(fs->name) - 1] = 0;
                char *end;
                long n = strtol(colon + 1, &end, 10);
                if (*end != 0 || n < 0 || n > 1024) return 65;
                fs->fileno = (int)n;
                p = comma ? comma + 1 : NULL;
            }
        } else {
            usage(argv[0]);
            return 64;
        }
    }
    if (!target[0] || *frame_fd < 0) {
        usage(argv[0]);
        return 64;
    }
    return 0;
}

static ssize_t read_full(int fd, void *buf, size_t want) {
    char *p = buf;
    size_t got = 0;
    while (got < want) {
        ssize_t r = read(fd, p + got, want - got);
        if (r > 0) { got += (size_t)r; continue; }
        if (r == 0) return (ssize_t)got;
        if (errno == EINTR) continue;
        return -1;
    }
    return (ssize_t)got;
}

static int write_full(int fd, const void *buf, size_t want) {
    const char *p = buf;
    size_t sent = 0;
    while (sent < want) {
        ssize_t w = write(fd, p + sent, want - sent);
        if (w > 0) { sent += (size_t)w; continue; }
        if (w < 0 && errno == EINTR) continue;
        return -1;
    }
    return 0;
}

static int connect_target(const char *path) {
    int s = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (s < 0) return -1;
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    if (strlen(path) >= sizeof(addr.sun_path)) { close(s); return -1; }
    strncpy(addr.sun_path, path, sizeof(addr.sun_path) - 1);
    if (connect(s, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        close(s); return -1;
    }
    return s;
}

/* Send a single frame with ancillary FD list. The frame is one
 * length-prefixed message; SCM_RIGHTS attaches `fd_count` fds. */
static int send_frame_with_fds(int sock, const uint8_t *frame, size_t frame_len,
                               const int *fds, size_t fd_count) {
    struct msghdr msg;
    memset(&msg, 0, sizeof(msg));

    /* Length prefix is 4 bytes BE; daemon's nsd_frame_read expects this. */
    uint8_t lenbuf[4] = {
        (uint8_t)(frame_len >> 24),
        (uint8_t)(frame_len >> 16),
        (uint8_t)(frame_len >> 8),
        (uint8_t)(frame_len & 0xff),
    };

    struct iovec iov[2] = {
        { .iov_base = lenbuf, .iov_len = 4 },
        { .iov_base = (void *)frame, .iov_len = frame_len },
    };
    msg.msg_iov = iov;
    msg.msg_iovlen = 2;

    union {
        struct cmsghdr align;
        char buf[CMSG_SPACE(sizeof(int) * HELPER_MAX_FDS)];
    } cmsg_buf;

    if (fd_count > 0) {
        memset(&cmsg_buf, 0, sizeof(cmsg_buf));
        msg.msg_control = cmsg_buf.buf;
        msg.msg_controllen = CMSG_SPACE(sizeof(int) * fd_count);

        struct cmsghdr *cmsg = CMSG_FIRSTHDR(&msg);
        cmsg->cmsg_level = SOL_SOCKET;
        cmsg->cmsg_type = SCM_RIGHTS;
        cmsg->cmsg_len = CMSG_LEN(sizeof(int) * fd_count);
        memcpy(CMSG_DATA(cmsg), fds, sizeof(int) * fd_count);
        msg.msg_controllen = cmsg->cmsg_len;
    }

    /* sendmsg may short-write; loop. The cmsg only ships on the FIRST
     * sendmsg, so we use a loop that re-sends from the byte offset
     * without ancillary on subsequent iterations. In practice on
     * AF_UNIX SOCK_STREAM with frames <= 64 KiB and default sndbuf,
     * one call sends everything. */
    ssize_t s = sendmsg(sock, &msg, MSG_NOSIGNAL);
    if (s < 0) return -1;
    size_t total = 4 + frame_len;
    if ((size_t)s == total) return 0;

    /* Partial send: dispatch the remainder without ancillary. */
    size_t remaining = total - (size_t)s;
    const uint8_t *cursor;
    if ((size_t)s < 4) {
        if (write_full(sock, lenbuf + s, 4 - (size_t)s) != 0) return -1;
        cursor = frame;
        remaining = frame_len;
    } else {
        cursor = frame + ((size_t)s - 4);
    }
    if (remaining > 0) {
        if (write_full(sock, cursor, remaining) != 0) return -1;
    }
    return 0;
}

/*
 * Drain stdin-pipe into a fresh sealed memfd. Returns the memfd or -1.
 * Seals applied: F_SEAL_WRITE | F_SEAL_GROW | F_SEAL_SHRINK.
 */
static int build_sealed_memfd(int src_fd, const char *name) {
    int mfd = sys_memfd_create(name, MFD_CLOEXEC | MFD_ALLOW_SEALING);
    if (mfd < 0) return -1;
    char buf[4096];
    size_t total = 0;
    while (1) {
        ssize_t r = read(src_fd, buf, sizeof(buf));
        if (r > 0) {
            total += (size_t)r;
            if (total > HELPER_MAX_MEMFD) {
                close(mfd);
                fprintf(stderr, "ellul-fd-pass: %s memfd exceeds 64 KiB\n", name);
                return -1;
            }
            ssize_t w = write(mfd, buf, (size_t)r);
            if (w != r) { close(mfd); return -1; }
            continue;
        }
        if (r == 0) break;
        if (errno == EINTR) continue;
        close(mfd); return -1;
    }
    /* Apply seals — daemon validates these via F_GET_SEALS. */
    int seals = F_SEAL_WRITE | F_SEAL_GROW | F_SEAL_SHRINK;
    if (fcntl(mfd, F_ADD_SEALS, seals) != 0) {
        close(mfd);
        fprintf(stderr, "ellul-fd-pass: F_ADD_SEALS failed: %s\n", strerror(errno));
        return -1;
    }
    return mfd;
}

int main(int argc, char **argv) {
    char target[HELPER_MAX_TARGET_PATH];
    int frame_fd, argv_fd, env_fd;
    struct fd_spec specs[HELPER_MAX_FDS];
    size_t spec_n;

    int rc = parse_args(argc, argv, target, sizeof(target),
                        &frame_fd, &argv_fd, &env_fd,
                        specs, HELPER_MAX_FDS, &spec_n);
    if (rc != 0) return rc;

    /* Read the body frame: u32 BE length followed by `length` bytes. The
     * BRIDGE writes this to --frame-fd. We then write it to the daemon
     * via sendmsg with the same length prefix the daemon expects. */
    uint8_t lenbuf[4];
    if (read_full(frame_fd, lenbuf, 4) != 4) return 65;
    uint32_t flen = ((uint32_t)lenbuf[0] << 24) |
                    ((uint32_t)lenbuf[1] << 16) |
                    ((uint32_t)lenbuf[2] << 8)  |
                     (uint32_t)lenbuf[3];
    if (flen == 0 || flen > HELPER_MAX_FRAME) return 65;
    uint8_t *frame = malloc(flen);
    if (!frame) return 65;
    if ((size_t) read_full(frame_fd, frame, flen) != flen) { free(frame); return 65; }
    close(frame_fd);

    /* Build sealed memfds for argv / env (if provided), then add the
     * named pre-open FDs (stdin, stdout, stderr inherited from bridge). */
    int fd_array[HELPER_MAX_FDS];
    size_t fd_count = 0;
    if (argv_fd >= 0) {
        int m = build_sealed_memfd(argv_fd, "ellul-argv");
        if (m < 0) { free(frame); return 65; }
        fd_array[fd_count++] = m;
        close(argv_fd);
    }
    if (env_fd >= 0) {
        int m = build_sealed_memfd(env_fd, "ellul-env");
        if (m < 0) {
            for (size_t i = 0; i < fd_count; i++) close(fd_array[i]);
            free(frame);
            return 65;
        }
        fd_array[fd_count++] = m;
        close(env_fd);
    }
    for (size_t i = 0; i < spec_n; i++) {
        if (fd_count >= HELPER_MAX_FDS) {
            for (size_t j = 0; j < fd_count; j++) close(fd_array[j]);
            free(frame);
            fprintf(stderr, "ellul-fd-pass: too many fds\n");
            return 65;
        }
        fd_array[fd_count] = specs[i].fileno;
        struct stat sb;
        if (fstat(fd_array[fd_count], &sb) != 0) {
            for (size_t j = 0; j < fd_count; j++) close(fd_array[j]);
            free(frame);
            fprintf(stderr, "ellul-fd-pass: invalid fd %d (%s): %s\n",
                    fd_array[fd_count], specs[i].name, strerror(errno));
            return 65;
        }
        fd_count++;
    }

    int sock = connect_target(target);
    if (sock < 0) {
        fprintf(stderr, "ellul-fd-pass: connect %s failed: %s\n",
                target, strerror(errno));
        free(frame);
        return 66;
    }

    /* The first frame the daemon expects on accept is HELLO (server-
     * initiated). We pass that through to the bridge unchanged before
     * sending OUR frame. */
    /* Read HELLO (server-sent immediately on accept). */
    uint8_t hellolen[4];
    if (read_full(sock, hellolen, 4) != 4) { free(frame); close(sock); return 1; }
    uint32_t hlen = ((uint32_t)hellolen[0] << 24) |
                    ((uint32_t)hellolen[1] << 16) |
                    ((uint32_t)hellolen[2] << 8)  |
                     (uint32_t)hellolen[3];
    if (hlen == 0 || hlen > HELPER_MAX_FRAME) { free(frame); close(sock); return 1; }
    uint8_t *hello = malloc(hlen);
    if (!hello) { free(frame); close(sock); return 1; }
    if ((size_t) read_full(sock, hello, hlen) != hlen) {
        free(hello); free(frame); close(sock); return 1;
    }
    /* Forward HELLO to bridge via stdout: [4-byte BE length][hlen bytes]. */
    if (write_full(STDOUT_FILENO, hellolen, 4) != 0 ||
        write_full(STDOUT_FILENO, hello, hlen) != 0) {
        free(hello); free(frame); close(sock); return 1;
    }
    free(hello);

    /* Read CLIENT_HELLO from bridge stdin and forward to daemon (no fds). */
    uint8_t chlenbuf[4];
    if (read_full(STDIN_FILENO, chlenbuf, 4) != 4) { free(frame); close(sock); return 1; }
    uint32_t chlen = ((uint32_t)chlenbuf[0] << 24) |
                     ((uint32_t)chlenbuf[1] << 16) |
                     ((uint32_t)chlenbuf[2] << 8)  |
                      (uint32_t)chlenbuf[3];
    if (chlen == 0 || chlen > HELPER_MAX_FRAME) { free(frame); close(sock); return 1; }
    uint8_t *ch = malloc(chlen);
    if (!ch) { free(frame); close(sock); return 1; }
    if ((size_t) read_full(STDIN_FILENO, ch, chlen) != chlen) {
        free(ch); free(frame); close(sock); return 1;
    }
    if (write_full(sock, chlenbuf, 4) != 0 || write_full(sock, ch, chlen) != 0) {
        free(ch); free(frame); close(sock); return 1;
    }
    free(ch);

    /* Send the actual frame WITH the ancillary FDs. */
    if (send_frame_with_fds(sock, frame, flen, fd_array, fd_count) != 0) {
        fprintf(stderr, "ellul-fd-pass: sendmsg failed: %s\n", strerror(errno));
        for (size_t i = 0; i < fd_count; i++) close(fd_array[i]);
        free(frame); close(sock); return 66;
    }
    free(frame);
    /* Close our copies. Daemon's child has dup'd these via setns + dup3
     * so the kernel keeps the file descriptions alive. */
    for (size_t i = 0; i < fd_count; i++) close(fd_array[i]);

    /* Pump bytes between bridge stdin/stdout and daemon socket until
     * either side closes. The daemon sends EXIT_NOTIFY here as the final
     * server-initiated frame; helper forwards verbatim. */
    struct pollfd fds[2] = {
        { .fd = sock,         .events = POLLIN },
        { .fd = STDIN_FILENO, .events = POLLIN },
    };
    while (1) {
        int pr = poll(fds, 2, 60 * 1000);
        if (pr < 0) {
            if (errno == EINTR) continue;
            close(sock);
            return 1;
        }
        if (pr == 0) continue;  /* idle keep-alive — child may take time to exit */

        if (fds[0].revents & POLLIN) {
            char buf[8192];
            ssize_t r = read(sock, buf, sizeof(buf));
            if (r > 0) {
                if (write_full(STDOUT_FILENO, buf, (size_t)r) != 0) {
                    close(sock); return 1;
                }
            } else if (r == 0) {
                close(sock); return 0;
            } else if (errno != EINTR && errno != EAGAIN) {
                close(sock); return 1;
            }
        }
        if (fds[1].revents & POLLIN) {
            char buf[8192];
            ssize_t r = read(STDIN_FILENO, buf, sizeof(buf));
            if (r > 0) {
                if (write_full(sock, buf, (size_t)r) != 0) {
                    close(sock); return 1;
                }
            } else if (r == 0) {
                /* Bridge closed stdin — half-shutdown send side. */
                shutdown(sock, SHUT_WR);
                fds[1].fd = -1;
            } else if (errno != EINTR && errno != EAGAIN) {
                close(sock); return 1;
            }
        }
        if ((fds[0].revents & POLLHUP) && (fds[0].revents & POLLIN) == 0) {
            close(sock); return 0;
        }
    }
    close(sock);
    return 0;
}
