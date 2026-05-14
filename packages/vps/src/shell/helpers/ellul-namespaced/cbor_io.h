/*
 * ellul-namespaced — CBOR framing and codec.
 *
 * Wraps libtinycbor with our wire-format conventions:
 *   - u32 big-endian length prefix
 *   - definite-length maps/arrays only
 *   - u8 integer keys
 *   - max frame 64 KiB
 *   - unknown keys → reject (caller decides)
 *
 * The codec exposes a compact API for the message handlers; we don't expose
 * raw tinycbor types in our headers to keep the surface area small.
 *
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 ellul.ai. All rights reserved.
 */

#ifndef ELLUL_NSD_CBOR_IO_H
#define ELLUL_NSD_CBOR_IO_H

#include "daemon.h"

/* ── Reading frames ──────────────────────────────────────── */

/*
 * Read one length-prefixed CBOR frame from fd into out_buf.
 *   - out_buf must point to a buffer of at least NSD_MAX_FRAME_BYTES.
 *   - Returns frame length (>= 1) on success, 0 on clean EOF, -1 on error.
 *   - On error, errno is set; caller closes the socket.
 *   - Reads are non-blocking-friendly: returns -1 with errno=EAGAIN if a
 *     short read would occur. Caller's poll loop retries.
 */
ssize_t nsd_frame_read(int fd, uint8_t *out_buf, size_t buf_len);

/*
 * Like nsd_frame_read but uses recvmsg(2) so the caller can pick up
 * SCM_RIGHTS file descriptors. `out_fds` receives at most `out_fds_cap`
 * file descriptors; `*out_fds_n` is set to the count actually delivered.
 *
 * The kernel sets close-on-exec on all received fds (we always pass
 * MSG_CMSG_CLOEXEC).
 *
 * Caller is responsible for closing out_fds[] on success and on rejection.
 */
ssize_t nsd_frame_recvmsg(int fd, uint8_t *out_buf, size_t buf_len,
                          int *out_fds, size_t out_fds_cap, size_t *out_fds_n);

/* Write a length-prefixed frame. Single writev for atomicity. */
int nsd_frame_write(int fd, const uint8_t *body, size_t body_len);

/* ── Encoder ─────────────────────────────────────────────── */

struct nsd_encoder {
    uint8_t *buf;
    size_t   cap;
    size_t   pos;
    bool     overflow;
};

void nsd_enc_init(struct nsd_encoder *e, uint8_t *buf, size_t cap);

/* Open a definite-length map of `n` u8-keyed entries. */
void nsd_enc_map_open(struct nsd_encoder *e, size_t n);

/* Write a u8-keyed entry of various value types. */
void nsd_enc_kv_uint(struct nsd_encoder *e, uint8_t key, uint64_t v);
void nsd_enc_kv_int(struct nsd_encoder *e, uint8_t key, int64_t v);
void nsd_enc_kv_bool(struct nsd_encoder *e, uint8_t key, bool v);
void nsd_enc_kv_null(struct nsd_encoder *e, uint8_t key);
void nsd_enc_kv_text(struct nsd_encoder *e, uint8_t key, const char *s, size_t n);
void nsd_enc_kv_text_z(struct nsd_encoder *e, uint8_t key, const char *cstr);
void nsd_enc_kv_bstr(struct nsd_encoder *e, uint8_t key, const uint8_t *b, size_t n);

/* Open an array entry; caller writes `n` items via nsd_enc_arr_*. */
void nsd_enc_kv_arr_open(struct nsd_encoder *e, uint8_t key, size_t n);
void nsd_enc_arr_text_z(struct nsd_encoder *e, const char *cstr);

/* Open a nested map entry; caller writes `n` u8-keyed entries. */
void nsd_enc_kv_map_open(struct nsd_encoder *e, uint8_t key, size_t n);

size_t nsd_enc_finish(const struct nsd_encoder *e, bool *out_overflow);

/* ── Decoder ─────────────────────────────────────────────── */

/*
 * The decoder works by walking the input map and matching u8 keys.
 * Unknown keys cause a hard reject — the caller treats this as EPROTO.
 *
 * Lifetime: text/bstr pointers point into the original buffer; valid for
 * the duration of the input buffer's lifetime.
 */

struct nsd_decoder {
    const uint8_t *buf;
    size_t         len;
    size_t         pos;       /* current read position */
    size_t         body_start;/* where the message body (after opcode) begins */
    uint8_t        opcode;
    bool           strict;    /* if true, unknown keys → error */
    int            err;       /* NSD_OK on success, error code on failure */
};

/*
 * Initialize decoder from raw frame. Reads the leading opcode byte, then
 * expects a single CBOR map. Stores opcode in d->opcode.
 */
int nsd_dec_init(struct nsd_decoder *d, const uint8_t *buf, size_t len);

/*
 * Walk the message map. On each iteration, set *out_key to the next u8 key
 * and leave the decoder positioned to read the value. Returns:
 *   1 — another key is available
 *   0 — end of map (clean)
 *  <0 — protocol error
 *
 * After this returns 1, call exactly one nsd_dec_value_* to consume the value.
 */
int nsd_dec_next_key(struct nsd_decoder *d, uint8_t *out_key);

/* Skip a value the handler doesn't recognize — only safe when d->strict==false.
 * In strict mode this signals an error. */
int nsd_dec_skip(struct nsd_decoder *d);

int nsd_dec_uint(struct nsd_decoder *d, uint64_t *out);
int nsd_dec_int(struct nsd_decoder *d, int64_t *out);
int nsd_dec_bool(struct nsd_decoder *d, bool *out);
int nsd_dec_text(struct nsd_decoder *d, const char **out_ptr, size_t *out_len);
int nsd_dec_bstr(struct nsd_decoder *d, const uint8_t **out_ptr, size_t *out_len);
int nsd_dec_array_len(struct nsd_decoder *d, size_t *out_len);
int nsd_dec_map_len(struct nsd_decoder *d, size_t *out_len);

/*
 * Compute SHA-256 over the auth-covered prefix of a frame:
 *   bytes [0 .. len - NSD_HMAC_TAG_BYTES) of the frame body.
 *
 * The frame layout is:
 *   [opcode (1 byte)] [CBOR map] [HMAC trailer (16 bytes)]
 *
 * This digest covers the opcode + CBOR map; the HMAC trailer is excluded
 * (otherwise the HMAC would self-reference). Caller passes len = total
 * frame body length (frame_len from nsd_frame_read).
 */
void nsd_msg_body_digest(const uint8_t *frame, size_t len, uint8_t out[NSD_SHA256_BYTES]);

#endif
