#!/bin/sh
# SPDX-License-Identifier: BUSL-1.1
# Copyright (c) 2026 ellul.ai. All rights reserved.
#
# Namespace wrapper used when codex is invoked outside the Effect
# ChildProcessSpawner path (shell-triggered one-shots, lazy-AI shims).
#
# ELLUL_NS_PROJECT contract:
#   - sbx-{7char}: sudo into ellul-agent-namespace, run codex inside
#   - __host__: provider probe (e.g. `codex --version`); exec codex
#     directly. Skipping the namespace request keeps the caller in its
#     own namespace — agents already inside a sandbox cannot escape.
#   - missing: fail closed (refuse to spawn codex outside a namespace).
#
# Binary path resolved from $HOME — set deterministically by systemd's
# `User=` directive, matches the configured SVC_USER on every tier
# (dev on paid, coder on free) without /etc/default/ellul lookup.

set -eu

if [ -z "${ELLUL_NS_PROJECT:-}" ]; then
  echo "ellul-codex-ns: ELLUL_NS_PROJECT env is required — refusing to spawn codex outside any namespace" >&2
  exit 64
fi

if [ -z "${HOME:-}" ]; then
  echo "ellul-codex-ns: HOME unset — cannot resolve codex binary" >&2
  exit 64
fi

CODEX_BIN="$HOME/.node/bin/codex"

if [ "$ELLUL_NS_PROJECT" = "__host__" ]; then
  exec "$CODEX_BIN" "$@"
fi

exec sudo -n ellul-agent-namespace enter "$ELLUL_NS_PROJECT" -- "$CODEX_BIN" "$@"
