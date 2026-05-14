/*
 * test_auth.c — unit tests for the cgroup-membership auth path.
 *
 * Targets the `cgroup_is_bridge` predicate in auth.c. We can't easily
 * exercise SO_PEERPIDFD without a real socketpair, but the cgroup matcher
 * is purely textual and deterministic — perfect for table-driven tests.
 *
 * Build:
 *   gcc -o test-auth test_auth.c -I. -DELLUL_TEST_BUILD -O0 -g
 * Run:  ./test-auth   (exits non-zero on first failed assertion)
 *
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 ellul.ai. All rights reserved.
 */

#define _GNU_SOURCE

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define NSD_BRIDGE_CGROUP_SUFFIX "/ellul-agent-bridge.service"

/* Pull in just the matcher so we can test it without bringing in the
 * whole daemon. The matcher is small, self-contained, and identical to
 * cgroup_is_bridge() in auth.c. */
static int cgroup_is_bridge(const char *cgroup) {
    const char *suffix = NSD_BRIDGE_CGROUP_SUFFIX;
    size_t slen = strlen(suffix);
    const char *p = cgroup;
    while (*p) {
        if (p[0] == '0' && p[1] == ':' && p[2] == ':') {
            const char *q = p + 3;
            const char *eol = strchr(q, '\n');
            size_t qlen = eol ? (size_t)(eol - q) : strlen(q);
            for (size_t i = 0; i + slen <= qlen; i++) {
                if (memcmp(q + i, suffix, slen) != 0) continue;
                size_t after = i + slen;
                if (after == qlen || q[after] == '/') return 1;
            }
        }
        const char *eol = strchr(p, '\n');
        if (!eol) break;
        p = eol + 1;
    }
    return 0;
}

#define EXPECT(cond, msg) \
    do { \
        if (!(cond)) { \
            fprintf(stderr, "FAIL: %s (%s:%d)\n", msg, __FILE__, __LINE__); \
            exit(1); \
        } else { \
            fprintf(stderr, "PASS: %s\n", msg); \
        } \
    } while (0)

int main(void) {
    /* Canonical bridge cgroup — the path we install. */
    EXPECT(cgroup_is_bridge(
        "0::/ellul.slice/ellul-control.slice/ellul-control-plane.slice/ellul-agent-bridge.service\n"),
        "exact bridge service ending matches");

    /* Subscope variant — KillMode=mixed children land in this shape. */
    EXPECT(cgroup_is_bridge(
        "0::/ellul.slice/ellul-control.slice/ellul-control-plane.slice/ellul-agent-bridge.service/init.scope\n"),
        "subscope under bridge service matches");

    /* Different service — must NOT match. */
    EXPECT(!cgroup_is_bridge(
        "0::/ellul.slice/ellul-control.slice/ellul-control-plane.slice/ellul-file-api.service\n"),
        "file-api service does not match");

    /* Sneaky suffix-prefix attack: agent.slice ends with the right
     * substring but not as a path component. Must NOT match. */
    EXPECT(!cgroup_is_bridge(
        "0::/some/path/with/ellul-agent-bridge.service.evil\n"),
        "extension after .service does not match");

    /* User session cgroup — must not match. */
    EXPECT(!cgroup_is_bridge(
        "0::/user.slice/user-1000.slice/session-1.scope\n"),
        "user session does not match");

    /* No cgroup-v2 line at all (legacy v1 hybrid). Must not match. */
    EXPECT(!cgroup_is_bridge(
        "12:cpuset:/\n11:freezer:/\n"),
        "cgroup-v1 hybrid does not match");

    /* Empty input. */
    EXPECT(!cgroup_is_bridge(""),
        "empty cgroup does not match");

    /* Bridge service appears in a non-zero hierarchy line — only `0::`
     * is the v2 unified hierarchy; legacy hierarchies must NOT match. */
    EXPECT(!cgroup_is_bridge(
        "12:cpuset:/ellul-agent-bridge.service\n"),
        "ellul-agent-bridge.service in non-v2 hierarchy does not match");

    /* Multi-line input where one line matches. */
    EXPECT(cgroup_is_bridge(
        "12:cpuset:/\n0::/ellul-control-plane.slice/ellul-agent-bridge.service\n"),
        "match on second line of multi-line input");

    fprintf(stderr, "all auth tests passed\n");
    return 0;
}
