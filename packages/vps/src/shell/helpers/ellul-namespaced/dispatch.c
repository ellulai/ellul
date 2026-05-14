/*
 * ellul-namespaced — message dispatch.
 *
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 ellul.ai. All rights reserved.
 */

#define _GNU_SOURCE

#include "dispatch.h"
#include "auth.h"
#include "attest.h"
#include "byok.h"
#include "cbor_io.h"
#include "enter.h"
#include "hmac_session.h"
#include "log.h"
#include "manifest.h"
#include "ops.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/random.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef F_ADD_SEALS
#define F_ADD_SEALS  1033
#define F_GET_SEALS  1034
#define F_SEAL_SHRINK 0x0002
#define F_SEAL_GROW   0x0004
#define F_SEAL_WRITE  0x0008
#endif

#ifndef MFD_CLOEXEC
#define MFD_CLOEXEC  0x0001
#define MFD_ALLOW_SEALING 0x0002
#endif

#ifndef __NR_memfd_create
#define __NR_memfd_create 319
#endif

/* Forward-declared accessors implemented in main.c. */
extern const uint8_t *nsd_state_hmac_key(const struct nsd_state *st);
extern const uint8_t *nsd_state_manifest_pubkey_fp(const struct nsd_state *st);
extern const struct nsd_manifest *nsd_state_manifest(const struct nsd_state *st);
extern const char *nsd_state_svc_user(const struct nsd_state *st);
extern uid_t        nsd_state_svc_uid(const struct nsd_state *st);
extern long         nsd_state_uptime_ms(const struct nsd_state *st);
extern const struct nsd_byok_state *nsd_state_byok(const struct nsd_state *st);

/* ── Helpers ─────────────────────────────────────────────── */

/*
 * Send an error response. opcode is the response opcode for the original
 * request opcode (response = req+1 for our active ops, or 0xff for catch-all).
 */
static void send_error(int fd, uint8_t resp_op, uint64_t request_id,
                       enum nsd_errcode code, const char *msg) {
    uint8_t buf[256];
    buf[0] = resp_op;
    struct nsd_encoder enc;
    nsd_enc_init(&enc, buf + 1, sizeof(buf) - 1);
    nsd_enc_map_open(&enc, 3);
    nsd_enc_kv_uint(&enc, 1, request_id);
    nsd_enc_kv_uint(&enc, 14, (uint64_t)code);
    nsd_enc_kv_text_z(&enc, 15, msg ? msg : "");
    bool of;
    size_t n = nsd_enc_finish(&enc, &of);
    if (of) return;
    (void) nsd_frame_write(fd, buf, n + 1);
}

static void fill_random(uint8_t *out, size_t n) {
    /* getrandom is the right API; falls back to /dev/urandom if unavailable. */
    ssize_t r = getrandom(out, n, 0);
    if (r != (ssize_t)n) {
        for (size_t i = 0; i < n; i++) out[i] = (uint8_t)(rand() & 0xff);
    }
}

/* ── Handshake ───────────────────────────────────────────── */

static int send_hello(int fd, struct nsd_session *ses,
                      const uint8_t *manifest_fp) {
    fill_random(ses->server_nonce, NSD_NONCE_BYTES);
    fill_random(ses->session_id, NSD_SESSION_ID_BYTES);

    uint8_t buf[256];
    buf[0] = NSD_OP_HELLO;
    struct nsd_encoder enc;
    nsd_enc_init(&enc, buf + 1, sizeof(buf) - 1);
    nsd_enc_map_open(&enc, 6);
    nsd_enc_kv_uint(&enc, 1, NSD_PROTOCOL_VERSION);
    nsd_enc_kv_bstr(&enc, 2, ses->server_nonce, NSD_NONCE_BYTES);
    nsd_enc_kv_bstr(&enc, 3, manifest_fp, NSD_FINGERPRINT_BYTES);
    nsd_enc_kv_bstr(&enc, 4, ses->session_id, NSD_SESSION_ID_BYTES);
    /* features: bit0 = wave-0 (read-only attest), bit1 = wave-1 (writes). */
    nsd_enc_kv_uint(&enc, 5, 0x1);
    /* peer_pidfd_inode: the bridge can't observe its own SO_PEERPIDFD inode
     * from its side of the socket (only the daemon sees it). Daemon echoes
     * the value so both ends bind per-message HMAC to the same inode; if a
     * different process ever reconnects it gets a different pidfd object
     * and the daemon-side fstat returns a different inode, breaking replay. */
    nsd_enc_kv_uint(&enc, 6, ses->peer_pidfd_inode);

    bool of;
    size_t n = nsd_enc_finish(&enc, &of);
    if (of) return -1;
    if (nsd_frame_write(fd, buf, n + 1) != 0) return -1;
    ses->hello_sent = true;
    return 0;
}

static int recv_client_hello(int fd, struct nsd_session *ses,
                             const uint8_t *shared_key,
                             const uint8_t *manifest_fp) {
    uint8_t buf[NSD_MAX_FRAME_BYTES];
    ssize_t n = nsd_frame_read(fd, buf, sizeof(buf));
    if (n <= 0) { nsd_event("nsd.client_hello.fail", "step", nsd_jstr("frame-read"), "n", nsd_jnum((long long)n), "errno", nsd_jnum((long long)errno), NULL); return -1; }

    struct nsd_decoder d;
    if (nsd_dec_init(&d, buf, (size_t)n) != NSD_OK) { nsd_event("nsd.client_hello.fail", "step", nsd_jstr("dec-init"), "n", nsd_jnum((long long)n), "first_byte", nsd_jnum((long long)buf[0]), NULL); return -1; }
    if (d.opcode != NSD_OP_CLIENT_HELLO) { nsd_event("nsd.client_hello.fail", "step", nsd_jstr("opcode"), "got", nsd_jnum((long long)d.opcode), "expected", nsd_jnum((long long)NSD_OP_CLIENT_HELLO), NULL); return -1; }

    uint64_t pv = 0;
    const uint8_t *cnonce = NULL;
    size_t cnonce_len = 0;
    const char *cid_hint = NULL;
    size_t cid_len = 0;
    const uint8_t *fp = NULL;
    size_t fp_len = 0;
    const uint8_t *hmac = NULL;
    size_t hmac_len = 0;

    uint8_t key;
    int rc;
    while ((rc = nsd_dec_next_key(&d, &key)) > 0) {
        switch (key) {
        case 1: if (nsd_dec_uint(&d, &pv) != NSD_OK) { nsd_event("nsd.client_hello.fail", "step", nsd_jstr("dec-pv"), NULL); return -1; } break;
        case 2: if (nsd_dec_bstr(&d, &cnonce, &cnonce_len) != NSD_OK) { nsd_event("nsd.client_hello.fail", "step", nsd_jstr("dec-cnonce"), NULL); return -1; } break;
        case 3: if (nsd_dec_text(&d, &cid_hint, &cid_len) != NSD_OK) { nsd_event("nsd.client_hello.fail", "step", nsd_jstr("dec-cid"), NULL); return -1; } break;
        case 4: if (nsd_dec_bstr(&d, &fp, &fp_len) != NSD_OK) { nsd_event("nsd.client_hello.fail", "step", nsd_jstr("dec-fp"), NULL); return -1; } break;
        case 5: if (nsd_dec_bstr(&d, &hmac, &hmac_len) != NSD_OK) { nsd_event("nsd.client_hello.fail", "step", nsd_jstr("dec-hmac"), NULL); return -1; } break;
        default: { nsd_event("nsd.client_hello.fail", "step", nsd_jstr("unknown-key"), "key", nsd_jnum((long long)key), NULL); return -1; }
        }
    }
    if (rc < 0) { nsd_event("nsd.client_hello.fail", "step", nsd_jstr("dec-loop"), "rc", nsd_jnum((long long)rc), NULL); return -1; }
    if (pv != NSD_PROTOCOL_VERSION) { nsd_event("nsd.client_hello.fail", "step", nsd_jstr("pv"), "got", nsd_jnum((long long)pv), NULL); return -1; }
    if (cnonce_len != NSD_NONCE_BYTES) { nsd_event("nsd.client_hello.fail", "step", nsd_jstr("cnonce-len"), "got", nsd_jnum((long long)cnonce_len), NULL); return -1; }
    if (fp_len != NSD_FINGERPRINT_BYTES) { nsd_event("nsd.client_hello.fail", "step", nsd_jstr("fp-len"), "got", nsd_jnum((long long)fp_len), NULL); return -1; }
    if (hmac_len != NSD_HMAC_TAG_BYTES) { nsd_event("nsd.client_hello.fail", "step", nsd_jstr("hmac-len"), "got", nsd_jnum((long long)hmac_len), NULL); return -1; }
    if (cid_len > 64) { nsd_event("nsd.client_hello.fail", "step", nsd_jstr("cid-len"), "got", nsd_jnum((long long)cid_len), NULL); return -1; }
    if (!nsd_ct_eq(fp, manifest_fp, NSD_FINGERPRINT_BYTES)) { nsd_event("nsd.client_hello.fail", "step", nsd_jstr("fp-mismatch"), NULL); return -1; }

    uint8_t expected[NSD_HMAC_TAG_BYTES];
    nsd_hmac_session(shared_key, ses->server_nonce, cnonce, cid_hint,
                     cid_len, expected);
    if (!nsd_ct_eq(hmac, expected, NSD_HMAC_TAG_BYTES)) { nsd_event("nsd.client_hello.fail", "step", nsd_jstr("hmac-mismatch"), "cid_len", nsd_jnum((long long)cid_len), NULL); return -1; }

    memcpy(ses->client_nonce, cnonce, NSD_NONCE_BYTES);
    ses->client_hello_received = true;
    return 0;
}

/* ── Per-message HMAC verify ─────────────────────────────── */

/*
 * Frame layout for requests:
 *   [opcode (1 byte)] [CBOR map (variable)] [HMAC trailer (16 bytes)]
 *
 * The trailing 16 bytes are HMAC-SHA256(shared_key, session_id ||
 * request_id_be8 || nonce || peer_pidfd_inode_be8 || body_digest)
 * truncated to 16 bytes, where body_digest = SHA256(frame[0 .. flen-16]).
 *
 * This layout puts the HMAC outside the CBOR body to avoid the circular
 * "HMAC depends on body that includes HMAC" trap.
 */
static int verify_msg_hmac(struct nsd_session *ses, const uint8_t *frame,
                           size_t flen, uint64_t request_id,
                           const uint8_t *nonce,
                           const uint8_t *shared_key) {
    if (flen < 1 + NSD_HMAC_TAG_BYTES) return NSD_EPROTO;
    if (request_id <= ses->last_request_id) return NSD_EREPLAY;
    const uint8_t *hmac = frame + flen - NSD_HMAC_TAG_BYTES;
    uint8_t body_digest[NSD_SHA256_BYTES];
    nsd_msg_body_digest(frame, flen, body_digest);
    uint8_t expected[NSD_HMAC_TAG_BYTES];
    nsd_hmac_message(shared_key, ses->session_id, request_id, nonce,
                     ses->peer_pidfd_inode, body_digest, expected);
    if (!nsd_ct_eq(expected, hmac, NSD_HMAC_TAG_BYTES)) return NSD_EAUTH;
    ses->last_request_id = request_id;
    return NSD_OK;
}

/* ── Message handlers ────────────────────────────────────── */

static void handle_health(int fd, struct nsd_session *ses,
                          uint64_t request_id, struct nsd_state *st) {
    (void) ses;
    uint8_t buf[256];
    buf[0] = NSD_OP_HEALTH_RESPONSE;
    struct nsd_encoder enc;
    nsd_enc_init(&enc, buf + 1, sizeof(buf) - 1);
    nsd_enc_map_open(&enc, 5);
    nsd_enc_kv_uint(&enc, 1, request_id);
    nsd_enc_kv_bool(&enc, 2, true);
    nsd_enc_kv_uint(&enc, 3, (uint64_t)nsd_state_uptime_ms(st));
    nsd_enc_kv_bstr(&enc, 4, nsd_state_manifest_pubkey_fp(st), NSD_FINGERPRINT_BYTES);
    /* features bit0 — read-only ATTEST is always supported. */
    nsd_enc_kv_uint(&enc, 5, 0x1);
    bool of;
    size_t n = nsd_enc_finish(&enc, &of);
    if (of) return;
    (void) nsd_frame_write(fd, buf, n + 1);
}

static void handle_attest(int fd, struct nsd_session *ses,
                          uint64_t request_id, struct nsd_state *st) {
    if (!ses->project) {
        send_error(fd, NSD_OP_ATTEST_RESPONSE, request_id, NSD_EPROTO,
                   "attest on admin socket");
        return;
    }
    const struct nsd_manifest *m = nsd_state_manifest(st);
    if (!m) {
        send_error(fd, NSD_OP_ATTEST_RESPONSE, request_id, NSD_EMANIFEST_SIG,
                   "no manifest loaded");
        return;
    }
    /* Verify socket project matches manifest's slug regex. regexec takes
     * a const regex_t* per POSIX; no const-cast needed. */
    if (m->has_project_slug_rx &&
        regexec(&m->project_slug_rx, ses->project, 0, NULL, 0) != 0) {
        send_error(fd, NSD_OP_ATTEST_RESPONSE, request_id, NSD_EMANIFEST_PROJECT,
                   "project does not match manifest slug regex");
        return;
    }

    char home[64];
    snprintf(home, sizeof(home), "/home/%s", nsd_state_svc_user(st));

    struct nsd_attest_result res;
    int rc = nsd_attest_run(m, ses->project, home, &res);

    /* Build response. */
    uint8_t buf[NSD_MAX_FRAME_BYTES];
    buf[0] = NSD_OP_ATTEST_RESPONSE;
    struct nsd_encoder enc;
    nsd_enc_init(&enc, buf + 1, sizeof(buf) - 1);

    if (rc != 0) {
        nsd_enc_map_open(&enc, 4);
        nsd_enc_kv_uint(&enc, 1, request_id);
        nsd_enc_kv_bool(&enc, 2, false);
        nsd_enc_kv_bool(&enc, 5, res.anchor_alive);
        nsd_enc_kv_uint(&enc, 14, (uint64_t)res.errcode);
        bool of;
        size_t n = nsd_enc_finish(&enc, &of);
        if (!of) (void) nsd_frame_write(fd, buf, n + 1);
        return;
    }

    nsd_enc_map_open(&enc, 5);
    nsd_enc_kv_uint(&enc, 1, request_id);
    nsd_enc_kv_bool(&enc, 2, res.matches);
    nsd_enc_kv_arr_open(&enc, 3, res.n_mismatches);
    for (size_t i = 0; i < res.n_mismatches; i++) {
        nsd_enc_arr_text_z(&enc, res.mismatches[i]);
    }
    nsd_enc_kv_bstr(&enc, 4, res.mountinfo_digest, NSD_SHA256_BYTES);
    nsd_enc_kv_bool(&enc, 5, res.anchor_alive);

    bool of;
    size_t n = nsd_enc_finish(&enc, &of);
    if (!of) (void) nsd_frame_write(fd, buf, n + 1);
}

/* Wave-2+ messages: log + reject (kept for ENTER/SPAWN/INJECT_ENV). */
static void reject_unsupported(int fd, uint8_t resp_opcode, uint64_t request_id,
                               const char *opcode_name, const char *project) {
    nsd_event("nsd.wave-not-implemented",
              "opcode", nsd_jstr(opcode_name),
              "project", project ? nsd_jstr(project) : nsd_jstr("admin"),
              "request_id", nsd_jnum((long long)request_id),
              NULL);
    send_error(fd, resp_opcode, request_id, NSD_EWAVE_READONLY,
               "operation not implemented yet");
}

/* ── SETUP / TEARDOWN handlers ───────────────────────────── */

/*
 * Helper for SETUP/TEARDOWN: each takes a connection-state walked CBOR
 * decoder positioned at the body. We pre-extract request_id + nonce
 * before reaching the handler (in the main loop), so handlers below
 * receive only the per-opcode keys to parse.
 */

static void handle_setup(int fd, struct nsd_session *ses, uint64_t request_id,
                         struct nsd_decoder *d, struct nsd_state *st) {
    if (ses->project) {
        send_error(fd, NSD_OP_SETUP_RESPONSE, request_id, NSD_EPROTO,
                   "setup requires admin socket");
        return;
    }
    struct nsd_setup_request req;
    memset(&req, 0, sizeof(req));
    char project[NSD_PROJECT_SLUG_LEN + 1] = {0};

    /* Walk per-opcode keys: 3=project_slug, 4=shared_projects, 5=shared_previews,
     * 6=shared_ports. (Keys 1 and 2 already consumed by the dispatch loop's
     * pre-walk.) */
    uint8_t k;
    int rc;
    while ((rc = nsd_dec_next_key(d, &k)) > 0) {
        const char *txt; size_t tl;
        switch (k) {
        case 3:
            if (nsd_dec_text(d, &txt, &tl) != NSD_OK ||
                tl != NSD_PROJECT_SLUG_LEN) {
                send_error(fd, NSD_OP_SETUP_RESPONSE, request_id, NSD_EPROTO,
                           "project slug parse");
                return;
            }
            memcpy(project, txt, tl);
            break;
        case 4:
            if (nsd_dec_text(d, &txt, &tl) != NSD_OK ||
                tl >= sizeof(req.shared_projects)) {
                send_error(fd, NSD_OP_SETUP_RESPONSE, request_id, NSD_EPROTO,
                           "shared_projects parse");
                return;
            }
            memcpy(req.shared_projects, txt, tl);
            req.shared_projects[tl] = 0;
            break;
        case 5:
            if (nsd_dec_text(d, &txt, &tl) != NSD_OK ||
                tl >= sizeof(req.shared_previews)) {
                send_error(fd, NSD_OP_SETUP_RESPONSE, request_id, NSD_EPROTO,
                           "shared_previews parse");
                return;
            }
            memcpy(req.shared_previews, txt, tl);
            req.shared_previews[tl] = 0;
            break;
        case 6:
            if (nsd_dec_text(d, &txt, &tl) != NSD_OK ||
                tl >= sizeof(req.shared_ports)) {
                send_error(fd, NSD_OP_SETUP_RESPONSE, request_id, NSD_EPROTO,
                           "shared_ports parse");
                return;
            }
            memcpy(req.shared_ports, txt, tl);
            req.shared_ports[tl] = 0;
            break;
        default:
            send_error(fd, NSD_OP_SETUP_RESPONSE, request_id, NSD_EPROTO,
                       "unknown setup key");
            return;
        }
    }
    if (rc < 0 || project[0] == 0) {
        send_error(fd, NSD_OP_SETUP_RESPONSE, request_id, NSD_EPROTO,
                   "setup body parse");
        return;
    }

    struct nsd_setup_result res;
    int srv = nsd_ops_setup(project, &req, &res);

    /* Build response. */
    uint8_t buf[NSD_MAX_FRAME_BYTES];
    buf[0] = NSD_OP_SETUP_RESPONSE;
    struct nsd_encoder enc;
    nsd_enc_init(&enc, buf + 1, sizeof(buf) - 1);

    if (srv != 0) {
        nsd_enc_map_open(&enc, 3);
        nsd_enc_kv_uint(&enc, 1, request_id);
        nsd_enc_kv_bool(&enc, 2, false);
        nsd_enc_kv_uint(&enc, 14, (uint64_t)res.errcode);
        bool of; size_t n = nsd_enc_finish(&enc, &of);
        if (!of) (void) nsd_frame_write(fd, buf, n + 1);

        /* On a successful setup, register the per-project socket so subsequent
         * connections from the bridge don't have to wait for a daemon restart. */
        return;
    }

    if (res.success) {
        /* Best-effort: ensure the per-project socket is registered so
         * subsequent ATTEST calls can route through. */
        (void) nsd_ops_create_project(st, project);
    }

    nsd_enc_map_open(&enc, res.success ? 5 : 4);
    nsd_enc_kv_uint(&enc, 1, request_id);
    nsd_enc_kv_bool(&enc, 2, res.success);
    if (res.success) {
        nsd_enc_kv_uint(&enc, 3, (uint64_t)res.anchor_pid);
        nsd_enc_kv_text_z(&enc, 4, res.unit_name);
    }
    nsd_enc_kv_uint(&enc, 14, (uint64_t)res.errcode);
    bool of;
    size_t n = nsd_enc_finish(&enc, &of);
    if (!of) (void) nsd_frame_write(fd, buf, n + 1);
}

static void handle_teardown(int fd, struct nsd_session *ses, uint64_t request_id,
                            struct nsd_decoder *d, struct nsd_state *st) {
    if (ses->project) {
        send_error(fd, NSD_OP_TEARDOWN_RESPONSE, request_id, NSD_EPROTO,
                   "teardown requires admin socket");
        return;
    }
    /* Body keys: 3=project_slug. */
    char project[NSD_PROJECT_SLUG_LEN + 1] = {0};
    uint8_t k;
    int rc;
    while ((rc = nsd_dec_next_key(d, &k)) > 0) {
        const char *txt; size_t tl;
        if (k == 3) {
            if (nsd_dec_text(d, &txt, &tl) != NSD_OK || tl != NSD_PROJECT_SLUG_LEN) {
                send_error(fd, NSD_OP_TEARDOWN_RESPONSE, request_id, NSD_EPROTO,
                           "bad slug");
                return;
            }
            memcpy(project, txt, tl);
        } else {
            send_error(fd, NSD_OP_TEARDOWN_RESPONSE, request_id, NSD_EPROTO,
                       "unknown teardown key");
            return;
        }
    }
    if (rc < 0 || project[0] == 0) {
        send_error(fd, NSD_OP_TEARDOWN_RESPONSE, request_id, NSD_EPROTO,
                   "missing project");
        return;
    }

    struct nsd_teardown_result res;
    int srv = nsd_ops_teardown(project, &res);

    /* Drop the per-project socket on success. */
    if (srv == 0 && res.success) {
        (void) nsd_ops_drop_project(st, project);
    }

    uint8_t buf[256];
    buf[0] = NSD_OP_TEARDOWN_RESPONSE;
    struct nsd_encoder enc;
    nsd_enc_init(&enc, buf + 1, sizeof(buf) - 1);
    nsd_enc_map_open(&enc, 3);
    nsd_enc_kv_uint(&enc, 1, request_id);
    nsd_enc_kv_bool(&enc, 2, srv == 0 && res.success);
    nsd_enc_kv_uint(&enc, 14, (uint64_t)(srv == 0 ? res.errcode : NSD_EINTERNAL));
    bool of; size_t n = nsd_enc_finish(&enc, &of);
    if (!of) (void) nsd_frame_write(fd, buf, n + 1);
}

/* Admin socket handlers: CREATE_PROJECT, DROP_PROJECT, EXPORT_MANIFEST_PUB. */

static void handle_create_project(int fd, struct nsd_session *ses, uint64_t request_id,
                                   struct nsd_decoder *d, struct nsd_state *st) {
    if (ses->project) {
        send_error(fd, NSD_OP_CREATE_PROJECT_RESP, request_id, NSD_EPROTO,
                   "create_project requires admin socket");
        return;
    }
    /* Body keys: 3=project_slug. */
    char slug[NSD_PROJECT_SLUG_LEN + 1] = {0};
    uint8_t k;
    int rc;
    while ((rc = nsd_dec_next_key(d, &k)) > 0) {
        const char *txt; size_t tl;
        if (k == 3) {
            if (nsd_dec_text(d, &txt, &tl) != NSD_OK || tl != NSD_PROJECT_SLUG_LEN) {
                send_error(fd, NSD_OP_CREATE_PROJECT_RESP, request_id, NSD_EPROTO,
                           "bad slug");
                return;
            }
            memcpy(slug, txt, tl);
        } else {
            send_error(fd, NSD_OP_CREATE_PROJECT_RESP, request_id, NSD_EPROTO,
                       "unknown key");
            return;
        }
    }
    if (rc < 0 || slug[0] == 0) {
        send_error(fd, NSD_OP_CREATE_PROJECT_RESP, request_id, NSD_EPROTO,
                   "missing project slug");
        return;
    }

    int code = nsd_ops_create_project(st, slug);

    uint8_t buf[256];
    buf[0] = NSD_OP_CREATE_PROJECT_RESP;
    struct nsd_encoder enc;
    nsd_enc_init(&enc, buf + 1, sizeof(buf) - 1);
    nsd_enc_map_open(&enc, 3);
    nsd_enc_kv_uint(&enc, 1, request_id);
    nsd_enc_kv_bool(&enc, 2, code == NSD_OK);
    nsd_enc_kv_uint(&enc, 14, (uint64_t)code);
    bool of; size_t n = nsd_enc_finish(&enc, &of);
    if (!of) (void) nsd_frame_write(fd, buf, n + 1);
}

static void handle_drop_project(int fd, struct nsd_session *ses, uint64_t request_id,
                                struct nsd_decoder *d, struct nsd_state *st) {
    if (ses->project) {
        send_error(fd, NSD_OP_DROP_PROJECT_RESP, request_id, NSD_EPROTO,
                   "drop_project requires admin socket");
        return;
    }
    char slug[NSD_PROJECT_SLUG_LEN + 1] = {0};
    uint8_t k;
    int rc;
    while ((rc = nsd_dec_next_key(d, &k)) > 0) {
        const char *txt; size_t tl;
        if (k == 3) {
            if (nsd_dec_text(d, &txt, &tl) != NSD_OK || tl != NSD_PROJECT_SLUG_LEN) {
                send_error(fd, NSD_OP_DROP_PROJECT_RESP, request_id, NSD_EPROTO,
                           "bad slug");
                return;
            }
            memcpy(slug, txt, tl);
        } else {
            send_error(fd, NSD_OP_DROP_PROJECT_RESP, request_id, NSD_EPROTO,
                       "unknown key");
            return;
        }
    }
    if (rc < 0 || slug[0] == 0) {
        send_error(fd, NSD_OP_DROP_PROJECT_RESP, request_id, NSD_EPROTO,
                   "missing project slug");
        return;
    }

    int code = nsd_ops_drop_project(st, slug);

    uint8_t buf[256];
    buf[0] = NSD_OP_DROP_PROJECT_RESP;
    struct nsd_encoder enc;
    nsd_enc_init(&enc, buf + 1, sizeof(buf) - 1);
    nsd_enc_map_open(&enc, 3);
    nsd_enc_kv_uint(&enc, 1, request_id);
    nsd_enc_kv_bool(&enc, 2, code == NSD_OK);
    nsd_enc_kv_uint(&enc, 14, (uint64_t)code);
    bool of; size_t n = nsd_enc_finish(&enc, &of);
    if (!of) (void) nsd_frame_write(fd, buf, n + 1);
}

/* ── BYOK_WRAP / BYOK_UNWRAP handlers ─────────────────────── */

/*
 * Verify a peer-supplied memfd is sealed against the seal set required
 * for plaintext transport. Same shape as enter.c's check; reproduced
 * here to keep the dispatch unit independent.
 */
static bool byok_memfd_sealed(int fd) {
    int seals = fcntl(fd, F_GET_SEALS);
    if (seals < 0) return false;
    return (seals & (F_SEAL_WRITE | F_SEAL_GROW | F_SEAL_SHRINK)) ==
           (F_SEAL_WRITE | F_SEAL_GROW | F_SEAL_SHRINK);
}

static ssize_t byok_read_memfd_all(int fd, uint8_t *out_buf, size_t cap) {
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

static int sys_memfd_create(const char *name, unsigned int flags) {
    return (int) syscall(__NR_memfd_create, name, flags);
}

/*
 * Build a sealed memfd containing `data` of length `len`, seal it
 * F_SEAL_WRITE|F_SEAL_GROW|F_SEAL_SHRINK, and return the fd. Returns
 * -1 on failure (logged in caller). Daemon does not retain the fd
 * after sendmsg — caller closes immediately.
 */
static int byok_make_sealed_memfd(const uint8_t *data, size_t len) {
    int fd = sys_memfd_create("nsd-byok", MFD_CLOEXEC | MFD_ALLOW_SEALING);
    if (fd < 0) return -1;
    size_t off = 0;
    while (off < len) {
        ssize_t w = write(fd, data + off, len - off);
        if (w < 0) {
            if (errno == EINTR) continue;
            close(fd); return -1;
        }
        off += (size_t)w;
    }
    if (fcntl(fd, F_ADD_SEALS,
              F_SEAL_WRITE | F_SEAL_GROW | F_SEAL_SHRINK) != 0) {
        close(fd); return -1;
    }
    return fd;
}

/*
 * sendmsg one frame body with one ancillary FD attached. Returns 0 on
 * success, -1 on error. Length-prefix is u32 BE matching the framing
 * the bridge expects.
 */
static int byok_sendmsg_frame_with_fd(int sock, const uint8_t *body,
                                      size_t body_len, int fd) {
    uint8_t lenbuf[4];
    lenbuf[0] = (uint8_t)(body_len >> 24);
    lenbuf[1] = (uint8_t)(body_len >> 16);
    lenbuf[2] = (uint8_t)(body_len >> 8);
    lenbuf[3] = (uint8_t)(body_len);
    struct iovec iov[2] = {
        { .iov_base = lenbuf, .iov_len = sizeof(lenbuf) },
        { .iov_base = (void *)body, .iov_len = body_len },
    };
    union {
        struct cmsghdr cmsg;
        char buf[CMSG_SPACE(sizeof(int))];
    } u;
    memset(&u, 0, sizeof(u));
    struct msghdr msg = {0};
    msg.msg_iov = iov;
    msg.msg_iovlen = 2;
    msg.msg_control = u.buf;
    msg.msg_controllen = sizeof(u.buf);
    struct cmsghdr *cmsg = CMSG_FIRSTHDR(&msg);
    cmsg->cmsg_level = SOL_SOCKET;
    cmsg->cmsg_type = SCM_RIGHTS;
    cmsg->cmsg_len = CMSG_LEN(sizeof(int));
    memcpy(CMSG_DATA(cmsg), &fd, sizeof(int));
    while (1) {
        ssize_t n = sendmsg(sock, &msg, MSG_NOSIGNAL);
        if (n >= 0) return 0;
        if (errno == EINTR) continue;
        return -1;
    }
}

static void handle_byok_wrap(int fd, struct nsd_session *ses,
                             uint64_t request_id,
                             struct nsd_decoder *d,
                             struct nsd_state *state,
                             int *recv_fds, size_t n_fds) {
    if (!ses->project) {
        for (size_t i = 0; i < n_fds; i++) close(recv_fds[i]);
        send_error(fd, NSD_OP_BYOK_WRAP_RESP, request_id, NSD_EPROTO,
                   "byok_wrap requires per-project socket");
        return;
    }
    const struct nsd_byok_state *byok = nsd_state_byok(state);
    if (!byok || !nsd_byok_ready(byok)) {
        for (size_t i = 0; i < n_fds; i++) close(recv_fds[i]);
        send_error(fd, NSD_OP_BYOK_WRAP_RESP, request_id, NSD_EINTERNAL,
                   "byok master not loaded");
        return;
    }
    if (n_fds != 1) {
        for (size_t i = 0; i < n_fds; i++) close(recv_fds[i]);
        send_error(fd, NSD_OP_BYOK_WRAP_RESP, request_id, NSD_EFD_KIND,
                   "byok_wrap expects exactly one plaintext memfd");
        return;
    }
    int plaintext_fd = recv_fds[0];

    char provider_buf[NSD_BYOK_PROVIDER_MAX + 1] = {0};
    size_t provider_len = 0;
    uint8_t k;
    int rc;
    while ((rc = nsd_dec_next_key(d, &k)) > 0) {
        if (k == 3) {
            const char *txt; size_t tl;
            if (nsd_dec_text(d, &txt, &tl) != NSD_OK ||
                tl == 0 || tl >= sizeof(provider_buf)) {
                close(plaintext_fd);
                send_error(fd, NSD_OP_BYOK_WRAP_RESP, request_id, NSD_EPROTO,
                           "provider parse");
                return;
            }
            memcpy(provider_buf, txt, tl);
            provider_buf[tl] = 0;
            provider_len = tl;
        } else if (k == 4) {
            uint64_t slot;
            if (nsd_dec_uint(d, &slot) != NSD_OK) {
                close(plaintext_fd);
                send_error(fd, NSD_OP_BYOK_WRAP_RESP, request_id, NSD_EPROTO,
                           "slot parse");
                return;
            }
            /* slot is advisory; the FD itself is the source of truth. */
        } else {
            if (nsd_dec_skip(d) != NSD_OK) {
                close(plaintext_fd);
                send_error(fd, NSD_OP_BYOK_WRAP_RESP, request_id, NSD_EPROTO,
                           "byok_wrap body parse");
                return;
            }
        }
    }
    if (provider_len == 0) {
        close(plaintext_fd);
        send_error(fd, NSD_OP_BYOK_WRAP_RESP, request_id, NSD_EPROTO,
                   "missing provider");
        return;
    }
    if (!byok_memfd_sealed(plaintext_fd)) {
        close(plaintext_fd);
        send_error(fd, NSD_OP_BYOK_WRAP_RESP, request_id, NSD_EFD_KIND,
                   "plaintext memfd not sealed");
        return;
    }

    uint8_t plaintext[NSD_BYOK_PLAINTEXT_MAX];
    ssize_t plen = byok_read_memfd_all(plaintext_fd, plaintext,
                                        sizeof(plaintext));
    close(plaintext_fd);
    if (plen <= 0) {
        send_error(fd, NSD_OP_BYOK_WRAP_RESP, request_id, NSD_EFD_KIND,
                   "plaintext read");
        return;
    }

    uint8_t wrapped[NSD_BYOK_WRAPPED_MAX];
    size_t wrapped_len = 0;
    int wrc = nsd_byok_wrap(byok, ses->project,
                             provider_buf, provider_len,
                             plaintext, (size_t)plen,
                             wrapped, sizeof(wrapped), &wrapped_len);
    /* nsd_byok_wrap zeroes plaintext on success or failure. */
    if (wrc != NSD_OK) {
        send_error(fd, NSD_OP_BYOK_WRAP_RESP, request_id,
                   (enum nsd_errcode)wrc, "byok_wrap failed");
        return;
    }

    uint8_t outbuf[NSD_BYOK_WRAPPED_MAX + 64];
    outbuf[0] = NSD_OP_BYOK_WRAP_RESP;
    struct nsd_encoder enc;
    nsd_enc_init(&enc, outbuf + 1, sizeof(outbuf) - 1);
    nsd_enc_map_open(&enc, 3);
    nsd_enc_kv_uint(&enc, 1, request_id);
    nsd_enc_kv_bool(&enc, 2, true);
    nsd_enc_kv_bstr(&enc, 3, wrapped, wrapped_len);
    bool of; size_t n = nsd_enc_finish(&enc, &of);
    if (!of) (void) nsd_frame_write(fd, outbuf, n + 1);

    /* Per-project unwrap counter is NOT incremented on wrap — we count
     * unwraps separately because wrap is "user added a key" UX while
     * unwrap is "agent is using a key" semantically. */
    nsd_event("nsd.byok.wrap.ok",
              "project", nsd_jstr(ses->project),
              "provider", nsd_jstr(provider_buf),
              NULL);
}

static void handle_byok_unwrap(int fd, struct nsd_session *ses,
                               uint64_t request_id,
                               struct nsd_decoder *d,
                               struct nsd_state *state) {
    if (!ses->project) {
        send_error(fd, NSD_OP_BYOK_UNWRAP_RESP, request_id, NSD_EPROTO,
                   "byok_unwrap requires per-project socket");
        return;
    }
    const struct nsd_byok_state *byok = nsd_state_byok(state);
    if (!byok || !nsd_byok_ready(byok)) {
        send_error(fd, NSD_OP_BYOK_UNWRAP_RESP, request_id, NSD_EINTERNAL,
                   "byok master not loaded");
        return;
    }

    char provider_buf[NSD_BYOK_PROVIDER_MAX + 1] = {0};
    size_t provider_len = 0;
    uint8_t wrapped[NSD_BYOK_WRAPPED_MAX];
    size_t wrapped_len = 0;
    bool have_wrapped = false;

    uint8_t k;
    int rc;
    while ((rc = nsd_dec_next_key(d, &k)) > 0) {
        if (k == 3) {
            const char *txt; size_t tl;
            if (nsd_dec_text(d, &txt, &tl) != NSD_OK ||
                tl == 0 || tl >= sizeof(provider_buf)) {
                send_error(fd, NSD_OP_BYOK_UNWRAP_RESP, request_id,
                           NSD_EPROTO, "provider parse");
                return;
            }
            memcpy(provider_buf, txt, tl);
            provider_buf[tl] = 0;
            provider_len = tl;
        } else if (k == 4) {
            const uint8_t *bp; size_t bl;
            if (nsd_dec_bstr(d, &bp, &bl) != NSD_OK ||
                bl == 0 || bl > sizeof(wrapped)) {
                send_error(fd, NSD_OP_BYOK_UNWRAP_RESP, request_id,
                           NSD_EPROTO, "wrapped parse");
                return;
            }
            memcpy(wrapped, bp, bl);
            wrapped_len = bl;
            have_wrapped = true;
        } else {
            if (nsd_dec_skip(d) != NSD_OK) {
                send_error(fd, NSD_OP_BYOK_UNWRAP_RESP, request_id,
                           NSD_EPROTO, "byok_unwrap body parse");
                return;
            }
        }
    }
    if (provider_len == 0 || !have_wrapped) {
        send_error(fd, NSD_OP_BYOK_UNWRAP_RESP, request_id, NSD_EPROTO,
                   "missing provider or wrapped");
        return;
    }

    uint8_t plaintext[NSD_BYOK_PLAINTEXT_MAX];
    size_t plaintext_len = 0;
    int urc = nsd_byok_unwrap(byok, ses->project,
                               provider_buf, provider_len,
                               wrapped, wrapped_len,
                               plaintext, sizeof(plaintext),
                               &plaintext_len);
    if (urc != NSD_OK) {
        send_error(fd, NSD_OP_BYOK_UNWRAP_RESP, request_id,
                   (enum nsd_errcode)urc, "byok_unwrap failed");
        return;
    }

    int memfd = byok_make_sealed_memfd(plaintext, plaintext_len);
    /* Zero plaintext as soon as the memfd has the bytes; the kernel
     * holds the only copy now. */
    {
        volatile uint8_t *p = plaintext;
        for (size_t i = 0; i < plaintext_len; i++) p[i] = 0;
    }
    if (memfd < 0) {
        send_error(fd, NSD_OP_BYOK_UNWRAP_RESP, request_id, NSD_EINTERNAL,
                   "memfd create");
        return;
    }

    uint8_t outbuf[128];
    outbuf[0] = NSD_OP_BYOK_UNWRAP_RESP;
    struct nsd_encoder enc;
    nsd_enc_init(&enc, outbuf + 1, sizeof(outbuf) - 1);
    nsd_enc_map_open(&enc, 3);
    nsd_enc_kv_uint(&enc, 1, request_id);
    nsd_enc_kv_bool(&enc, 2, true);
    nsd_enc_kv_uint(&enc, 3, 0xFD00);
    bool of; size_t outn = nsd_enc_finish(&enc, &of);
    if (of) {
        close(memfd);
        send_error(fd, NSD_OP_BYOK_UNWRAP_RESP, request_id, NSD_EINTERNAL,
                   "encode overflow");
        return;
    }
    if (byok_sendmsg_frame_with_fd(fd, outbuf, outn + 1, memfd) != 0) {
        close(memfd);
        nsd_event("nsd.byok.unwrap.send-fail",
                  "project", nsd_jstr(ses->project),
                  "errno", nsd_jnum(errno),
                  NULL);
        return;
    }
    close(memfd);
    nsd_event("nsd.byok.unwrap.ok",
              "project", nsd_jstr(ses->project),
              "provider", nsd_jstr(provider_buf),
              NULL);
}

/*
 * Walk the ENTER body's per-opcode keys (3+) extracting only key 11
 * (target_cgroup, text). Slot indicators (3-9) and any other advisory
 * fields are tolerated but not enforced — the FDs themselves are the
 * trust-bearing inputs. Returns NSD_OK on success, NSD_EPROTO on a
 * value-shape error or oversize text. *out_target_cgroup is set to
 * point into target_cgroup_buf (or NULL if absent).
 */
static int parse_enter_body_keys(struct nsd_decoder *d,
                                 char *target_cgroup_buf,
                                 size_t target_cgroup_cap,
                                 const char **out_target_cgroup) {
    if (target_cgroup_cap > 0) target_cgroup_buf[0] = 0;
    *out_target_cgroup = NULL;
    uint8_t k;
    int rc;
    while ((rc = nsd_dec_next_key(d, &k)) > 0) {
        if (k == 11) {
            const char *txt; size_t tl;
            if (nsd_dec_text(d, &txt, &tl) != NSD_OK) return NSD_EPROTO;
            if (tl == 0 || tl >= target_cgroup_cap) return NSD_EPROTO;
            memcpy(target_cgroup_buf, txt, tl);
            target_cgroup_buf[tl] = 0;
            *out_target_cgroup = target_cgroup_buf;
        } else {
            if (nsd_dec_skip(d) != NSD_OK) return NSD_EPROTO;
        }
    }
    return rc < 0 ? NSD_EPROTO : NSD_OK;
}

/* ── SPAWN: cold-namespace one-shot. Body = ENTER body + setup_inline.
 * On setup_inline=true daemon stages mounts then chains ENTER in one
 * round-trip. ENTER FDs (argv/env memfds + stdio) arrive on the same
 * frame via SCM_RIGHTS. */

static int handle_spawn(int fd, struct nsd_session *ses, uint64_t request_id,
                        struct nsd_decoder *d, struct nsd_state *state,
                        int *recv_fds, size_t n_fds) {
    if (!ses->project) {
        send_error(fd, NSD_OP_ENTER_RESPONSE, request_id, NSD_EPROTO,
                   "spawn requires per-project socket");
        return -1;
    }

    bool setup_inline = false;
    uint8_t k;
    int rc;
    while ((rc = nsd_dec_next_key(d, &k)) > 0) {
        switch (k) {
        case 11: {
            if (nsd_dec_bool(d, &setup_inline) != NSD_OK) {
                send_error(fd, NSD_OP_ENTER_RESPONSE, request_id,
                           NSD_EPROTO, "setup_inline parse");
                return -1;
            }
            break;
        }
        default:
            /* Tolerate ENTER's slot-indicator keys (3-9) and per-spec hint
             * fields without enforcing them — they're advisory; the FDs
             * themselves are the trust-bearing inputs. Skip the value. */
            if (nsd_dec_skip(d) != NSD_OK) {
                send_error(fd, NSD_OP_ENTER_RESPONSE, request_id,
                           NSD_EPROTO, "spawn body parse");
                return -1;
            }
            break;
        }
    }
    if (rc < 0) {
        send_error(fd, NSD_OP_ENTER_RESPONSE, request_id, NSD_EPROTO,
                   "spawn body trailer");
        return -1;
    }

    if (setup_inline) {
        struct nsd_setup_request sreq;
        memset(&sreq, 0, sizeof(sreq));
        struct nsd_setup_result sres;
        int srv = nsd_ops_setup(ses->project, &sreq, &sres);
        if (srv != 0 || !sres.success) {
            send_error(fd, NSD_OP_ENTER_RESPONSE, request_id,
                       (enum nsd_errcode)(sres.errcode ? sres.errcode
                                                       : NSD_ESTAGE_FAILED),
                       "spawn mount-stage failed");
            return -1;
        }
        (void) nsd_ops_create_project(state, ses->project);
        nsd_event("nsd.spawn.staged",
                  "project", nsd_jstr(ses->project),
                  "anchor_pid", nsd_jnum(sres.anchor_pid),
                  NULL);
    }

    /* SPAWN does not yet plumb target_cgroup; pool/slot work goes through
     * pre-warmed ENTER, not cold SPAWN. Add when needed. */
    int erc = nsd_enter_run(fd, ses, state, request_id, recv_fds, n_fds, NULL);
    if (erc < 0) {
        send_error(fd, NSD_OP_ENTER_RESPONSE, request_id,
                   (enum nsd_errcode)(-erc), "spawn enter failed");
    }
    return erc;
}

/* ── Connection main loop ────────────────────────────────── */

void nsd_dispatch_connection(int fd, const char *project,
                             struct nsd_state *state) {
    struct nsd_session ses;
    memset(&ses, 0, sizeof(ses));
    ses.fd = fd;
    ses.peer_pidfd = -1;
    ses.project = project;

    uid_t expected_uid = nsd_state_svc_uid(state);

    if (nsd_auth_check(fd, &ses, expected_uid) != NSD_OK) {
        close(fd); return;
    }

    if (send_hello(fd, &ses, nsd_state_manifest_pubkey_fp(state)) != 0) {
        nsd_event("nsd.session.close",
                  "reason", nsd_jstr("hello-write-fail"),
                  "project", project ? nsd_jstr(project) : nsd_jstr("admin"),
                  NULL);
        goto done;
    }

    if (recv_client_hello(fd, &ses, nsd_state_hmac_key(state),
                          nsd_state_manifest_pubkey_fp(state)) != 0) {
        nsd_event("nsd.auth.deny",
                  "reason", nsd_jstr("client-hello"),
                  "project", project ? nsd_jstr(project) : nsd_jstr("admin"),
                  NULL);
        goto done;
    }
    nsd_event("nsd.session.open",
              "project", project ? nsd_jstr(project) : nsd_jstr("admin"),
              "peer_pid", nsd_jnum(ses.peer_pid),
              "session_id", nsd_jbytes_hex(ses.session_id, NSD_SESSION_ID_BYTES),
              NULL);

    /* Message loop.
     *
     * Wire format for requests:
     *   [opcode (1 byte)] [CBOR map] [HMAC trailer (16 bytes)]
     *
     * The CBOR map carries request_id (key 1), nonce (key 2), and any
     * per-opcode keys. The HMAC is the last 16 bytes of the frame, NOT
     * a CBOR field — keeping it outside the body avoids HMAC self-reference.
     *
     * For ENTER and INJECT_ENV, the bridge attaches FDs via SCM_RIGHTS;
     * we use nsd_frame_recvmsg to capture them. Other opcodes don't
     * carry FDs but recvmsg is safe regardless. */
    uint8_t frame[NSD_MAX_FRAME_BYTES];
    while (1) {
        int recv_fds[8];
        size_t n_fds = 0;
        ssize_t flen = nsd_frame_recvmsg(fd, frame, sizeof(frame),
                                         recv_fds, 8, &n_fds);
        if (flen <= 0) break;

        if (flen < 1 + NSD_HMAC_TAG_BYTES) {
            for (size_t i = 0; i < n_fds; i++) close(recv_fds[i]);
            send_error(fd, 0xff, 0, NSD_EPROTO, "short frame");
            break;
        }
        size_t cbor_len = (size_t)flen - NSD_HMAC_TAG_BYTES;

        struct nsd_decoder d;
        if (nsd_dec_init(&d, frame, cbor_len) != NSD_OK) {
            send_error(fd, 0xff, 0, NSD_EPROTO, "frame parse");
            break;
        }

        /* Protocol invariant: every message body's first two keys are
         *   key 1 = request_id (uint)
         *   key 2 = nonce (bstr 16)
         * in that order. Per-opcode handlers walk keys 3+ themselves.
         * Strict ordering keeps the dispatch loop simple (no need to
         * buffer keys and resolve out-of-order). */
        uint64_t request_id = 0;
        const uint8_t *nonce = NULL;  size_t nonce_len = 0;

        uint8_t key;
        int rc1 = nsd_dec_next_key(&d, &key);
        if (rc1 != 1 || key != 1 || nsd_dec_uint(&d, &request_id) != NSD_OK) {
            send_error(fd, 0xff, request_id, NSD_EPROTO, "expected request_id (key 1)");
            break;
        }
        int rc2 = nsd_dec_next_key(&d, &key);
        if (rc2 != 1 || key != 2 ||
            nsd_dec_bstr(&d, &nonce, &nonce_len) != NSD_OK ||
            nonce_len != NSD_NONCE_BYTES) {
            send_error(fd, 0xff, request_id, NSD_EPROTO, "expected nonce (key 2)");
            break;
        }

        int v = verify_msg_hmac(&ses, frame, (size_t)flen, request_id,
                                nonce, nsd_state_hmac_key(state));
        if (v != NSD_OK) {
            if (v == NSD_EREPLAY) {
                nsd_event("nsd.replay.deny",
                          "project", project ? nsd_jstr(project) : nsd_jstr("admin"),
                          "request_id", nsd_jnum((long long)request_id),
                          NULL);
            } else {
                nsd_event("nsd.auth.deny",
                          "reason", nsd_jstr("hmac"),
                          "project", project ? nsd_jstr(project) : nsd_jstr("admin"),
                          NULL);
            }
            send_error(fd, 0xff, request_id, (enum nsd_errcode)v,
                       v == NSD_EREPLAY ? "replay" : "hmac");
            break;
        }

        switch (d.opcode) {
        case NSD_OP_HEALTH:
            /* HEALTH has no per-opcode keys; verify clean end. */
            if (nsd_dec_next_key(&d, &key) != 0) {
                send_error(fd, NSD_OP_HEALTH_RESPONSE, request_id, NSD_EPROTO,
                           "unexpected health key");
            } else {
                handle_health(fd, &ses, request_id, state);
            }
            break;
        case NSD_OP_ATTEST:
            if (nsd_dec_next_key(&d, &key) != 0) {
                send_error(fd, NSD_OP_ATTEST_RESPONSE, request_id, NSD_EPROTO,
                           "unexpected attest key");
            } else {
                handle_attest(fd, &ses, request_id, state);
            }
            break;
        case NSD_OP_SETUP:
            handle_setup(fd, &ses, request_id, &d, state);
            break;
        case NSD_OP_TEARDOWN:
            handle_teardown(fd, &ses, request_id, &d, state);
            break;
        case NSD_OP_CREATE_PROJECT:
            handle_create_project(fd, &ses, request_id, &d, state);
            break;
        case NSD_OP_DROP_PROJECT:
            handle_drop_project(fd, &ses, request_id, &d, state);
            break;
        case NSD_OP_ENTER: {
            /* ENTER carries 4 or 5 FDs (env memfd is optional). The
             * handler closes the daemon's copies after dup'ing; on
             * error we close them ourselves. The handler is BLOCKING:
             * it doesn't return until the spawned child exits.
             *
             * Walk per-opcode keys for adapterScope's target_cgroup
             * (key 11). The decoder's strict mode is off; unrecognised
             * advisory keys (slot indicators 3-9) are skipped without
             * error. */
            char target_cgroup_buf[256];
            const char *target_cgroup = NULL;
            int prc = parse_enter_body_keys(&d, target_cgroup_buf,
                                            sizeof(target_cgroup_buf),
                                            &target_cgroup);
            if (prc != NSD_OK) {
                for (size_t i = 0; i < n_fds; i++) close(recv_fds[i]);
                send_error(fd, NSD_OP_ENTER_RESPONSE, request_id,
                           NSD_EPROTO, "enter body parse");
                goto done;
            }
            int rc = nsd_enter_run(fd, &ses, state, request_id,
                                    recv_fds, n_fds, target_cgroup);
            if (rc < 0) {
                for (size_t i = 0; i < n_fds; i++) close(recv_fds[i]);
                send_error(fd, NSD_OP_ENTER_RESPONSE, request_id,
                           (enum nsd_errcode)(-rc),
                           "enter failed");
            }
            n_fds = 0;
            /* After EXIT_NOTIFY there's nothing more on this connection. */
            goto done;
        }
        case NSD_OP_INJECT_ENV: {
            char path[128];
            int rc = nsd_inject_env_run(fd, &ses, state, request_id,
                                          recv_fds, n_fds,
                                          path, sizeof(path));
            for (size_t i = 0; i < n_fds; i++) close(recv_fds[i]);
            n_fds = 0;
            if (rc < 0) {
                send_error(fd, NSD_OP_INJECT_ENV_RESPONSE, request_id,
                           (enum nsd_errcode)(-rc), "inject_env failed");
            } else {
                uint8_t buf[256];
                buf[0] = NSD_OP_INJECT_ENV_RESPONSE;
                struct nsd_encoder enc;
                nsd_enc_init(&enc, buf + 1, sizeof(buf) - 1);
                nsd_enc_map_open(&enc, 3);
                nsd_enc_kv_uint(&enc, 1, request_id);
                nsd_enc_kv_bool(&enc, 2, true);
                nsd_enc_kv_text_z(&enc, 3, path);
                bool of; size_t n = nsd_enc_finish(&enc, &of);
                if (!of) (void) nsd_frame_write(fd, buf, n + 1);
            }
            break;
        }
        case NSD_OP_SPAWN: {
            int rc = handle_spawn(fd, &ses, request_id, &d, state,
                                   recv_fds, n_fds);
            if (rc < 0) {
                for (size_t i = 0; i < n_fds; i++) close(recv_fds[i]);
            }
            n_fds = 0;
            goto done;
        }
        case NSD_OP_BYOK_WRAP: {
            handle_byok_wrap(fd, &ses, request_id, &d, state,
                              recv_fds, n_fds);
            n_fds = 0;
            break;
        }
        case NSD_OP_BYOK_UNWRAP: {
            for (size_t i = 0; i < n_fds; i++) close(recv_fds[i]);
            n_fds = 0;
            handle_byok_unwrap(fd, &ses, request_id, &d, state);
            break;
        }
        default:
            send_error(fd, 0xff, request_id, NSD_EPROTO, "unknown opcode");
            break;
        }

        /* Any FDs not consumed by handlers are closed at end of iter. */
        for (size_t i = 0; i < n_fds; i++) close(recv_fds[i]);
    }
done:
    if (ses.peer_pidfd >= 0) close(ses.peer_pidfd);
    close(fd);
    nsd_event("nsd.session.close",
              "project", project ? nsd_jstr(project) : nsd_jstr("admin"),
              NULL);
}
