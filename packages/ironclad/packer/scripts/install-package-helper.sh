#!/bin/bash
# Install ellul-apt-install — safe package installation for dev tiers
#
# This helper wraps apt-get install with DEBIAN_FRONTEND=noninteractive
# and validates package names to prevent command injection or local .deb installs.
# Dev users get restricted sudo access to this binary only.
set -euo pipefail

echo "[golden] Installing package helper..."

# Remove immutable flag if golden payload already created this file
chattr -i /usr/local/bin/ellul-apt-install 2>/dev/null || true

cat > /usr/local/bin/ellul-apt-install << 'HELPER'
#!/bin/bash
set -euo pipefail

if [ $# -eq 0 ]; then
  echo "Usage: sudo ellul-apt-install <package> [package ...]"
  exit 1
fi

# Validate each argument: must be a valid Debian package name
for arg in "$@"; do
  # Reject flags
  if [[ "$arg" == -* ]]; then
    echo "Error: flags not allowed. Use: sudo ellul-apt-install <package-name>"
    exit 1
  fi
  # Reject paths and .deb files
  if [[ "$arg" == */* ]] || [[ "$arg" == *.deb ]]; then
    echo "Error: local paths not allowed. Use: sudo ellul-apt-install <package-name>"
    exit 1
  fi
  # Must match Debian package name pattern
  if ! [[ "$arg" =~ ^[a-zA-Z0-9][a-zA-Z0-9.+\-]*$ ]]; then
    echo "Error: invalid package name '$arg'"
    exit 1
  fi
done

export DEBIAN_FRONTEND=noninteractive
exec apt-get install -y \
  -o Dpkg::Options::="--force-confdef" \
  -o Dpkg::Options::="--force-confold" \
  "$@"
HELPER

chmod 755 /usr/local/bin/ellul-apt-install
chattr +i /usr/local/bin/ellul-apt-install

echo "[golden] Package helper installed"
