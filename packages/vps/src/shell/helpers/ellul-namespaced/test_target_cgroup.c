/*
 * test_target_cgroup.c — unit tests for the adapterScope target_cgroup
 * path validator (target_cgroup_path_ok in enter.c).
 *
 * The validator is purely textual; we mirror the implementation here to
 * keep the test independent of namespace/seccomp wiring. If the matcher
 * in enter.c diverges from this copy, the cross-test is the alarm: we
 * keep both byte-identical.
 *
 * Build:
 *   gcc -o test-target-cgroup test_target_cgroup.c -I. -DELLUL_TEST_BUILD -O0 -g
 * Run:  ./test-target-cgroup   (exits non-zero on first failed assertion)
 *
 * SPDX-License-Identifier: BUSL-1.1
 * Copyright (c) 2026 ellul.ai. All rights reserved.
 */

#define _GNU_SOURCE

#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static bool target_cgroup_path_ok(const char *path, const char *project) {
    if (!path || !project) return false;
    if (strncmp(project, "sbx-", 4) != 0) return false;
    const char *short_id = project + 4;
    size_t short_len = strlen(short_id);
    if (short_len == 0 || short_len > 32) return false;
    for (size_t i = 0; i < short_len; i++) {
        char c = short_id[i];
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'))) return false;
    }
    size_t plen = strlen(path);
    if (plen == 0 || plen >= 256) return false;
    char buf[256];
    memcpy(buf, path, plen);
    if (buf[plen - 1] == '/') { buf[plen - 1] = 0; plen--; }
    else { buf[plen] = 0; }
    for (size_t i = 0; i + 1 < plen; i++) {
        if (buf[i] == '.' && buf[i + 1] == '.') return false;
        if (buf[i] == '/' && buf[i + 1] == '/') return false;
    }
    static const char prefix[] =
        "/sys/fs/cgroup/ellul.slice/ellul-user-workload.slice/";
    size_t prefix_len = sizeof(prefix) - 1;
    if (plen <= prefix_len) return false;
    if (memcmp(buf, prefix, prefix_len) != 0) return false;
    char want_slice[80];
    int wn = snprintf(want_slice, sizeof(want_slice),
                      "ellul-user-workload-sbx-%s.slice/", short_id);
    if (wn <= 0 || (size_t)wn >= sizeof(want_slice)) return false;
    if (plen <= prefix_len + (size_t)wn) return false;
    if (memcmp(buf + prefix_len, want_slice, (size_t)wn) != 0) return false;
    const char *tail = buf + prefix_len + (size_t)wn;
    static const char pool_prefix[] = "ellul-pool-sbx-";
    size_t pool_prefix_len = sizeof(pool_prefix) - 1;
    if (strncmp(tail, pool_prefix, pool_prefix_len) != 0) return false;
    const char *p = tail + pool_prefix_len;
    if (strncmp(p, short_id, short_len) != 0) return false;
    p += short_len;
    if (*p != '-') return false;
    p++;
    static const char *const adapters[] = {
        "claude", "opencode", "cursor", "codex", NULL
    };
    size_t adapter_len = 0;
    for (size_t i = 0; adapters[i]; i++) {
        size_t al = strlen(adapters[i]);
        if (memcmp(p, adapters[i], al) == 0 && p[al] == '-') {
            adapter_len = al;
            break;
        }
    }
    if (adapter_len == 0) return false;
    p += adapter_len;
    if (*p != '-') return false;
    p++;
    size_t scope_len = 0;
    while (*p && *p != '.') {
        char c = *p;
        bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                  (c >= '0' && c <= '9') || c == '_' || c == '-';
        if (!ok) return false;
        p++;
        scope_len++;
        if (scope_len > 32) return false;
    }
    if (scope_len == 0) return false;
    if (strcmp(p, ".scope") != 0) return false;
    return true;
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
    /* Canonical happy path — every adapter, scope id with mixed case + dashes. */
    EXPECT(target_cgroup_path_ok(
        "/sys/fs/cgroup/ellul.slice/ellul-user-workload.slice/"
        "ellul-user-workload-sbx-cit0001.slice/"
        "ellul-pool-sbx-cit0001-claude-pool0.scope",
        "sbx-cit0001"),
        "canonical claude pool scope passes");
    EXPECT(target_cgroup_path_ok(
        "/sys/fs/cgroup/ellul.slice/ellul-user-workload.slice/"
        "ellul-user-workload-sbx-abc1234.slice/"
        "ellul-pool-sbx-abc1234-opencode-Hot_3.scope",
        "sbx-abc1234"),
        "opencode pool scope with mixed-case scope id passes");
    EXPECT(target_cgroup_path_ok(
        "/sys/fs/cgroup/ellul.slice/ellul-user-workload.slice/"
        "ellul-user-workload-sbx-zxy9876.slice/"
        "ellul-pool-sbx-zxy9876-cursor-acp-1.scope/",
        "sbx-zxy9876"),
        "cursor pool scope with trailing slash passes");
    EXPECT(target_cgroup_path_ok(
        "/sys/fs/cgroup/ellul.slice/ellul-user-workload.slice/"
        "ellul-user-workload-sbx-aaaaaaa.slice/"
        "ellul-pool-sbx-aaaaaaa-codex-x.scope",
        "sbx-aaaaaaa"),
        "codex pool scope with single-char scope id passes");

    /* Project-bind: path's <short> must match session project. */
    EXPECT(!target_cgroup_path_ok(
        "/sys/fs/cgroup/ellul.slice/ellul-user-workload.slice/"
        "ellul-user-workload-sbx-cit0001.slice/"
        "ellul-pool-sbx-cit0001-claude-pool0.scope",
        "sbx-other11"),
        "project mismatch on slice rejects");
    EXPECT(!target_cgroup_path_ok(
        "/sys/fs/cgroup/ellul.slice/ellul-user-workload.slice/"
        "ellul-user-workload-sbx-cit0001.slice/"
        "ellul-pool-sbx-other11-claude-pool0.scope",
        "sbx-cit0001"),
        "slice and unit short-id disagreement rejects");

    /* Adapter allowlist — only claude/opencode/cursor/codex. */
    EXPECT(!target_cgroup_path_ok(
        "/sys/fs/cgroup/ellul.slice/ellul-user-workload.slice/"
        "ellul-user-workload-sbx-cit0001.slice/"
        "ellul-pool-sbx-cit0001-evil-pool0.scope",
        "sbx-cit0001"),
        "unknown adapter rejects");

    /* Path prefix attacks. */
    EXPECT(!target_cgroup_path_ok(
        "/sys/fs/cgroup/foo/ellul-user-workload.slice/"
        "ellul-user-workload-sbx-cit0001.slice/"
        "ellul-pool-sbx-cit0001-claude-pool0.scope",
        "sbx-cit0001"),
        "wrong top-level slice rejects");
    EXPECT(!target_cgroup_path_ok(
        "/sys/fs/cgroup/ellul.slice/some-other.slice/"
        "ellul-user-workload-sbx-cit0001.slice/"
        "ellul-pool-sbx-cit0001-claude-pool0.scope",
        "sbx-cit0001"),
        "wrong second-level slice rejects");

    /* Path traversal + double-slash defenses. */
    EXPECT(!target_cgroup_path_ok(
        "/sys/fs/cgroup/ellul.slice/ellul-user-workload.slice/"
        "ellul-user-workload-sbx-cit0001.slice/../"
        "ellul-pool-sbx-cit0001-claude-pool0.scope",
        "sbx-cit0001"),
        ".. in path rejects");
    EXPECT(!target_cgroup_path_ok(
        "/sys/fs/cgroup/ellul.slice/ellul-user-workload.slice//"
        "ellul-user-workload-sbx-cit0001.slice/"
        "ellul-pool-sbx-cit0001-claude-pool0.scope",
        "sbx-cit0001"),
        "double-slash in path rejects");

    /* Wrong unit type — .service when we expect .scope. */
    EXPECT(!target_cgroup_path_ok(
        "/sys/fs/cgroup/ellul.slice/ellul-user-workload.slice/"
        "ellul-user-workload-sbx-cit0001.slice/"
        "ellul-pool-sbx-cit0001-claude-pool0.service",
        "sbx-cit0001"),
        ".service unit type rejects");

    /* Wrong-length project id (must be 7 chars). */
    EXPECT(!target_cgroup_path_ok(
        "/sys/fs/cgroup/ellul.slice/ellul-user-workload.slice/"
        "ellul-user-workload-sbx-foo.slice/"
        "ellul-pool-sbx-foo-claude-pool0.scope",
        "sbx-foo"),
        "short project id rejects (validator binds {short} to project[4..])");

    /* Scope id length cap (max 32). */
    EXPECT(!target_cgroup_path_ok(
        "/sys/fs/cgroup/ellul.slice/ellul-user-workload.slice/"
        "ellul-user-workload-sbx-cit0001.slice/"
        "ellul-pool-sbx-cit0001-claude-"
        "abcdefghijklmnopqrstuvwxyz0123456789.scope",
        "sbx-cit0001"),
        "33-char scope id rejects");

    /* Empty scope id. */
    EXPECT(!target_cgroup_path_ok(
        "/sys/fs/cgroup/ellul.slice/ellul-user-workload.slice/"
        "ellul-user-workload-sbx-cit0001.slice/"
        "ellul-pool-sbx-cit0001-claude-.scope",
        "sbx-cit0001"),
        "empty scope id rejects");

    /* Project must start with sbx-. */
    EXPECT(!target_cgroup_path_ok(
        "/sys/fs/cgroup/ellul.slice/ellul-user-workload.slice/"
        "ellul-user-workload-sbx-cit0001.slice/"
        "ellul-pool-sbx-cit0001-claude-pool0.scope",
        "wrong-cit0001"),
        "non-sbx project rejects");

    /* NULL inputs. */
    EXPECT(!target_cgroup_path_ok(NULL, "sbx-cit0001"),
        "NULL path rejects");
    EXPECT(!target_cgroup_path_ok("/sys/fs/cgroup/ellul.slice/...", NULL),
        "NULL project rejects");

    /* Length cap — 256 bytes. */
    char too_long[300];
    memset(too_long, 'a', sizeof(too_long));
    too_long[sizeof(too_long) - 1] = 0;
    EXPECT(!target_cgroup_path_ok(too_long, "sbx-cit0001"),
        "256-byte path rejects");

    fprintf(stderr, "all target-cgroup tests passed\n");
    return 0;
}
