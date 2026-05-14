/*
 * ellul-namespaced — session HMAC implementation.
 *
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 ellul.ai. All rights reserved.
 */

#define _GNU_SOURCE

#include "hmac_session.h"

#include <fcntl.h>
#include <string.h>
#include <unistd.h>
#include <sodium.h>

static const char NSD_HMAC_LABEL[] = "ellul-namespaced-v1";

int nsd_hmac_derive_shared_key(uint8_t out_key[NSD_HMAC_KEY_BYTES]) {
    int fd = open(NSD_HMAC_KEY_INPUT, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return -1;
    char buf[64];
    ssize_t n = 0, r;
    while (n < (ssize_t)sizeof(buf)) {
        r = read(fd, buf + n, sizeof(buf) - (size_t)n);
        if (r < 0) { close(fd); return -1; }
        if (r == 0) break;
        n += r;
    }
    close(fd);
    /* Strip trailing whitespace. machine-id is canonically 32 hex + newline. */
    while (n > 0 && (buf[n-1] == '\n' || buf[n-1] == '\r' || buf[n-1] == ' ')) n--;
    if (n < 8) return -1;

    /* SHA-256 of label NUL byte machine-id-bytes. */
    crypto_hash_sha256_state st;
    crypto_hash_sha256_init(&st);
    crypto_hash_sha256_update(&st, (const unsigned char *)NSD_HMAC_LABEL,
                              sizeof(NSD_HMAC_LABEL));  /* includes the trailing NUL */
    crypto_hash_sha256_update(&st, (const unsigned char *)buf, (size_t)n);
    crypto_hash_sha256_final(&st, out_key);
    sodium_memzero(buf, sizeof(buf));
    return 0;
}

static void be64(uint64_t v, uint8_t out[8]) {
    out[0] = (uint8_t)(v >> 56);
    out[1] = (uint8_t)(v >> 48);
    out[2] = (uint8_t)(v >> 40);
    out[3] = (uint8_t)(v >> 32);
    out[4] = (uint8_t)(v >> 24);
    out[5] = (uint8_t)(v >> 16);
    out[6] = (uint8_t)(v >> 8);
    out[7] = (uint8_t)v;
}

void nsd_hmac_session(const uint8_t shared_key[NSD_HMAC_KEY_BYTES],
                      const uint8_t server_nonce[NSD_NONCE_BYTES],
                      const uint8_t client_nonce[NSD_NONCE_BYTES],
                      const char   *client_id_hint,
                      size_t        client_id_hint_len,
                      uint8_t       out_tag[NSD_HMAC_TAG_BYTES]) {
    crypto_auth_hmacsha256_state st;
    crypto_auth_hmacsha256_init(&st, shared_key, NSD_HMAC_KEY_BYTES);
    crypto_auth_hmacsha256_update(&st, server_nonce, NSD_NONCE_BYTES);
    crypto_auth_hmacsha256_update(&st, client_nonce, NSD_NONCE_BYTES);
    if (client_id_hint && client_id_hint_len > 0) {
        crypto_auth_hmacsha256_update(&st,
            (const unsigned char *)client_id_hint, client_id_hint_len);
    }
    uint8_t full[crypto_auth_hmacsha256_BYTES];
    crypto_auth_hmacsha256_final(&st, full);
    memcpy(out_tag, full, NSD_HMAC_TAG_BYTES);
    sodium_memzero(full, sizeof(full));
}

void nsd_hmac_message(const uint8_t shared_key[NSD_HMAC_KEY_BYTES],
                      const uint8_t session_id[NSD_SESSION_ID_BYTES],
                      uint64_t      request_id,
                      const uint8_t nonce[NSD_NONCE_BYTES],
                      uint64_t      peer_pidfd_inode,
                      const uint8_t body_digest[NSD_SHA256_BYTES],
                      uint8_t       out_tag[NSD_HMAC_TAG_BYTES]) {
    uint8_t rid[8], inode[8];
    be64(request_id, rid);
    be64(peer_pidfd_inode, inode);

    crypto_auth_hmacsha256_state st;
    crypto_auth_hmacsha256_init(&st, shared_key, NSD_HMAC_KEY_BYTES);
    crypto_auth_hmacsha256_update(&st, session_id, NSD_SESSION_ID_BYTES);
    crypto_auth_hmacsha256_update(&st, rid, 8);
    crypto_auth_hmacsha256_update(&st, nonce, NSD_NONCE_BYTES);
    crypto_auth_hmacsha256_update(&st, inode, 8);
    crypto_auth_hmacsha256_update(&st, body_digest, NSD_SHA256_BYTES);
    uint8_t full[crypto_auth_hmacsha256_BYTES];
    crypto_auth_hmacsha256_final(&st, full);
    memcpy(out_tag, full, NSD_HMAC_TAG_BYTES);
    sodium_memzero(full, sizeof(full));
}

bool nsd_ct_eq(const uint8_t *a, const uint8_t *b, size_t n) {
    return sodium_memcmp(a, b, n) == 0;
}
