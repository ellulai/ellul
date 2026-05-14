#!/bin/bash
# SPDX-License-Identifier: BUSL-1.1
# Copyright (c) 2025 ellul.ai. All rights reserved.
#
# Post-Quantum Decryption — ML-KEM-1024 + AES-256-GCM
#
# Decrypts an ML-KEM envelope using the ellul-crypto binary.
# No RSA, no OpenSSL asymmetric operations.
#
# Input: Envelope JSON via stdin (piped from heartbeat/enforcer)
# Output: Decrypted plaintext on stdout
# Private key: /etc/ellul-bootstrap/node.key (root:shield 640)

set -e

PRIVATE_KEY="/etc/ellul-bootstrap/node.key"
CRYPTO_BIN="/usr/local/bin/ellul-crypto"

if [ ! -f "$PRIVATE_KEY" ]; then
  echo "Error: Private key not found at $PRIVATE_KEY" >&2
  exit 1
fi

if [ ! -x "$CRYPTO_BIN" ]; then
  echo "Error: ellul-crypto binary not found or not executable at $CRYPTO_BIN" >&2
  exit 1
fi

# Read envelope from stdin and decrypt via ellul-crypto
# The binary handles:
#   1. JSON parse of envelope
#   2. ML-KEM-1024 decapsulate
#   3. AES-256-GCM decrypt
#   4. Memory zeroization of key material
exec "$CRYPTO_BIN" decrypt --key "$PRIVATE_KEY" --stdin
