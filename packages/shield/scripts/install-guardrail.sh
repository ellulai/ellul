#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2025 ellul.ai. All rights reserved.
#
# install-guardrail.sh — Install the guardrail AST scanner binary
#
# Tries in order:
#   1. Download prebuilt binary for platform/arch
#   2. Build from source if Go is installed
#   3. Skip with warning (guardrail scans will fail-closed)
#
# Installs to: ~/.ellul/bin/guardrail

set -euo pipefail

INSTALL_DIR="${HOME}/.ellul/bin"
BINARY="${INSTALL_DIR}/guardrail"
REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
WARDEN_DIR="${REPO_ROOT}/packages/ironclad/warden"

mkdir -p "${INSTALL_DIR}"

# Already installed?
if [ -x "${BINARY}" ]; then
  echo "[guardrail] Binary already installed at ${BINARY}"
  exit 0
fi

# Try 1: Build from source (Go available)
if command -v go &>/dev/null; then
  echo "[guardrail] Go found. Building from source..."
  if [ -d "${WARDEN_DIR}" ]; then
    # Build in a subshell with explicit failure handling so a go build
    # error surfaces as a visible warning instead of being silently
    # swallowed (the scenario where an attacker-modified toolchain could
    # smuggle a tampered binary without anyone noticing).
    if ( cd "${WARDEN_DIR}" && CGO_ENABLED=1 go build -o "${BINARY}" ./cmd/guardrail/ ); then
      chmod +x "${BINARY}"
      echo "[guardrail] Built and installed at ${BINARY}"
      exit 0
    else
      echo "⚠ [guardrail] Go build failed — falling through to dist fallback. Inspect build output above." >&2
    fi
  else
    echo "[guardrail] Warden source not found at ${WARDEN_DIR}. Skipping build."
  fi
fi

# Try 2: Check if binary exists in package dist
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
for candidate in "${SCRIPT_DIR}/../native/guardrail" "${SCRIPT_DIR}/../../ironclad/dist/guardrail"; do
  if [ -x "${candidate}" ]; then
    cp "${candidate}" "${BINARY}"
    chmod +x "${BINARY}"
    echo "[guardrail] Installed from package dist at ${BINARY}"
    exit 0
  fi
done

# Try 3: Skip with warning
echo ""
echo "⚠ [guardrail] Could not install guardrail binary."
echo "  Guardrail AST scans will fail-closed (execution blocked)."
echo ""
echo "  To fix, either:"
echo "    1. Install Go (https://go.dev) and re-run this script"
echo "    2. Place a compiled guardrail binary at ${BINARY}"
echo ""
echo "  To build manually:"
echo "    cd ${WARDEN_DIR}"
echo "    CGO_ENABLED=1 go build -o ${BINARY} ./cmd/guardrail/"
echo ""
exit 0  # Non-fatal — daemon starts in degraded mode
