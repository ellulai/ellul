/*
 * ellul-namespaced — subprocess executor running on an unfiltered helper thread.
 *
 * The daemon's seccomp filter inherits across fork+exec. Trusted helper
 * binaries (nsenter, ip, ipset, iptables-restore) make syscalls outside our
 * allowlist and get SIGSYS-killed. nsd_subexec_init() spawns one helper
 * thread BEFORE seccomp_load() so the helper task has no filter; its
 * children inherit the empty chain and run unrestricted. Worker threads
 * delegate all fork+exec through nsd_subexec_run().
 *
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 ellul.ai. All rights reserved.
 */

#ifndef NSD_DAEMON_SUBEXEC_H
#define NSD_DAEMON_SUBEXEC_H

#include <stddef.h>

int nsd_subexec_init(char *const envp[]);

int nsd_subexec_run(const char *path, char *const argv[],
                    const char *stdin_data, size_t stdin_len,
                    char *errbuf, size_t errcap, size_t *errlen,
                    int *exit_status, int *signal_status);

#endif
