/*
 * ellul-namespaced — ATTEST handler.
 *
 * Walks the namespace anchor's mount table and validates it against the
 * cached manifest. Runs in a forked child to avoid contaminating the
 * daemon's own mount namespace.
 *
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 ellul.ai. All rights reserved.
 */

#ifndef ELLUL_NSD_ATTEST_H
#define ELLUL_NSD_ATTEST_H

#include "daemon.h"
#include "manifest.h"

#define NSD_MAX_MISMATCHES_REPORTED 16
#define NSD_MISMATCH_DESC_LEN       256

struct nsd_attest_result {
    bool     success;             /* attest could be performed at all */
    bool     anchor_alive;        /* anchor PID was alive when sampled */
    int      errcode;             /* nsd_errcode if !success */
    bool     matches;             /* manifest matched observed state */
    size_t   n_mismatches;
    char     mismatches[NSD_MAX_MISMATCHES_REPORTED][NSD_MISMATCH_DESC_LEN];
    uint8_t  mountinfo_digest[NSD_SHA256_BYTES];
};

/*
 * Run an attest pass for `project`. Resolves the anchor PID from
 * /run/.ns-<project>/anchor.pid, validates it's a real anchor in the
 * expected slice, forks a worker that joins the anchor's mount NS and
 * reads /proc/self/mountinfo, then walks the manifest's mount list.
 *
 * Returns 0 on success (regardless of whether attest matched); negative
 * nsd_errcode on outright failure (anchor missing, fork failed, etc.).
 *
 * `home` is the canonical $SVC_HOME used to substitute {home} in mount
 * templates.
 */
int nsd_attest_run(const struct nsd_manifest *m,
                   const char *project,
                   const char *home,
                   struct nsd_attest_result *out);

#endif
