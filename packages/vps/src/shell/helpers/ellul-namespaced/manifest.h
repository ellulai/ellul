/*
 * ellul-namespaced — Ed25519-signed manifest parser + verifier.
 *
 * The manifest describes the expected mount topology of a per-project
 * namespace. Loaded once at startup, verified once, parsed into the in-memory
 * structure below. ATTEST handlers operate on the cached parse.
 *
 * Manifest CBOR shape (keys are u8):
 *   1=manifest_version (uint, must == 1)
 *   2=issued_at_unix_s (uint)
 *   3=not_after_unix_s (uint)
 *   4=applies_to_tier  (text "free"|"paid")
 *   5=project_slug_re  (text regex; default "^sbx-[a-z0-9]{7}$")
 *   6=mounts           (array of mount entries; see below)
 *   7=network          (map; opaque to attestation today, reserved)
 *   8=binaries_digest  (bstr 32; sha256 of pinned binaries)
 *   9=host_id_re       (text regex; matched against /etc/ellul-bootstrap/server-id)
 *  10=sig              (bstr 64; Ed25519 over CBOR(map without key 10))
 *
 * Mount entry CBOR (keys are u8):
 *   1=target_template (text)
 *   2=kind            (uint enum)
 *   3=source_template (text | null)
 *   4=mandatory       (bool)
 *   5=post_check_fstype (text | null)
 *   6=flags           (uint bitfield)
 *   7=options_required (array of text)
 *
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 ellul.ai. All rights reserved.
 */

#ifndef ELLUL_NSD_MANIFEST_H
#define ELLUL_NSD_MANIFEST_H

#include "daemon.h"

#include <regex.h>

enum nsd_mount_kind {
    NSD_MK_BIND       = 1,
    NSD_MK_TMPFS      = 2,
    NSD_MK_OVERLAY    = 3,
    NSD_MK_PROC       = 4,
    NSD_MK_BLACKHOLE  = 5,
    NSD_MK_RO_REMOUNT = 6,
};

enum nsd_mount_flag {
    NSD_MF_RO     = 1u << 0,
    NSD_MF_NOSUID = 1u << 1,
    NSD_MF_NODEV  = 1u << 2,
    NSD_MF_NOEXEC = 1u << 3,
    NSD_MF_EMPTY  = 1u << 4,  /* blackhole: dirent count must be 0 */
};

#define NSD_MAX_MOUNTS_PER_MANIFEST 64
#define NSD_MAX_PATH_TEMPLATE       512
#define NSD_MAX_OPTIONS_PER_MOUNT   8
#define NSD_MAX_OPTION_LEN          64

struct nsd_manifest_mount {
    char     target_template[NSD_MAX_PATH_TEMPLATE];
    char     source_template[NSD_MAX_PATH_TEMPLATE];
    bool     has_source;
    uint8_t  kind;          /* nsd_mount_kind */
    bool     mandatory;
    char     post_check_fstype[32];
    bool     has_fstype;
    uint32_t flags;
    char     options_required[NSD_MAX_OPTIONS_PER_MOUNT][NSD_MAX_OPTION_LEN];
    size_t   options_required_n;
};

struct nsd_manifest {
    uint32_t version;
    uint64_t issued_at_unix_s;
    uint64_t not_after_unix_s;
    char     applies_to_tier[16];
    char     project_slug_re[128];
    regex_t  project_slug_rx;
    bool     has_project_slug_rx;
    char     host_id_re[256];
    regex_t  host_id_rx;
    bool     has_host_id_rx;
    uint8_t  binaries_digest[NSD_SHA256_BYTES];
    bool     has_binaries_digest;

    struct nsd_manifest_mount mounts[NSD_MAX_MOUNTS_PER_MANIFEST];
    size_t   mounts_n;

    /* sha256 of the entire signed manifest (used as fingerprint surface). */
    uint8_t  digest[NSD_SHA256_BYTES];
};

/*
 * Load and verify the tier manifest at /opt/ellul/manifests/<tier>.cbor.
 * `tier` is read from /etc/ellul/billing-tier.
 *
 * If pubkey_next is non-NULL the signature is also tried against the
 * rotation key (dual-key verification for seamless key rotation).
 *
 * Returns 0 on success; a negative nsd_errcode on failure. On success,
 * *out is heap-allocated; caller frees with nsd_manifest_free().
 */
int nsd_manifest_load_for_tier(const uint8_t pubkey[NSD_PUBKEY_BYTES],
                                const uint8_t *pubkey_next,
                                struct nsd_manifest **out);

void nsd_manifest_free(struct nsd_manifest *m);

/* Compute fingerprint of a 32-byte Ed25519 pubkey: sha256 of the bytes. */
void nsd_manifest_pubkey_fingerprint(const uint8_t pubkey[NSD_PUBKEY_BYTES],
                                      uint8_t out[NSD_FINGERPRINT_BYTES]);

/*
 * Substitute {project} and {home} placeholders in a template path. Writes
 * up to dst_cap bytes; returns 0 on success, -1 if the template contains an
 * unknown placeholder, has `..`, has shell metacharacters, or overflows.
 */
int nsd_manifest_substitute(const char *tmpl, const char *project,
                            const char *home, char *dst, size_t dst_cap);

/* Read the host's tier from /etc/ellul/billing-tier into out. Defaults
 * to "free" on missing file. Caps to 16 bytes. */
void nsd_manifest_read_host_tier(char out[16]);

#endif
