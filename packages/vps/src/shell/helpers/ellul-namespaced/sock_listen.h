/*
 * ellul-namespaced — unix socket listeners.
 *
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 ellul.ai. All rights reserved.
 */

#ifndef ELLUL_NSD_SOCK_LISTEN_H
#define ELLUL_NSD_SOCK_LISTEN_H

#include "daemon.h"

/*
 * Ensure the run dir exists with the right ownership/perms:
 *   /run/ellul-ns mode 0750 root:ellul-ns
 *
 * `ns_gid` is the resolved GID of the ellul-ns group.
 *
 * Returns 0 on success, -1 on failure.
 */
int nsd_sock_ensure_run_dir(gid_t ns_gid);

/*
 * Bind the admin socket /run/ellul-ns/admin.sock.
 *   mode 0660, root:ellul-ns.
 *
 * Caller passes ns_gid. Returns the listening fd, -1 on failure.
 */
int nsd_sock_bind_admin(gid_t ns_gid);

/*
 * Bind a per-project socket /run/ellul-ns/<project>/ctl.sock.
 *   directory mode 0700 root:root, socket mode 0660 root:ellul-ns.
 *
 * Returns the listening fd, -1 on failure.
 */
int nsd_sock_bind_project(const char *project, gid_t ns_gid);

/* Best-effort cleanup. */
void nsd_sock_unlink_project(const char *project);

#endif
