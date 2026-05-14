/*
 * ellul-namespaced — SETUP / TEARDOWN / CREATE_PROJECT / DROP_PROJECT.
 *
 * The daemon delegates the actual mount/iptables work to the bash
 * control plane (/usr/local/bin/ellul-agent-namespace) via fork+execve
 * with HMAC-validated args. The trust-boundary win over the legacy
 * sudo path:
 *   - No sudoers entry needed (when agent-bridge no longer calls sudo).
 *   - Args are CBOR-typed and HMAC-bound; no shell argv.
 *   - The daemon authenticates the peer's cgroup before invoking.
 *
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 ellul.ai. All rights reserved.
 */

#ifndef ELLUL_NSD_OPS_H
#define ELLUL_NSD_OPS_H

#include "daemon.h"

#define NSD_OPS_MAX_SHARED_PROJECTS 32
#define NSD_OPS_MAX_PREVIEW_PORTS   32

struct nsd_setup_request {
    /* Comma-joined list of `sbx-` slugs (or empty). Daemon passes verbatim
     * to the bash setup script as `--shared-projects`. */
    char shared_projects[NSD_OPS_MAX_SHARED_PROJECTS * (NSD_PROJECT_SLUG_LEN + 1)];
    /* "1"/"0" tokens space-joined, mirroring the bash spawn.sh contract. */
    char shared_previews[NSD_OPS_MAX_SHARED_PROJECTS * 4];
    /* Decimal port numbers space-joined, in [4000, 4099] or "0". */
    char shared_ports[NSD_OPS_MAX_PREVIEW_PORTS * 8];
};

struct nsd_setup_result {
    bool     success;
    int      errcode;          /* nsd_errcode, NSD_OK on success */
    pid_t    anchor_pid;
    char     stderr_tail[2048];
    char     unit_name[128];
};

struct nsd_teardown_result {
    bool     success;
    int      errcode;
    char     stderr_tail[2048];
};

/*
 * Run the legacy `ellul-agent-namespace setup <project> [args]` from
 * inside the daemon. Returns 0 on success (success bit may still be
 * false if the script returned an error JSON), -nsd_errcode on outright
 * fork/exec failure.
 */
int nsd_ops_setup(const char *project,
                  const struct nsd_setup_request *req,
                  struct nsd_setup_result *out);

int nsd_ops_teardown(const char *project,
                     struct nsd_teardown_result *out);

/*
 * Admin operations on the singleton daemon state. Caller holds a global
 * write-lock around these — projects[] is shared across connection
 * threads.
 */
struct nsd_admin_ctx;

/*
 * Bind a per-project listening socket and add the project to projects[].
 * Idempotent. Returns NSD_OK on success.
 */
int nsd_ops_create_project(struct nsd_state *st, const char *project);

/*
 * Unbind a project's listening socket and remove from projects[]. The
 * underlying namespace anchor is NOT torn down — caller must invoke
 * nsd_ops_teardown first (or the legacy path).
 */
int nsd_ops_drop_project(struct nsd_state *st, const char *project);

#endif
