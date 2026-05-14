/*
 * ellul-namespaced — message dispatch.
 *
 * One thread per accepted connection (the connection loop runs on a worker
 * pulled from a small pool). Each thread runs the handshake, then loops
 * reading frames and calling per-opcode handlers.
 *
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 ellul.ai. All rights reserved.
 */

#ifndef ELLUL_NSD_DISPATCH_H
#define ELLUL_NSD_DISPATCH_H

#include "daemon.h"

/*
 * Run a connection to completion. Owns the fd (closes on return). `project`
 * is the per-project slug (or NULL for admin connections). `state` is the
 * daemon's singleton.
 */
void nsd_dispatch_connection(int fd, const char *project,
                             struct nsd_state *state);

#endif
