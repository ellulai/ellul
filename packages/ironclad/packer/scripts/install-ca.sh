#!/bin/bash
# Install Coemad Root CA for Warden HTTPS inspection
#
# The root CA certificate is baked into the golden image so that
# all HTTPS traffic intercepted by Warden is trusted by the system.
set -euo pipefail

echo "[golden] Installing root CA for Warden MITM..."

# Generate a self-signed root CA for Warden
# In production, this would be a pre-generated CA stored securely
mkdir -p /etc/warden

# Generate CA private key
openssl genrsa -out /etc/warden/ca.key 4096

# Generate CA certificate
openssl req -x509 -new -nodes \
  -key /etc/warden/ca.key \
  -sha256 \
  -days 3650 \
  -out /etc/warden/ca.crt \
  -subj "/C=US/ST=CA/O=ellul.ai/OU=Warden/CN=ellul.ai Warden CA"

# Install CA cert to system trust store
cp /etc/warden/ca.crt /usr/local/share/ca-certificates/ellul-warden-ca.crt
update-ca-certificates

# Also install for Node.js (it uses its own CA bundle)
echo "NODE_EXTRA_CA_CERTS=/etc/warden/ca.crt" >> /etc/environment

# Set permissions (warden user needs to read)
chown warden:warden /etc/warden/ca.key /etc/warden/ca.crt
chmod 600 /etc/warden/ca.key
chmod 644 /etc/warden/ca.crt

echo "[golden] Root CA installed"
