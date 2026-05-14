/*
 * ellul-namespaced — session HMAC.
 *
 * Shared key derivation:
 *   shared_key = SHA256("ellul-namespaced-v1\0" || /etc/machine-id bytes)
 *
 * No new on-disk secret is provisioned; both daemon and bridge derive the
 * key independently. machine-id is per-VPS, persistent, and root-readable
 * (the bridge needs `cat /etc/machine-id`, which is mode 0444).
 *
 * Session HMAC (during handshake):
 *   tag = HMAC-SHA256(shared_key, server_nonce || client_nonce || client_id_hint)
 *
 * Per-message HMAC (after handshake):
 *   input = session_id || request_id_be8 || nonce16 || peer_pidfd_inode_be8
 *                       || cbor_body_digest_sha256
 *   tag   = HMAC-SHA256(shared_key, input) truncated to 16 bytes
 *
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 ellul.ai. All rights reserved.
 */

#ifndef ELLUL_NSD_HMAC_SESSION_H
#define ELLUL_NSD_HMAC_SESSION_H

#include "daemon.h"

/* Derive the shared key from /etc/machine-id. Returns 0 on success, -1 on
 * failure (file missing / unreadable / empty). */
int nsd_hmac_derive_shared_key(uint8_t out_key[NSD_HMAC_KEY_BYTES]);

/* Compute the session-establishment HMAC. */
void nsd_hmac_session(const uint8_t shared_key[NSD_HMAC_KEY_BYTES],
                      const uint8_t server_nonce[NSD_NONCE_BYTES],
                      const uint8_t client_nonce[NSD_NONCE_BYTES],
                      const char   *client_id_hint,
                      size_t        client_id_hint_len,
                      uint8_t       out_tag[NSD_HMAC_TAG_BYTES]);

/* Compute per-message HMAC. */
void nsd_hmac_message(const uint8_t shared_key[NSD_HMAC_KEY_BYTES],
                      const uint8_t session_id[NSD_SESSION_ID_BYTES],
                      uint64_t      request_id,
                      const uint8_t nonce[NSD_NONCE_BYTES],
                      uint64_t      peer_pidfd_inode,
                      const uint8_t body_digest[NSD_SHA256_BYTES],
                      uint8_t       out_tag[NSD_HMAC_TAG_BYTES]);

/* Constant-time compare for tags. Returns true if equal. */
bool nsd_ct_eq(const uint8_t *a, const uint8_t *b, size_t n);

#endif
