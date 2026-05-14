#!/bin/bash
# Install Warden (Hotel California MITM proxy)
#
# Warden runs as the `warden` user so its own traffic
# is NOT redirected back to itself by iptables.
set -euo pipefail

echo "[golden] Installing Warden..."

# Create warden user (non-login, for service only)
useradd -r -s /usr/sbin/nologin warden

# Create config directories
mkdir -p /etc/warden
mkdir -p /opt/ellul/config

# The compiled warden binary will be placed here during packer build
# For now, create the systemd unit
cat > /etc/systemd/system/ellul-warden.service << 'EOF'
[Unit]
Description=ellul.ai Warden (Hotel California Proxy)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=warden
ExecStart=/usr/local/bin/warden \
  --proxy-port 8080 \
  --dns-port 5353 \
  --health-port 8081 \
  --rules /etc/warden/rules.yaml \
  --ca-key /etc/warden/ca.key \
  --ca-cert /etc/warden/ca.crt \
  --bandwidth 500
Restart=always
RestartSec=5
# Allow binding to privileged ports
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
EOF

# iptables rules: redirect dev user traffic through Warden
# These are applied by the startup agent when FREE_TIER=true
cat > /opt/ellul/config/warden-iptables.sh << 'IPTABLES'
#!/bin/bash
# ============================================================
# Warden Network Jail — Zero-Trust iptables for free tier
#
# Principle: ALL coder traffic goes through Warden or is dropped.
# Warden runs as `warden` user so its traffic is exempt.
# ============================================================
set -euo pipefail

# ------------------------------------------------------------
# Step 0: Disable IPv6 entirely (prevents Warden bypass)
# ------------------------------------------------------------
sysctl -w net.ipv6.conf.all.disable_ipv6=1
sysctl -w net.ipv6.conf.default.disable_ipv6=1
sysctl -w net.ipv6.conf.lo.disable_ipv6=1
# Persist across reboots
cat >> /etc/sysctl.d/99-disable-ipv6.conf << 'SYSCTL'
net.ipv6.conf.all.disable_ipv6=1
net.ipv6.conf.default.disable_ipv6=1
net.ipv6.conf.lo.disable_ipv6=1
SYSCTL

# Flush any existing ip6tables and set default DROP
ip6tables -F OUTPUT 2>/dev/null || true
ip6tables -P OUTPUT DROP 2>/dev/null || true
ip6tables -P INPUT DROP 2>/dev/null || true
ip6tables -P FORWARD DROP 2>/dev/null || true

# ------------------------------------------------------------
# Step 1: Block dangerous destinations FIRST (before NAT)
# These rules use -I (insert at top) for priority
# ------------------------------------------------------------

# Block cloud metadata (Hetzner/AWS/GCP/Azure all use this)
iptables -I OUTPUT -m owner --uid-owner coder -d 169.254.0.0/16 -j DROP

# Block private/internal networks (prevent lateral movement)
iptables -I OUTPUT -m owner --uid-owner coder -d 10.0.0.0/8 -j DROP
iptables -I OUTPUT -m owner --uid-owner coder -d 172.16.0.0/12 -j DROP
iptables -I OUTPUT -m owner --uid-owner coder -d 192.168.0.0/16 -j DROP

# Allow reply packets for established connections on localhost.
# Without this, the catch-all DROP kills SYN-ACK replies from services back to Caddy → 502.
iptables -I OUTPUT -m owner --uid-owner coder -d 127.0.0.0/8 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# Whitelist localhost ports needed for inter-service communication.
# Free tier has a catch-all DROP, so anything not listed here is blocked.
iptables -A OUTPUT -m owner --uid-owner coder -d 127.0.0.1 -p tcp --dport 8080 -j ACCEPT   # Warden proxy
iptables -A OUTPUT -m owner --uid-owner coder -d 127.0.0.1 -p udp --dport 5353 -j ACCEPT   # Warden DNS
iptables -A OUTPUT -m owner --uid-owner coder -d 127.0.0.53 -p udp --dport 53 -j ACCEPT    # systemd-resolved
iptables -A OUTPUT -m owner --uid-owner coder -d 127.0.0.53 -p tcp --dport 53 -j ACCEPT    # systemd-resolved
iptables -A OUTPUT -m owner --uid-owner coder -d 127.0.0.1 -p tcp --dport 3005 -j ACCEPT   # sovereign-shield
iptables -A OUTPUT -m owner --uid-owner coder -d 127.0.0.1 -p tcp --dport 7701 -j ACCEPT   # term-proxy
# NOT whitelisted: 3002 (file-api), 4096 (opencode), 7700 (agent-bridge)
iptables -A OUTPUT -m owner --uid-owner coder -d 127.0.0.0/8 -j DROP

# ------------------------------------------------------------
# Step 2: NAT — Redirect ALL coder TCP through Warden proxy
# ------------------------------------------------------------
# Skip Warden NAT for internal service ports (file-api ↔ shield, agent-bridge ↔ local services)
iptables -t nat -A OUTPUT -m owner --uid-owner coder -d 127.0.0.1 -p tcp --dport 3005 -j ACCEPT   # sovereign-shield
iptables -t nat -A OUTPUT -m owner --uid-owner coder -d 127.0.0.1 -p tcp --dport 7701 -j ACCEPT   # agent-bridge internal

# Redirect ALL remaining outbound TCP from coder → Warden proxy port
# This catches ALL ports (80, 443, 8443, 3000, etc.)
iptables -t nat -A OUTPUT -m owner --uid-owner coder -p tcp \
  -j REDIRECT --to-port 8080

# Redirect ALL DNS (UDP 53) from coder → Warden DNS resolver
iptables -t nat -A OUTPUT -m owner --uid-owner coder -p udp --dport 53 \
  -j REDIRECT --to-port 5353

# ------------------------------------------------------------
# Step 3: DROP everything else from coder
# ------------------------------------------------------------

# Block ALL other UDP from coder (prevents UDP exfil on non-53 ports)
iptables -A OUTPUT -m owner --uid-owner coder -p udp ! --dport 53 -j DROP

# Block ALL ICMP from coder (prevents ICMP tunneling)
iptables -A OUTPUT -m owner --uid-owner coder -p icmp -j DROP

# Block raw sockets from coder
iptables -A OUTPUT -m owner --uid-owner coder -p 41 -j DROP
iptables -A OUTPUT -m owner --uid-owner coder -p 47 -j DROP
iptables -A OUTPUT -m owner --uid-owner coder -p 50 -j DROP

# Final catch-all: DROP any remaining coder traffic not matched above
# (This is defense-in-depth — NAT redirect should handle TCP,
#  but if something slips through, it's dropped)
iptables -A OUTPUT -m owner --uid-owner coder -j DROP

echo "[warden-iptables] All rules applied — coder traffic jailed"
IPTABLES
chmod +x /opt/ellul/config/warden-iptables.sh

echo "[golden] Warden installed"
