/*
 * ellul-namespaced — peer authentication.
 *
 * Three gates, all kernel-enforced:
 *   1. SO_PEERCRED      — uid must be SVC_USER's uid.
 *   2. SO_PEERPIDFD     — race-free peer pidfd (kernel floor 6.5).
 *   3. cgroup check     — peer's cgroup path must end with
 *                         "/ellul-agent-bridge.service".
 *
 * Plus a startup probe in nsd_auth_probe_kernel() that exits the daemon if
 * SO_PEERPIDFD is unavailable.
 *
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 ellul.ai. All rights reserved.
 */

#ifndef ELLUL_NSD_AUTH_H
#define ELLUL_NSD_AUTH_H

#include "daemon.h"

/*
 * Probe whether the kernel supports SO_PEERPIDFD on AF_UNIX sockets.
 * Creates a socketpair, calls getsockopt(), checks for ENOPROTOOPT.
 *
 * Returns 0 if supported; -1 if not. On -1 the daemon must exit 78.
 */
int nsd_auth_probe_kernel(void);

/*
 * Authenticate a freshly-accepted peer connection.
 *
 * Inputs: connected socket fd.
 * Outputs: populates ses->peer_pid, peer_uid, peer_gid, peer_pidfd,
 *          peer_pidfd_inode. Sets ses->auth_passed = true on success.
 *
 * Returns NSD_OK on success, NSD_EAUTH on failure with reason logged.
 */
int nsd_auth_check(int fd, struct nsd_session *ses, uid_t expected_uid);

#endif
