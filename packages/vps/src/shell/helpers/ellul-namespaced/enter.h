/*
 * ellul-namespaced — ENTER + INJECT_ENV handlers.
 *
 * ENTER receives a sealed argv memfd, optional sealed env memfd, and three
 * stdio fds via SCM_RIGHTS. The daemon forks a worker, joins the project's
 * mount + PID + net namespaces, drops capabilities, switches to $SVC_USER,
 * and execve's /usr/local/bin/ellul-seccomp-exec which then chains to the
 * agent CLI binary inside the namespace.
 *
 * After execve the daemon parent registers a pidfd for the child and
 * blocks on it until the child exits, then emits EXIT_NOTIFY on the
 * connection. One ENTER per connection — connection closes after
 * EXIT_NOTIFY.
 *
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 ellul.ai. All rights reserved.
 */

#ifndef ELLUL_NSD_ENTER_H
#define ELLUL_NSD_ENTER_H

#include "daemon.h"

/*
 * Run an ENTER on the connection's session, blocking until the spawned
 * child exits. The argument fd_array carries:
 *   [0]  argv memfd  (sealed; required)
 *   [1]  env memfd   (sealed; optional, may be -1)
 *   [2]  stdin fd
 *   [3]  stdout fd
 *   [4]  stderr fd
 *
 * `target_cgroup`, if non-NULL, redirects the worker out of the anchor's
 * cgroup into a peer-supplied cgroup-v2 path. The path is validated for
 * shape and project binding before any FS op; rejection is fatal. NULL
 * means "join the anchor's cgroup as before" — the default for non-pool
 * spawns.
 *
 * Returns 0 on success (regardless of child's exit code; that's signalled
 * via EXIT_NOTIFY). On hard failure (FD validation, fork, etc.), returns
 * -nsd_errcode. The caller should send the matching error response.
 */
int nsd_enter_run(int conn_fd,
                  struct nsd_session *ses,
                  struct nsd_state *state,
                  uint64_t request_id,
                  int *fd_array, size_t fd_count,
                  const char *target_cgroup);

/*
 * INJECT_ENV: write the contents of a sealed env memfd to a daemon-
 * controlled inode inside the project's namespace. fd_array[0] is the env
 * memfd. Returns the in-namespace path the bridge can reference (always
 * /run/ellul-ns-env-<request_id> inside the namespace).
 */
int nsd_inject_env_run(int conn_fd,
                       struct nsd_session *ses,
                       struct nsd_state *state,
                       uint64_t request_id,
                       int *fd_array, size_t fd_count,
                       char *out_path, size_t out_path_cap);

#endif
