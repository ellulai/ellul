/*
 * ellul-namespaced — CBOR framing and codec implementation.
 *
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 ellul.ai. All rights reserved.
 */

#define _GNU_SOURCE

#include "cbor_io.h"
#include "log.h"

#include <errno.h>
#include <poll.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/uio.h>
#include <unistd.h>
#include <sodium.h>

#include <cbor.h>  /* libtinycbor */

/* ── Frame I/O ───────────────────────────────────────────── */

static ssize_t read_full(int fd, uint8_t *buf, size_t want) {
    size_t got = 0;
    while (got < want) {
        ssize_t r = read(fd, buf + got, want - got);
        if (r > 0) { got += (size_t)r; continue; }
        if (r == 0) {
            if (got == 0) return 0;
            errno = EPROTO;
            return -1;
        }
        int saved = errno;
        if (saved == EINTR) continue;
        if (saved == EAGAIN || saved == EWOULDBLOCK) {
            struct pollfd pfd = { .fd = fd, .events = POLLIN };
            int pr = poll(&pfd, 1, 10000);
            if (pr > 0) continue;
            if (pr == 0) errno = ETIMEDOUT;
            return -1;
        }
        errno = saved;
        return -1;
    }
    return (ssize_t)got;
}

ssize_t nsd_frame_read(int fd, uint8_t *out_buf, size_t buf_len) {
    if (buf_len < 4) { errno = EINVAL; return -1; }
    uint8_t lenbuf[4];
    ssize_t r = read_full(fd, lenbuf, 4);
    if (r <= 0) return r;
    uint32_t len = ((uint32_t)lenbuf[0] << 24) |
                   ((uint32_t)lenbuf[1] << 16) |
                   ((uint32_t)lenbuf[2] << 8)  |
                    (uint32_t)lenbuf[3];
    if (len == 0 || len > NSD_MAX_FRAME_BYTES || len > buf_len) {
        errno = EPROTO;
        return -1;
    }
    r = read_full(fd, out_buf, len);
    if (r <= 0) return r;
    return (ssize_t)len;
}

/*
 * recvmsg-based variant that captures any SCM_RIGHTS FDs alongside the
 * frame. The frame layout on the wire is identical to nsd_frame_read —
 * 4-byte length prefix then `length` bytes — but the FDs ride in
 * ancillary data on the FIRST recvmsg only.
 *
 * We do TWO recvmsg calls:
 *   1) length prefix (4 bytes) — usually carries the cmsg too
 *   2) frame body
 * Some senders pack cmsg with body bytes; we accept cmsg on either call.
 */
/* Wait for fd readable up to timeout_ms. Returns 1 ready, 0 timeout, -1 err. */
static int wait_readable(int fd, int timeout_ms) {
    struct pollfd pfd = { .fd = fd, .events = POLLIN };
    int pr = poll(&pfd, 1, timeout_ms);
    if (pr == 0) errno = ETIMEDOUT;
    return pr;
}

/* Like recvmsg but polls on EAGAIN (socket is non-blocking from accept4). */
static ssize_t recvmsg_block(int fd, struct msghdr *m, int flags) {
    for (;;) {
        ssize_t r = recvmsg(fd, m, flags);
        if (r >= 0) return r;
        if (errno == EINTR) continue;
        if (errno == EAGAIN || errno == EWOULDBLOCK) {
            int wr = wait_readable(fd, 30000);
            if (wr <= 0) return -1;
            continue;
        }
        return -1;
    }
}

ssize_t nsd_frame_recvmsg(int fd, uint8_t *out_buf, size_t buf_len,
                          int *out_fds, size_t out_fds_cap, size_t *out_fds_n) {
    if (buf_len < 4) { errno = EINVAL; return -1; }
    *out_fds_n = 0;

    /* Reasonably-sized cmsg buffer for up to 8 fds. */
    union {
        struct cmsghdr align;
        char buf[CMSG_SPACE(sizeof(int) * 8)];
    } cmsg_buf;

    uint8_t lenbuf[4];
    struct iovec iov_len = { .iov_base = lenbuf, .iov_len = 4 };
    struct msghdr m1;
    memset(&m1, 0, sizeof(m1));
    m1.msg_iov = &iov_len;
    m1.msg_iovlen = 1;
    m1.msg_control = cmsg_buf.buf;
    m1.msg_controllen = sizeof(cmsg_buf);

    ssize_t r = recvmsg_block(fd, &m1, MSG_CMSG_CLOEXEC);
    if (r <= 0) return r;
    if (r < 4) {
        ssize_t got = r;
        while (got < 4) {
            ssize_t rr = recv(fd, lenbuf + got, 4 - (size_t)got, 0);
            if (rr < 0) {
                if (errno == EINTR) continue;
                if (errno == EAGAIN || errno == EWOULDBLOCK) {
                    if (wait_readable(fd, 30000) <= 0) return -1;
                    continue;
                }
                return -1;
            }
            if (rr == 0) return 0;
            got += rr;
        }
    }

    /* Process cmsg from m1. */
    for (struct cmsghdr *c = CMSG_FIRSTHDR(&m1); c != NULL; c = CMSG_NXTHDR(&m1, c)) {
        if (c->cmsg_level == SOL_SOCKET && c->cmsg_type == SCM_RIGHTS) {
            size_t n = (c->cmsg_len - CMSG_LEN(0)) / sizeof(int);
            const int *fdarr = (const int *)CMSG_DATA(c);
            for (size_t i = 0; i < n; i++) {
                if (*out_fds_n < out_fds_cap) {
                    out_fds[(*out_fds_n)++] = fdarr[i];
                } else {
                    /* Too many fds — close the excess to avoid leak. */
                    close(fdarr[i]);
                }
            }
        }
    }

    uint32_t flen = ((uint32_t)lenbuf[0] << 24) |
                    ((uint32_t)lenbuf[1] << 16) |
                    ((uint32_t)lenbuf[2] << 8)  |
                     (uint32_t)lenbuf[3];
    if (flen == 0 || flen > NSD_MAX_FRAME_BYTES || flen > buf_len) {
        for (size_t i = 0; i < *out_fds_n; i++) close(out_fds[i]);
        *out_fds_n = 0;
        errno = EPROTO;
        return -1;
    }

    /* Read the body. cmsg may also arrive on this call (some senders
     * separate the prefix and body). */
    struct iovec iov_body = { .iov_base = out_buf, .iov_len = flen };
    struct msghdr m2;
    memset(&m2, 0, sizeof(m2));
    m2.msg_iov = &iov_body;
    m2.msg_iovlen = 1;
    m2.msg_control = cmsg_buf.buf;
    m2.msg_controllen = sizeof(cmsg_buf);

    size_t got = 0;
    while (got < flen) {
        r = recvmsg_block(fd, &m2, MSG_CMSG_CLOEXEC);
        if (r <= 0) {
            for (size_t i = 0; i < *out_fds_n; i++) close(out_fds[i]);
            *out_fds_n = 0;
            return r < 0 ? -1 : 0;
        }
        for (struct cmsghdr *c = CMSG_FIRSTHDR(&m2); c != NULL; c = CMSG_NXTHDR(&m2, c)) {
            if (c->cmsg_level == SOL_SOCKET && c->cmsg_type == SCM_RIGHTS) {
                size_t n = (c->cmsg_len - CMSG_LEN(0)) / sizeof(int);
                const int *fdarr = (const int *)CMSG_DATA(c);
                for (size_t i = 0; i < n; i++) {
                    if (*out_fds_n < out_fds_cap) {
                        out_fds[(*out_fds_n)++] = fdarr[i];
                    } else {
                        close(fdarr[i]);
                    }
                }
            }
        }
        got += (size_t)r;
        /* Subsequent iterations: shift iov_body forward. */
        iov_body.iov_base = out_buf + got;
        iov_body.iov_len = flen - got;
        m2.msg_control = NULL;  /* cmsg was on the first iter */
        m2.msg_controllen = 0;
    }

    return (ssize_t)flen;
}

int nsd_frame_write(int fd, const uint8_t *body, size_t body_len) {
    if (body_len > NSD_MAX_FRAME_BYTES) { errno = EMSGSIZE; return -1; }
    uint8_t lenbuf[4] = {
        (uint8_t)((body_len >> 24) & 0xff),
        (uint8_t)((body_len >> 16) & 0xff),
        (uint8_t)((body_len >> 8) & 0xff),
        (uint8_t)(body_len & 0xff),
    };
    struct iovec iov[2] = {
        { .iov_base = lenbuf, .iov_len = 4 },
        { .iov_base = (void *)body, .iov_len = body_len },
    };
    /* Single writev: kernel guarantees no interleaving on AF_UNIX SOCK_STREAM
     * for writes <= SO_SNDBUF. body_len capped at 64 KiB; default sndbuf
     * comfortably exceeds that. */
    size_t total = 4 + body_len;
    size_t sent = 0;
    while (sent < total) {
        ssize_t w = writev(fd, iov, 2);
        if (w < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        if (w == 0) { errno = EPIPE; return -1; }
        sent += (size_t)w;
        if (sent < total) {
            /* Adjust iov for the remaining bytes. */
            if (sent < 4) {
                iov[0].iov_base = lenbuf + sent;
                iov[0].iov_len = 4 - sent;
            } else {
                iov[0].iov_base = (void *)(body + (sent - 4));
                iov[0].iov_len = 0;
                iov[1].iov_base = (void *)(body + (sent - 4));
                iov[1].iov_len = body_len - (sent - 4);
            }
        }
    }
    return 0;
}

/* ── Encoder ─────────────────────────────────────────────── */

void nsd_enc_init(struct nsd_encoder *e, uint8_t *buf, size_t cap) {
    e->buf = buf;
    e->cap = cap;
    e->pos = 0;
    e->overflow = false;
}

static void enc_write(struct nsd_encoder *e, const uint8_t *src, size_t n) {
    if (e->overflow) return;
    if (e->pos + n > e->cap) { e->overflow = true; return; }
    memcpy(e->buf + e->pos, src, n);
    e->pos += n;
}

/* CBOR primitive encoders following RFC 8949 §3.1.
 *
 * Major types: 0=uint, 1=nint, 2=bstr, 3=tstr, 4=array, 5=map, 6=tag, 7=simple.
 * Argument encoding chooses smallest of (5-bit immediate, u8, u16, u32, u64).
 */
static void enc_typed_uint(struct nsd_encoder *e, uint8_t major, uint64_t v) {
    uint8_t hdr;
    if (v < 24) {
        hdr = (uint8_t)((major << 5) | (uint8_t)v);
        enc_write(e, &hdr, 1);
        return;
    }
    if (v <= 0xff) {
        hdr = (uint8_t)((major << 5) | 24);
        uint8_t out[2] = { hdr, (uint8_t)v };
        enc_write(e, out, 2);
        return;
    }
    if (v <= 0xffff) {
        hdr = (uint8_t)((major << 5) | 25);
        uint8_t out[3] = { hdr, (uint8_t)(v >> 8), (uint8_t)v };
        enc_write(e, out, 3);
        return;
    }
    if (v <= 0xffffffffu) {
        hdr = (uint8_t)((major << 5) | 26);
        uint8_t out[5] = { hdr,
            (uint8_t)(v >> 24), (uint8_t)(v >> 16),
            (uint8_t)(v >> 8),  (uint8_t)v };
        enc_write(e, out, 5);
        return;
    }
    hdr = (uint8_t)((major << 5) | 27);
    uint8_t out[9] = { hdr,
        (uint8_t)(v >> 56), (uint8_t)(v >> 48),
        (uint8_t)(v >> 40), (uint8_t)(v >> 32),
        (uint8_t)(v >> 24), (uint8_t)(v >> 16),
        (uint8_t)(v >> 8),  (uint8_t)v };
    enc_write(e, out, 9);
}

void nsd_enc_map_open(struct nsd_encoder *e, size_t n) {
    enc_typed_uint(e, 5, n);
}

void nsd_enc_kv_uint(struct nsd_encoder *e, uint8_t key, uint64_t v) {
    enc_typed_uint(e, 0, key);
    enc_typed_uint(e, 0, v);
}

void nsd_enc_kv_int(struct nsd_encoder *e, uint8_t key, int64_t v) {
    enc_typed_uint(e, 0, key);
    if (v >= 0) enc_typed_uint(e, 0, (uint64_t)v);
    else        enc_typed_uint(e, 1, (uint64_t)(-(v + 1)));
}

void nsd_enc_kv_bool(struct nsd_encoder *e, uint8_t key, bool v) {
    enc_typed_uint(e, 0, key);
    uint8_t hdr = v ? 0xf5 : 0xf4;
    enc_write(e, &hdr, 1);
}

void nsd_enc_kv_null(struct nsd_encoder *e, uint8_t key) {
    enc_typed_uint(e, 0, key);
    uint8_t hdr = 0xf6;
    enc_write(e, &hdr, 1);
}

void nsd_enc_kv_text(struct nsd_encoder *e, uint8_t key, const char *s, size_t n) {
    enc_typed_uint(e, 0, key);
    enc_typed_uint(e, 3, n);
    enc_write(e, (const uint8_t *)s, n);
}

void nsd_enc_kv_text_z(struct nsd_encoder *e, uint8_t key, const char *cstr) {
    nsd_enc_kv_text(e, key, cstr, cstr ? strlen(cstr) : 0);
}

void nsd_enc_kv_bstr(struct nsd_encoder *e, uint8_t key, const uint8_t *b, size_t n) {
    enc_typed_uint(e, 0, key);
    enc_typed_uint(e, 2, n);
    enc_write(e, b, n);
}

void nsd_enc_kv_arr_open(struct nsd_encoder *e, uint8_t key, size_t n) {
    enc_typed_uint(e, 0, key);
    enc_typed_uint(e, 4, n);
}

void nsd_enc_arr_text_z(struct nsd_encoder *e, const char *cstr) {
    size_t n = cstr ? strlen(cstr) : 0;
    enc_typed_uint(e, 3, n);
    enc_write(e, (const uint8_t *)cstr, n);
}

void nsd_enc_kv_map_open(struct nsd_encoder *e, uint8_t key, size_t n) {
    enc_typed_uint(e, 0, key);
    enc_typed_uint(e, 5, n);
}

size_t nsd_enc_finish(const struct nsd_encoder *e, bool *out_overflow) {
    if (out_overflow) *out_overflow = e->overflow;
    return e->overflow ? 0 : e->pos;
}

/* ── Decoder (libtinycbor wrapper) ───────────────────────── */
/*
 * libtinycbor gives us strict, definite-length-aware parsing for free.
 * Our policy: any non-canonical encoding is rejected (we set
 * CborValidateStrictMode). u8 keys, definite maps, no tags except where
 * we explicitly expect them.
 */

static int tc_to_nsd_err(CborError ce) {
    if (ce == CborNoError) return NSD_OK;
    return NSD_EPROTO;
}

/* The raw decoder state is hidden behind nsd_decoder via internal storage
 * after pos. We use libtinycbor's CborParser/CborValue inline via a small
 * sidecar struct. Rather than expose libtinycbor types in the header, we
 * stash them in a static-thread-local "next-up" structure that mirrors the
 * walk position. This is fine because dispatch handlers are single-threaded
 * per connection and don't recurse. */

/* String scratch — bstr/text values copied here so callers get a stable
 * pointer for the lifetime of the decoder. 4096 covers our largest CBOR
 * field (manifest tier blobs are <2KB). One arena per thread, reset on
 * nsd_dec_init. Bump-allocator: each call carves the next chunk. */
#define NSD_DEC_SCRATCH_BYTES 4096
struct dec_walk {
    CborParser parser;
    CborValue  root;
    CborValue  it;
    bool       reading_value;
    size_t     scratch_used;
    uint8_t    scratch[NSD_DEC_SCRATCH_BYTES];
};

static __thread struct dec_walk g_walk;

int nsd_dec_init(struct nsd_decoder *d, const uint8_t *buf, size_t len) {
    if (!d || !buf || len < 2) return NSD_EPROTO;
    d->buf = buf;
    d->len = len;
    d->pos = 0;
    d->err = NSD_OK;
    d->strict = true;

    d->opcode = buf[0];
    d->body_start = 1;

    CborError ce = cbor_parser_init(buf + 1, len - 1, CborValidateStrictMode,
                                    &g_walk.parser, &g_walk.root);
    if (ce != CborNoError) { d->err = NSD_EPROTO; return NSD_EPROTO; }

    /* Body must be a definite-length map. */
    if (!cbor_value_is_map(&g_walk.root)) { d->err = NSD_EPROTO; return NSD_EPROTO; }
    if (!cbor_value_is_length_known(&g_walk.root)) { d->err = NSD_EPROTO; return NSD_EPROTO; }

    ce = cbor_value_enter_container(&g_walk.root, &g_walk.it);
    if (ce != CborNoError) { d->err = NSD_EPROTO; return NSD_EPROTO; }

    g_walk.reading_value = false;
    g_walk.scratch_used = 0;
    return NSD_OK;
}

int nsd_dec_next_key(struct nsd_decoder *d, uint8_t *out_key) {
    if (d->err != NSD_OK) return d->err;
    if (cbor_value_at_end(&g_walk.it)) return 0;

    if (!cbor_value_is_unsigned_integer(&g_walk.it)) {
        d->err = NSD_EPROTO; return NSD_EPROTO;
    }
    uint64_t k;
    CborError ce = cbor_value_get_uint64(&g_walk.it, &k);
    if (ce != CborNoError) { d->err = NSD_EPROTO; return NSD_EPROTO; }
    if (k > 0xff) { d->err = NSD_EPROTO; return NSD_EPROTO; }
    *out_key = (uint8_t)k;
    ce = cbor_value_advance(&g_walk.it);
    if (ce != CborNoError) { d->err = NSD_EPROTO; return NSD_EPROTO; }
    g_walk.reading_value = true;
    return 1;
}

int nsd_dec_skip(struct nsd_decoder *d) {
    if (!g_walk.reading_value) { d->err = NSD_EPROTO; return NSD_EPROTO; }
    CborError ce = cbor_value_advance(&g_walk.it);
    if (ce != CborNoError) { d->err = NSD_EPROTO; return NSD_EPROTO; }
    g_walk.reading_value = false;
    return NSD_OK;
}

int nsd_dec_uint(struct nsd_decoder *d, uint64_t *out) {
    if (!g_walk.reading_value) { d->err = NSD_EPROTO; return NSD_EPROTO; }
    if (!cbor_value_is_unsigned_integer(&g_walk.it)) {
        d->err = NSD_EPROTO; return NSD_EPROTO;
    }
    CborError ce = cbor_value_get_uint64(&g_walk.it, out);
    if (ce != CborNoError) { d->err = NSD_EPROTO; return NSD_EPROTO; }
    ce = cbor_value_advance(&g_walk.it);
    if (ce != CborNoError) { d->err = NSD_EPROTO; return NSD_EPROTO; }
    g_walk.reading_value = false;
    return tc_to_nsd_err(ce);
}

int nsd_dec_int(struct nsd_decoder *d, int64_t *out) {
    if (!g_walk.reading_value) { d->err = NSD_EPROTO; return NSD_EPROTO; }
    if (!cbor_value_is_integer(&g_walk.it)) {
        d->err = NSD_EPROTO; return NSD_EPROTO;
    }
    CborError ce = cbor_value_get_int64(&g_walk.it, out);
    if (ce != CborNoError) { d->err = NSD_EPROTO; return NSD_EPROTO; }
    ce = cbor_value_advance(&g_walk.it);
    if (ce != CborNoError) { d->err = NSD_EPROTO; return NSD_EPROTO; }
    g_walk.reading_value = false;
    return tc_to_nsd_err(ce);
}

int nsd_dec_bool(struct nsd_decoder *d, bool *out) {
    if (!g_walk.reading_value) { d->err = NSD_EPROTO; return NSD_EPROTO; }
    if (!cbor_value_is_boolean(&g_walk.it)) {
        d->err = NSD_EPROTO; return NSD_EPROTO;
    }
    CborError ce = cbor_value_get_boolean(&g_walk.it, out);
    if (ce != CborNoError) { d->err = NSD_EPROTO; return NSD_EPROTO; }
    ce = cbor_value_advance(&g_walk.it);
    if (ce != CborNoError) { d->err = NSD_EPROTO; return NSD_EPROTO; }
    g_walk.reading_value = false;
    return tc_to_nsd_err(ce);
}

/* Copy via cbor_value_copy_*_string into thread-local scratch. The chunk
 * iteration variants (get_text_string_chunk / get_byte_string_chunk) need
 * iteration state our wrapper doesn't track and return NoMoreStringChunks
 * on first call. The copy variants advance the iterator in-place and
 * accept (buf, *buflen, next) — all documented public API. */
int nsd_dec_text(struct nsd_decoder *d, const char **out_ptr, size_t *out_len) {
    if (!g_walk.reading_value)                        { d->err = NSD_EPROTO; return NSD_EPROTO; }
    if (!cbor_value_is_text_string(&g_walk.it))       { d->err = NSD_EPROTO; return NSD_EPROTO; }
    if (!cbor_value_is_length_known(&g_walk.it))      { d->err = NSD_EPROTO; return NSD_EPROTO; }
    size_t avail = NSD_DEC_SCRATCH_BYTES - g_walk.scratch_used;
    if (avail == 0)                                   { d->err = NSD_EPROTO; return NSD_EPROTO; }
    char *dst = (char *)(g_walk.scratch + g_walk.scratch_used);
    size_t n = avail;
    CborValue next_it;
    CborError ce = cbor_value_copy_text_string(&g_walk.it, dst, &n, &next_it);
    if (ce != CborNoError)                            { d->err = NSD_EPROTO; return NSD_EPROTO; }
    g_walk.scratch_used += n;
    *out_ptr = dst;
    *out_len = n;
    g_walk.it = next_it;
    g_walk.reading_value = false;
    return NSD_OK;
}

int nsd_dec_bstr(struct nsd_decoder *d, const uint8_t **out_ptr, size_t *out_len) {
    if (!g_walk.reading_value)                        { d->err = NSD_EPROTO; return NSD_EPROTO; }
    if (!cbor_value_is_byte_string(&g_walk.it))       { d->err = NSD_EPROTO; return NSD_EPROTO; }
    if (!cbor_value_is_length_known(&g_walk.it))      { d->err = NSD_EPROTO; return NSD_EPROTO; }
    size_t avail = NSD_DEC_SCRATCH_BYTES - g_walk.scratch_used;
    if (avail == 0)                                   { d->err = NSD_EPROTO; return NSD_EPROTO; }
    uint8_t *dst = g_walk.scratch + g_walk.scratch_used;
    size_t n = avail;
    CborValue next_it;
    CborError ce = cbor_value_copy_byte_string(&g_walk.it, dst, &n, &next_it);
    if (ce != CborNoError)                            { d->err = NSD_EPROTO; return NSD_EPROTO; }
    g_walk.scratch_used += n;
    *out_ptr = dst;
    *out_len = n;
    g_walk.it = next_it;
    g_walk.reading_value = false;
    return NSD_OK;
}

int nsd_dec_array_len(struct nsd_decoder *d, size_t *out_len) {
    if (!g_walk.reading_value) { d->err = NSD_EPROTO; return NSD_EPROTO; }
    if (!cbor_value_is_array(&g_walk.it)) {
        d->err = NSD_EPROTO; return NSD_EPROTO;
    }
    if (!cbor_value_is_length_known(&g_walk.it)) {
        d->err = NSD_EPROTO; return NSD_EPROTO;
    }
    CborError ce = cbor_value_get_array_length(&g_walk.it, out_len);
    if (ce != CborNoError) { d->err = NSD_EPROTO; return NSD_EPROTO; }
    /* Skip past the array — caller doesn't iterate (current messages
     * don't carry array values worth descending into). */
    ce = cbor_value_advance(&g_walk.it);
    if (ce != CborNoError) { d->err = NSD_EPROTO; return NSD_EPROTO; }
    g_walk.reading_value = false;
    return tc_to_nsd_err(ce);
}

int nsd_dec_map_len(struct nsd_decoder *d, size_t *out_len) {
    if (!g_walk.reading_value) { d->err = NSD_EPROTO; return NSD_EPROTO; }
    if (!cbor_value_is_map(&g_walk.it)) {
        d->err = NSD_EPROTO; return NSD_EPROTO;
    }
    if (!cbor_value_is_length_known(&g_walk.it)) {
        d->err = NSD_EPROTO; return NSD_EPROTO;
    }
    CborError ce = cbor_value_get_map_length(&g_walk.it, out_len);
    if (ce != CborNoError) { d->err = NSD_EPROTO; return NSD_EPROTO; }
    ce = cbor_value_advance(&g_walk.it);
    if (ce != CborNoError) { d->err = NSD_EPROTO; return NSD_EPROTO; }
    g_walk.reading_value = false;
    return tc_to_nsd_err(ce);
}

void nsd_msg_body_digest(const uint8_t *frame, size_t len, uint8_t out[NSD_SHA256_BYTES]) {
    crypto_hash_sha256_state st;
    crypto_hash_sha256_init(&st);
    if (len > NSD_HMAC_TAG_BYTES) {
        crypto_hash_sha256_update(&st, frame, len - NSD_HMAC_TAG_BYTES);
    }
    crypto_hash_sha256_final(&st, out);
}
