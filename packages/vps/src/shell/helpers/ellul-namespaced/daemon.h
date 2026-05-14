/*
 * ellul-namespaced — common definitions.
 *
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 ellul.ai. All rights reserved.
 */

#ifndef ELLUL_NSD_DAEMON_H
#define ELLUL_NSD_DAEMON_H

#define _GNU_SOURCE

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>

/* ── Compile-time constants ──────────────────────────────── */

#define NSD_PROTOCOL_VERSION   1u
#define NSD_MANIFEST_VERSION   1u

#define NSD_RUN_DIR            "/run/ellul-ns"
#define NSD_ADMIN_SOCK         NSD_RUN_DIR "/admin.sock"
#define NSD_FEATURE_FLAG       "/etc/ellul/feature-flags/nsd-enabled"
#define NSD_HMAC_KEY_INPUT     "/etc/machine-id"
#define NSD_MANIFEST_PUB_PATH       "/etc/ellul/manifests/manifest.pub"
#define NSD_MANIFEST_PUB_NEXT_PATH  "/etc/ellul/manifests/manifest-next.pub"
#define NSD_MANIFEST_DIR             "/opt/ellul/manifests"
#define NSD_BILLING_TIER_PATH  "/etc/ellul/billing-tier"
#define NSD_DEFAULT_DEFAULTS   "/etc/default/ellul"
#define NSD_PHASE_LOG          "/var/log/ellul/nsd-phase.log"
#define NSD_EVENT_LOG          "/var/log/ellul/nsd-events.jsonl"

#define NSD_MAX_FRAME_BYTES    (64 * 1024)
#define NSD_MAX_CONNECTIONS    256
#define NSD_MAX_PROJECTS       512
#define NSD_HMAC_TAG_BYTES     16
#define NSD_NONCE_BYTES        16
#define NSD_SESSION_ID_BYTES   16
#define NSD_PUBKEY_BYTES       32
#define NSD_FINGERPRINT_BYTES  32
#define NSD_HMAC_KEY_BYTES     32
#define NSD_SHA256_BYTES       32
#define NSD_ED25519_SIG_BYTES  64

/* Project slug regex: ^sbx-[a-z0-9]{7}$ — fixed 11 chars. */
#define NSD_PROJECT_SLUG_LEN   11

/* Watchdog cadence: notify every 5s; systemd kills at 15s. */
#define NSD_WATCHDOG_INTERVAL_MS  5000
#define NSD_ACCEPT_POLL_TIMEOUT_MS 1000

/* Bridge cgroup suffix — last component of the v2 cgroup path. */
#define NSD_BRIDGE_CGROUP_SUFFIX  "/ellul-agent-bridge.service"
/* Anchor cgroup prefix — namespaces.slice transient unit pattern. */
#define NSD_ANCHOR_CGROUP_PREFIX  "/ellul-namespaces.slice/ellul-ns-"

/* EX_CONFIG: kernel-too-old or other config-fatal startup failure. */
#define NSD_EX_CONFIG  78

/* ── Message opcodes ─────────────────────────────────────── */

enum nsd_opcode {
    NSD_OP_HELLO              = 0x01,
    NSD_OP_CLIENT_HELLO       = 0x02,
    NSD_OP_HEALTH             = 0x10,
    NSD_OP_HEALTH_RESPONSE    = 0x11,
    NSD_OP_ATTEST             = 0x20,
    NSD_OP_ATTEST_RESPONSE    = 0x21,
    NSD_OP_SETUP              = 0x30,
    NSD_OP_SETUP_RESPONSE     = 0x31,
    NSD_OP_ENTER              = 0x40,
    NSD_OP_ENTER_RESPONSE     = 0x41,
    NSD_OP_SPAWN              = 0x42,  /* deferred */
    NSD_OP_INJECT_ENV         = 0x43,
    NSD_OP_INJECT_ENV_RESPONSE = 0x44,
    NSD_OP_EXIT_NOTIFY        = 0x45,  /* server-initiated after ENTER */
    NSD_OP_TEARDOWN           = 0x50,
    NSD_OP_TEARDOWN_RESPONSE  = 0x51,
    NSD_OP_BYOK_WRAP          = 0x60,
    NSD_OP_BYOK_WRAP_RESP     = 0x61,
    NSD_OP_BYOK_UNWRAP        = 0x62,
    NSD_OP_BYOK_UNWRAP_RESP   = 0x63,
    NSD_OP_CREATE_PROJECT     = 0x80,
    NSD_OP_CREATE_PROJECT_RESP = 0x84,
    NSD_OP_DROP_PROJECT       = 0x81,
    NSD_OP_DROP_PROJECT_RESP  = 0x85,
    NSD_OP_EXPORT_MANIFEST    = 0x82,
    NSD_OP_RECONCILE          = 0x83,
};

/* ── Error codes (matches §9 of protocol doc) ────────────── */

enum nsd_errcode {
    NSD_OK                    = 0,
    NSD_EPROTO                = 1,
    NSD_EAUTH                 = 2,
    NSD_EREPLAY               = 3,
    NSD_EMANIFEST_SIG         = 4,
    NSD_EMANIFEST_EXPIRED     = 5,
    NSD_EMANIFEST_PROJECT     = 6,
    NSD_EATTEST_MISMATCH      = 7,
    NSD_EANCHOR_DEAD          = 8,
    NSD_EANCHOR_CGROUP        = 9,
    NSD_EWAVE_READONLY        = 10,
    NSD_EFD_KIND              = 11,
    NSD_ESTAGE_FAILED         = 12,
    NSD_EBUSY                 = 13,
    NSD_EINTERNAL             = 14,
};

/* ── Per-connection session state ────────────────────────── */

struct nsd_session {
    /* Set at accept-time; do not mutate after auth. */
    pid_t   peer_pid;
    uid_t   peer_uid;
    gid_t   peer_gid;
    int     peer_pidfd;          /* SO_PEERPIDFD; -1 if not yet acquired */
    uint64_t peer_pidfd_inode;   /* fstat(peer_pidfd).st_ino — bound into HMAC */

    /* Project identity. NULL on admin socket; non-NULL on per-project socket. */
    const char *project;          /* points into projects array; not freed */

    /* Handshake state. */
    bool    auth_passed;
    bool    hello_sent;
    bool    client_hello_received;

    /* Cryptographic state. */
    uint8_t server_nonce[NSD_NONCE_BYTES];
    uint8_t client_nonce[NSD_NONCE_BYTES];
    uint8_t session_id[NSD_SESSION_ID_BYTES];

    /* Replay defence. */
    uint64_t last_request_id;

    /* Connection book-keeping. */
    int     fd;
    int     close_after_response;
};

/* ── Per-project state ───────────────────────────────────── */

struct nsd_project {
    char     slug[NSD_PROJECT_SLUG_LEN + 1];
    int      listen_fd;          /* listening socket fd; -1 when project is dropped */
    /* Path of the /run/.ns-<slug>/anchor.pid file is derived; not stored. */
};

/* ── Daemon state (singleton) ────────────────────────────── */

struct nsd_state;  /* opaque; defined in main.c */

/* Accessors used by other modules. */
const uint8_t *nsd_state_hmac_key(const struct nsd_state *st);
const uint8_t *nsd_state_manifest_pubkey(const struct nsd_state *st);
const uint8_t *nsd_state_manifest_pubkey_fp(const struct nsd_state *st);
struct nsd_manifest;
const struct nsd_manifest *nsd_state_manifest(const struct nsd_state *st);
const char *nsd_state_svc_user(const struct nsd_state *st);
uid_t nsd_state_svc_uid(const struct nsd_state *st);

#endif  /* ELLUL_NSD_DAEMON_H */
