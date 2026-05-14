#!/usr/bin/env bash
# SPDX-License-Identifier: BUSL-1.1
# Copyright (c) 2026 ellul.ai. All rights reserved.
#
# build.sh — compile the four ellul-namespaced binaries from extracted sources.
# Mirrors the production provisioning compile flags exactly so CI exercises the
# same hardening as the fleet.
#
# Usage:
#   build.sh <src_dir> <bin_dir>
#
# Fails hard on any compile error. No fallbacks.

set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <src_dir> <bin_dir>" >&2
  exit 64
fi

SRC_DIR=$1
BIN_DIR=$2
mkdir -p "$BIN_DIR"

CFLAGS_COMMON=(
  -O2 -Wall -Wextra
  -D_FORTIFY_SOURCE=2
  -fstack-protector-strong
  -Wl,-z,relro,-z,now
)

# ── ellul-seccomp-exec ──────────────────────────────────────
gcc -o "$BIN_DIR/ellul-seccomp-exec" "$SRC_DIR/seccomp-exec.c" \
  -lseccomp "${CFLAGS_COMMON[@]}" -Werror
chmod 755 "$BIN_DIR/ellul-seccomp-exec"
"$BIN_DIR/ellul-seccomp-exec" /bin/true >/dev/null

# ── ellul-ns-mount ──────────────────────────────────────────
gcc -o "$BIN_DIR/ellul-ns-mount" "$SRC_DIR/ns-mount.c" "${CFLAGS_COMMON[@]}"
chmod 755 "$BIN_DIR/ellul-ns-mount"

# ── ellul-namespaced (daemon) ───────────────────────────────
NSD_SRC="$SRC_DIR/ellul-namespaced"
DAEMON_SOURCES=$(find "$NSD_SRC" -maxdepth 1 -name '*.c' \
  ! -name 'fd_pass.c' ! -name 'test_*.c' | sort)
# shellcheck disable=SC2086
gcc -o "$BIN_DIR/ellul-namespaced" $DAEMON_SOURCES \
  -I"$NSD_SRC" "${CFLAGS_COMMON[@]}" \
  -lsodium -ltinycbor -lseccomp -lsystemd -lpthread
chmod 755 "$BIN_DIR/ellul-namespaced"
"$BIN_DIR/ellul-namespaced" --version >/dev/null

# ── ellul-fd-pass (bridge-side helper) ──────────────────────
gcc -o "$BIN_DIR/ellul-fd-pass" "$NSD_SRC/fd_pass.c" "${CFLAGS_COMMON[@]}"
chmod 755 "$BIN_DIR/ellul-fd-pass"

# ── C unit tests (auth + manifest) ──────────────────────────
if [[ -f "$NSD_SRC/test_auth.c" ]]; then
  gcc -o "$BIN_DIR/test-auth" "$NSD_SRC/test_auth.c" \
    -I"$NSD_SRC" -O0 -g -Wall -Wextra
  chmod 755 "$BIN_DIR/test-auth"
fi
if [[ -f "$NSD_SRC/test_manifest.c" ]]; then
  gcc -o "$BIN_DIR/test-manifest" "$NSD_SRC/test_manifest.c" \
    -I"$NSD_SRC" -O0 -g -Wall -Wextra
  chmod 755 "$BIN_DIR/test-manifest"
fi
if [[ -f "$NSD_SRC/test_target_cgroup.c" ]]; then
  gcc -o "$BIN_DIR/test-target-cgroup" "$NSD_SRC/test_target_cgroup.c" \
    -I"$NSD_SRC" -O0 -g -Wall -Wextra
  chmod 755 "$BIN_DIR/test-target-cgroup"
fi
if [[ -f "$NSD_SRC/test_byok.c" ]]; then
  gcc -o "$BIN_DIR/test-byok" "$NSD_SRC/test_byok.c" \
    -I"$NSD_SRC" -O0 -g -Wall -Wextra -lsodium
  chmod 755 "$BIN_DIR/test-byok"
fi

# Echo build summary so CI logs prove what was built.
ls -la "$BIN_DIR" | sed 's/^/build: /'
