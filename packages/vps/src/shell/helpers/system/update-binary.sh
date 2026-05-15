#!/bin/bash
set -euo pipefail

# ellul-update-binary -- Update a system binary from its GitHub release.
# Called via sudo by update-ai-tools. Only allowlisted binaries accepted.

BINARY="${1:-}"
if [ -z "$BINARY" ]; then
  echo "Usage: sudo ellul-update-binary <name>"
  echo "Allowed: zeroclaw, opencode, cursor-agent, grok"
  exit 1
fi

ARCH=$(uname -m)

case "$BINARY" in
  zeroclaw)
    case "$ARCH" in
      aarch64|arm64) DL_SUFFIX="aarch64-unknown-linux-gnu" ;;
      x86_64)        DL_SUFFIX="x86_64-unknown-linux-gnu" ;;
      *) echo "Unsupported arch: $ARCH"; exit 1 ;;
    esac
    DL_URL="https://github.com/zeroclaw-labs/zeroclaw/releases/download/v__ZEROCLAW_VERSION__/zeroclaw-${DL_SUFFIX}.tar.gz"
    TARGET="/usr/local/bin/zeroclaw"
    IS_TARBALL=true
    ;;
  opencode)
    case "$ARCH" in
      aarch64|arm64) DL_SUFFIX="linux-arm64" ;;
      x86_64)        DL_SUFFIX="linux-x64" ;;
      *) echo "Unsupported arch: $ARCH"; exit 1 ;;
    esac
    DL_URL="https://github.com/anomalyco/opencode/releases/download/v__OPENCODE_VERSION__/opencode-${DL_SUFFIX}.tar.gz"
    # Update the real bun binary off-PATH; /usr/local/bin/opencode is the
    # TMPDIR-isolation wrapper and must not be replaced by the binary.
    TARGET="/usr/local/libexec/ellul/opencode"
    IS_TARBALL=true
    ;;
  cursor-agent)
    case "$ARCH" in
      aarch64|arm64) CURSOR_ARCH="arm64"; CURSOR_SHA="__CURSOR_SHA_ARM64__" ;;
      x86_64)        CURSOR_ARCH="x64";   CURSOR_SHA="__CURSOR_SHA_AMD64__" ;;
      *) echo "Unsupported arch: $ARCH"; exit 1 ;;
    esac
    DL_URL="https://downloads.cursor.com/lab/__CURSOR_VERSION__/linux/${CURSOR_ARCH}/agent-cli-package.tar.gz"
    TARGET="/usr/local/bin/cursor-agent"
    IS_TARBALL=true
    IS_CURSOR=true
    ;;
  grok)
    # Grok uses a user-local installer — runs as the service user, not root.
    SVC_USER="${SUDO_USER:-dev}"
    GROK_BIN="/home/${SVC_USER}/.grok/bin/grok"
    CURRENT_VER=""
    if [ -x "$GROK_BIN" ]; then
      CURRENT_VER=$(runuser -l "$SVC_USER" -c "$GROK_BIN --version 2>/dev/null" | head -1 || echo "unknown")
    fi
    echo "Updating grok via official installer..."
    runuser -l "$SVC_USER" -c "curl -fsSL https://x.ai/cli/install.sh | bash" 2>&1
    NEW_VER=$(runuser -l "$SVC_USER" -c "$GROK_BIN --version 2>/dev/null" | head -1 || echo "unknown")
    echo "grok: $CURRENT_VER -> $NEW_VER"
    exit 0
    ;;
  *)
    echo "Unknown binary: $BINARY"
    echo "Allowed: zeroclaw, opencode, cursor-agent, grok"
    exit 1
    ;;
esac

CURRENT_VER=""
if [ -x "$TARGET" ]; then
  CURRENT_VER=$("$TARGET" --version 2>/dev/null | head -1 || echo "unknown")
fi

TMP_DIR=$(mktemp -d /tmp/ellul-update-XXXXXX)
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Downloading $BINARY..."
curl -fsSL --retry 3 --connect-timeout 15 --max-time 120 "$DL_URL" -o "$TMP_DIR/archive.tar.gz"

if [ "${IS_CURSOR:-}" = "true" ]; then
  GOT=$(sha256sum "$TMP_DIR/archive.tar.gz" | awk '{print $1}')
  if [ "$GOT" != "$CURSOR_SHA" ]; then
    echo "SHA-256 mismatch: want $CURSOR_SHA got $GOT"
    exit 1
  fi
  echo "SHA-256 verified"
  rm -rf /usr/local/lib/cursor-agent
  mkdir -p /usr/local/lib/cursor-agent
  tar -xzf "$TMP_DIR/archive.tar.gz" -C /usr/local/lib/cursor-agent --strip-components=1
  chmod +x /usr/local/lib/cursor-agent/cursor-agent
  ln -sf /usr/local/lib/cursor-agent/cursor-agent /usr/local/bin/cursor-agent
  BIN_PATH="/usr/local/bin/cursor-agent"
elif [ "$IS_TARBALL" = "true" ]; then
  tar xzf "$TMP_DIR/archive.tar.gz" -C "$TMP_DIR"
  BIN_PATH=$(find "$TMP_DIR" -name "$BINARY" -type f -executable 2>/dev/null | head -1)
  [ -z "$BIN_PATH" ] && BIN_PATH="$TMP_DIR/$BINARY"
  chmod +x "$BIN_PATH"
else
  curl -fsSL --retry 3 --connect-timeout 15 --max-time 120 "$DL_URL" -o "$TMP_DIR/$BINARY"
  BIN_PATH="$TMP_DIR/$BINARY"
  chmod +x "$BIN_PATH"
fi

# Verify the downloaded binary actually runs before replacing the system copy
if ! "$BIN_PATH" --version >/dev/null 2>&1; then
  echo "Downloaded binary failed verification (--version). Aborting — current version preserved."
  exit 1
fi

NEW_VER=$("$BIN_PATH" --version 2>/dev/null | head -1 || echo "unknown")

if [ -z "${IS_CURSOR:-}" ]; then
  # Atomic replace: cp+mv ensures we don't leave a half-written binary if interrupted
  mkdir -p "$(dirname "$TARGET")"
  cp "$BIN_PATH" "$TARGET.new"
  mv "$TARGET.new" "$TARGET"
  chmod 755 "$TARGET"
fi

echo "$BINARY: $CURRENT_VER -> $NEW_VER"
