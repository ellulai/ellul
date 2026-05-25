#!/bin/bash
# ellul-opencode-exec — TMPDIR-isolated launcher for the opencode binary.
#
# Bun's standalone-executable runtime (which opencode is built with) extracts
# its embedded dynamic library to "$TMPDIR/.<hash>-00000000.so" on every
# process start and never unlinks it. Without isolation these 4.4 MB files
# accumulate in /tmp until the namespace's tmpfs is full, at which point
# every cp into /proc/<anchor>/root/tmp/.ns-env-* fails with ENOSPC and the
# bridge surfaces that error in place of the model's reply.
#
# This wrapper is the single entry point for every opencode invocation
# (bridge, ai-flow, inspect, scripts). It allocates a private TMPDIR per
# invocation, hands it to opencode, and removes it on exit — so the
# extracted dylib is freed deterministically with the process.
#
# Bun env note: Bun 1.3+ aborts package operations with "Unexpected
# accessing temporary directory. Please set $BUN_TMPDIR or $BUN_INSTALL"
# in two distinct sandbox conditions — both of which this wrapper has
# to satisfy so opencode's internal "bun install" (run by the plugin
# loader at every project-open) succeeds:
#
#   1. TMPDIR is a non-default path. We deliberately relocate it to the
#      per-invocation /tmp/opencode-run.* dir for dylib-leak containment,
#      so we set BUN_TMPDIR to the same dir — bun treats that as
#      explicit acknowledgement and keeps its package-staging scratch
#      inside the isolated area (same lifecycle as the dylib, cleaned
#      up on wrapper exit).
#
#   2. BUN_INSTALL (bun's "home" — default $HOME/.bun) is unwritable.
#      Inside the per-sandbox mount namespace the tmpfs overlay that
#      hides cross-project paths renders $HOME/.bun read-only; bun
#      refuses to run install there and surfaces the same error message.
#      We redirect BUN_INSTALL to $HOME/.cache/opencode-bun, which is
#      writable + disk-backed + persistent across spawns (so plugin
#      installs are cached, not re-downloaded every open). The dir is
#      created on demand in case of a first spawn.
#
# Without either half of this, every project-open fails plugin install
# silently — MCP providers and plugin-backed features (including chat)
# never wire up, and the UI sits on "working…" forever.
set -euo pipefail

# Real opencode binary lives off-PATH in libexec; only this wrapper invokes
# it. The wrapper itself sits at /usr/local/bin/opencode so every shell
# invocation of `opencode` (PATH lookup or absolute) routes through here.
REAL_OPENCODE="/usr/local/libexec/ellul/opencode"
if [ ! -x "$REAL_OPENCODE" ]; then
  echo "opencode wrapper: backing binary not found at $REAL_OPENCODE" >&2
  exit 127
fi

# Allocate an isolated TMPDIR for this run. mktemp ensures the path is
# unique and not predictable. Mode 700 keeps it readable only by the
# spawning user — the dylib content is bun-internal and not secret, but
# narrow perms are appropriate for any per-process scratch directory.
PARENT_TMPDIR="${TMPDIR:-/tmp}"
RUN_TMPDIR="$(mktemp -d "${PARENT_TMPDIR%/}/opencode-run.XXXXXXXXXX")"
chmod 700 "$RUN_TMPDIR"

# Ensure the writable BUN_INSTALL target exists. We use a persistent
# per-user location (not RUN_TMPDIR) because re-downloading plugins on
# every spawn would compound opencode serve's cold-start latency. The
# dir may already exist from prior spawns — mkdir -p is idempotent.
BUN_INSTALL_DIR="${HOME:-/root}/.cache/opencode-bun"
mkdir -p "$BUN_INSTALL_DIR"

# Wrapper version tag. The lifecycle reconciler in agent-bridge reads
# this from /proc/<pid>/environ on every tick and kills any live
# opencode serve whose tag no longer matches the on-disk wrapper —
# that's how wrapper fixes shipped via the core-runtime manifest land
# on alive-but-stale serves without waiting for them to die of natural
# causes. sha256 of the wrapper file itself (read via $0, which
# sha256sum follows through symlinks) gives us a stable identifier
# that changes iff the wrapper bytes change. Truncated to 12 chars
# because the full hash is overkill for an equality check and bloats
# every spawn's environment.
WRAPPER_SHA="$(sha256sum "$0" 2>/dev/null | cut -c1-12)"

cleanup() {
  # Best-effort: tmpdir may already be gone if the kernel reaped it
  # (e.g. tmpfs unmount), or we're racing a sibling cleaner. Either way
  # don't fail.
  rm -rf "$RUN_TMPDIR" 2>/dev/null || true
}
trap cleanup EXIT

# Run opencode in the background so the EXIT trap fires after it exits.
# `exec` would replace the wrapper with opencode and skip cleanup, so we
# spawn-and-wait instead. Signal forwarding ensures SIGTERM/SIGINT from
# systemd or a parent reaches opencode (otherwise opencode would linger
# past the wrapper's death and the dylib leak we're trying to prevent
# would re-appear in the parent namespace's tmpfs).
#
# Env passed to opencode (all inherited by any opencode-spawned child —
# bun install, plugin loaders, internal tools — via normal POSIX
# inheritance):
#   TMPDIR                      — isolated scratch for bun's dylib
#   BUN_TMPDIR                  — opt-in acknowledgement of non-default TMPDIR
#                                  so bun install does not abort on the
#                                  safety check
#   BUN_INSTALL                 — writable bun home (default $HOME/.bun is
#                                  read-only in the per-sandbox mount
#                                  namespace — see notes above)
#   ELLUL_OPENCODE_WRAPPER_SHA  — wrapper-identity tag; lifecycle reconciler
#                                  reads it from /proc/<pid>/environ and
#                                  respawns the serve when the wrapper bytes
#                                  change on disk (stale-wrapper eviction)
# On Android proot, bun's JSC signal handlers crash under proot's ptrace
# interception (SIGSEGV at 0xBBADBEEF). Bypass by invoking the binary
# through the rootfs glibc linker directly — the kernel executes the
# linker natively (no ptrace), which then loads bun without interference.
GLIBC_LD="/lib/ld-linux-aarch64.so.1"
GLIBC_LIBPATH="/lib/aarch64-linux-gnu"
if [ "${ELLUL_PLATFORM:-}" = "android" ] && [ -x "$GLIBC_LD" ]; then
  TMPDIR="$RUN_TMPDIR" \
  BUN_TMPDIR="$RUN_TMPDIR" \
  BUN_INSTALL="$BUN_INSTALL_DIR" \
  ELLUL_OPENCODE_WRAPPER_SHA="$WRAPPER_SHA" \
    "$GLIBC_LD" --library-path "$GLIBC_LIBPATH" "$REAL_OPENCODE" "$@" &
else
  TMPDIR="$RUN_TMPDIR" \
  BUN_TMPDIR="$RUN_TMPDIR" \
  BUN_INSTALL="$BUN_INSTALL_DIR" \
  ELLUL_OPENCODE_WRAPPER_SHA="$WRAPPER_SHA" \
    "$REAL_OPENCODE" "$@" &
fi
CHILD_PID=$!
trap 'kill -TERM "$CHILD_PID" 2>/dev/null || true' INT TERM

# `wait` returns 128+signum if interrupted by a trapped signal — the child
# may still be running. Loop until the child is actually reaped so the
# wrapper's exit code reflects the child's real status (the standard
# tini/dumb-init idiom for PID 1 signal handling).
wait "$CHILD_PID"
EXIT_CODE=$?
while [ "$EXIT_CODE" -ge 128 ] && kill -0 "$CHILD_PID" 2>/dev/null; do
  wait "$CHILD_PID"
  EXIT_CODE=$?
done
trap - INT TERM
exit "$EXIT_CODE"
