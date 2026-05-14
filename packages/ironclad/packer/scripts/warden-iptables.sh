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
# Without this, the catch-all DROP at the bottom kills SYN-ACK replies
# from services (file-api, agent-bridge) back to Caddy → 502.
# Paid tier doesn't need this because it has no catch-all DROP.
iptables -I OUTPUT -m owner --uid-owner coder -d 127.0.0.0/8 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# Whitelist localhost ports needed for inter-service communication.
# Free tier has a catch-all DROP, so anything not listed here is blocked.
# Security for shield is enforced by IPC token (shield-ipc group), not iptables.
iptables -A OUTPUT -m owner --uid-owner coder -d 127.0.0.1 -p tcp --dport 8080 -j ACCEPT   # Warden proxy (NAT target)
iptables -A OUTPUT -m owner --uid-owner coder -d 127.0.0.1 -p udp --dport 5353 -j ACCEPT   # Warden DNS
iptables -A OUTPUT -m owner --uid-owner coder -d 127.0.0.53 -p udp --dport 53 -j ACCEPT    # systemd-resolved
iptables -A OUTPUT -m owner --uid-owner coder -d 127.0.0.53 -p tcp --dport 53 -j ACCEPT    # systemd-resolved
iptables -A OUTPUT -m owner --uid-owner coder -d 127.0.0.1 -p tcp --dport 3005 -j ACCEPT   # sovereign-shield
iptables -A OUTPUT -m owner --uid-owner coder -d 127.0.0.1 -p tcp --dport 7701 -j ACCEPT   # term-proxy
# NOT whitelisted (agent must not reach directly): 3002 (file-api), 4096 (opencode), 7700 (agent-bridge)
iptables -A OUTPUT -m owner --uid-owner coder -d 127.0.0.0/8 -j DROP

# ------------------------------------------------------------
# Step 2: NAT — Redirect ALL coder TCP through Warden proxy
# ------------------------------------------------------------

# Skip Warden NAT for internal service ports (file-api ↔ shield, agent-bridge ↔ local services)
# Without these, localhost connections to these ports get redirected to Warden (port 8080)
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
