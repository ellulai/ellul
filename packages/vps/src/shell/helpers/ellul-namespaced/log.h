/*
 * ellul-namespaced — structured logging.
 *
 * Two streams:
 *   nsd_event   — JSONL appended to /var/log/ellul/nsd-events.jsonl
 *   nsd_phase   — key=value lines appended to /var/log/ellul/nsd-phase.log
 *
 * Both are best-effort, non-blocking, never fail the daemon.
 *
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 ellul.ai. All rights reserved.
 */

#ifndef ELLUL_NSD_LOG_H
#define ELLUL_NSD_LOG_H

#include "daemon.h"

void nsd_log_init(void);
void nsd_log_close(void);

/*
 * Emit a JSONL event. Variadic args follow `kind` as
 * (key1, json_value_literal, key2, json_value_literal, ..., NULL).
 * Each value is interpolated as a literal JSON fragment (the caller is
 * responsible for quoting strings). Use nsd_jstr() for a quoted JSON string
 * and nsd_jnum() for a number.
 */
void nsd_event(const char *kind, ...);

/* Quote a string for JSON. Returns pointer into a per-call thread-local
 * buffer; valid until the next nsd_jstr() call on this thread. */
const char *nsd_jstr(const char *s);
const char *nsd_jbytes_hex(const uint8_t *b, size_t n);
const char *nsd_jnum(long long v);
const char *nsd_jbool(bool v);

/*
 * Phase log: human-readable triage trail mirroring the bash side.
 * Format: "<iso-ts> action=<a> project=<p> phase=<phase> state=<state> [extras]\n"
 */
void nsd_phase(const char *action, const char *project, const char *phase,
               const char *state, const char *extras);

#endif
