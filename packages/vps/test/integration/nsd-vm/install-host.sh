#!/usr/bin/env bash
# SPDX-License-Identifier: BUSL-1.1
# Copyright (c) 2026 ellul.ai. All rights reserved.
#
# install-host.sh — provision a Linux host (or CI runner) so the daemon can
# start with feature flags enabled. Hard kernel-version assertion: aborts if
# SO_PEERPIDFD is not present.
#
# Usage:
#   install-host.sh <bin_dir> <src_dir> <repo_root>
#
# Inputs:
#   <bin_dir>    directory containing the freshly-built binaries.
#   <src_dir>    directory of extracted sources (systemd unit + bash wrapper).
#   <repo_root>  repo root (for sign-manifests + manifest sources).
#
# Side effects (idempotent — safe to re-run):
#   - Hard-checks /proc/version_signature against kernel floor 6.5
#   - Installs binaries to /usr/local/bin
#   - Generates a test Ed25519 manifest signing key
#   - Writes /etc/ellul/manifests/manifest.pub + signed tier manifests
#   - Writes /etc/ellul/billing-tier (free)
#   - Writes /etc/default/ellul (PS_USER=$NSD_TEST_USER)
#   - Creates the ellul-ns system group, adds $NSD_TEST_USER to it
#   - Creates /run/ellul-ns/ and /var/log/ellul/
#   - Touches /etc/ellul/feature-flags/nsd-enabled
#   - Installs the systemd unit, daemon-reloads, starts the daemon
#
# Fails hard on any error. No fallbacks.

set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <bin_dir> <src_dir> <repo_root>" >&2
  exit 64
fi

BIN_DIR=$1
SRC_DIR=$2
REPO_ROOT=$3
NSD_TEST_USER=${NSD_TEST_USER:-runner}

if ! id -u "$NSD_TEST_USER" >/dev/null 2>&1; then
  echo "install-host: user $NSD_TEST_USER must already exist" >&2
  exit 1
fi

# ── Kernel floor check (no fallback). ───────────────────────
KERNEL_MAJOR=$(uname -r | cut -d. -f1)
KERNEL_MINOR=$(uname -r | cut -d. -f2)
if (( KERNEL_MAJOR < 6 )) || { (( KERNEL_MAJOR == 6 )) && (( KERNEL_MINOR < 5 )); }; then
  echo "install-host: kernel $(uname -r) below floor 6.5 (SO_PEERPIDFD)" >&2
  exit 1
fi

# Compile a one-shot probe that asserts SO_PEERPIDFD is wired through.
# Mirrors the daemon's own probe in auth.c. If this fails, CI must fail —
# the production daemon would exit with status 78 on this host.
PROBE_SRC=$(mktemp -t nsd-probe-XXXXXX.c)
trap 'rm -f "$PROBE_SRC" "${PROBE_SRC%.c}"' EXIT
cat > "$PROBE_SRC" <<'EOF'
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <sys/socket.h>
#include <unistd.h>
#ifndef SO_PEERPIDFD
#define SO_PEERPIDFD 77
#endif
int main(void) {
    int sv[2];
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) != 0) return 1;
    int pidfd = -1;
    socklen_t len = sizeof(pidfd);
    int rc = getsockopt(sv[0], SOL_SOCKET, SO_PEERPIDFD, &pidfd, &len);
    close(sv[0]); close(sv[1]);
    if (rc != 0) {
        fprintf(stderr, "SO_PEERPIDFD getsockopt failed: %d\n", errno);
        return 1;
    }
    if (pidfd >= 0) close(pidfd);
    return 0;
}
EOF
gcc -O2 -o "${PROBE_SRC%.c}" "$PROBE_SRC"
"${PROBE_SRC%.c}"

# ── Install binaries. ───────────────────────────────────────
install -m 0755 -o root -g root \
  "$BIN_DIR/ellul-seccomp-exec" /usr/local/bin/ellul-seccomp-exec
install -m 0755 -o root -g root \
  "$BIN_DIR/ellul-ns-mount" /usr/local/bin/ellul-ns-mount
install -m 0755 -o root -g root \
  "$BIN_DIR/ellul-namespaced" /usr/local/bin/ellul-namespaced
install -m 0755 -o root -g root \
  "$BIN_DIR/ellul-fd-pass" /usr/local/bin/ellul-fd-pass

# Bash control-plane wrapper — the daemon's SETUP/TEARDOWN ops still
# fork+exec it for the actual mount work in the current cutover slice.
# It is not on the trust boundary (only daemon invokes it now).
install -m 0755 -o root -g root \
  "$SRC_DIR/ellul-agent-namespace" /usr/local/bin/ellul-agent-namespace

# ── Provisioning files. ─────────────────────────────────────
install -d -m 0755 /etc/ellul
install -d -m 0755 /etc/ellul/feature-flags
install -d -m 0755 /etc/ellul/manifests
install -d -m 0755 /opt/ellul/manifests
install -d -m 0750 /var/log/ellul
echo "free" > /etc/ellul/billing-tier
echo "PS_USER=$NSD_TEST_USER" > /etc/default/ellul

# BYOK Phase 1: per-host master + per-project secret root.
install -d -m 0700 -o root -g root /var/lib/ellul/byok
if [[ ! -e /etc/ellul/byok-master.key ]]; then
  dd if=/dev/urandom of=/etc/ellul/byok-master.key bs=32 count=1 status=none
  chown root:root /etc/ellul/byok-master.key
  chmod 0400 /etc/ellul/byok-master.key
fi

# ellul-ns system group (defense-in-depth alongside the cgroup gate).
getent group ellul-ns >/dev/null || groupadd --system ellul-ns
gpasswd -a "$NSD_TEST_USER" ellul-ns >/dev/null || true

# /run/ellul-ns is created by the daemon at startup. We pre-create the
# parent so the daemon's mkdir() lands cleanly.
install -d -m 0755 /run

# ── Manifest signing key (test-only). ───────────────────────
KEY_DIR=$(mktemp -d -t nsd-key-XXXXXX)
chmod 700 "$KEY_DIR"
trap 'rm -rf "$KEY_DIR"' EXIT
openssl genpkey -algorithm ED25519 -out "$KEY_DIR/sign.pem" >/dev/null

# Extract the 32-byte raw seed from PKCS8 PEM. The seed is at the end of
# the DER payload; we re-derive base64 from the last 32 bytes for
# sign-manifests.ts which expects ELLUL_NSD_MANIFEST_KEY=<base64-seed>.
SEED_B64=$(openssl pkey -in "$KEY_DIR/sign.pem" -outform DER 2>/dev/null \
  | tail -c 32 | base64 -w0)
export ELLUL_NSD_MANIFEST_KEY="$SEED_B64"

(
  cd "$REPO_ROOT"
  pnpm tsx apps/api/scripts/sign-manifests.ts
)

install -m 0444 -o root -g root \
  "$REPO_ROOT/packages/vps/src/manifests/manifest.pub" \
  /etc/ellul/manifests/manifest.pub
install -m 0444 -o root -g root \
  "$REPO_ROOT/packages/vps/src/manifests/free.cbor" \
  /opt/ellul/manifests/free.cbor
install -m 0444 -o root -g root \
  "$REPO_ROOT/packages/vps/src/manifests/paid.cbor" \
  /opt/ellul/manifests/paid.cbor

# ── Systemd unit. ───────────────────────────────────────────
install -m 0644 -o root -g root \
  "$SRC_DIR/ellul-namespaced.service" \
  /etc/systemd/system/ellul-namespaced.service

# Feature flags — both the daemon and the bridge client gate on nsd-enabled.
# nsd-client-enabled is set for harness rigs that still grep it from logs.
echo 1 > /etc/ellul/feature-flags/nsd-enabled
echo 1 > /etc/ellul/feature-flags/nsd-client-enabled

systemctl daemon-reload
systemctl enable ellul-namespaced.service >/dev/null

echo "install-host: provisioning complete"
