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
