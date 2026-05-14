/*
 * ellul-namespaced — daemon's own seccomp filter.
 *
 * Allowlist model: deny everything by default, permit only the syscalls
 * the daemon actually needs. Mirrors the philosophy we apply inside agent
 * namespaces but inverted (agents get a denylist; the daemon gets an
 * allowlist because its surface is small).
 *
 * The filter is loaded at startup, after socket bind / manifest verify,
 * before the accept loop. Anything on the deny list (e.g. ptrace,
 * keyctl, init_module, vmsplice) becomes EPERM/SIGSYS depending on
 * caller policy.
 *
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 ellul.ai. All rights reserved.
 */

#ifndef ELLUL_NSD_DAEMON_SECCOMP_H
#define ELLUL_NSD_DAEMON_SECCOMP_H

#include "daemon.h"

/*
 * Install the daemon's allowlist filter. Returns 0 on success, -1 on failure.
 * On failure the caller should refuse to start (we can't trust an unfiltered
 * privileged daemon).
 */
int nsd_daemon_seccomp_install(void);

#endif
