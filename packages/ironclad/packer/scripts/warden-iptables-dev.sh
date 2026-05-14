#!/bin/bash
# ============================================================
# Warden Tunnel Guard — iptables for paid dev tiers
#
# Less restrictive than free tier:
# - Localhost ALLOWED (dev needs local servers: node, vite, etc.)
# - Private nets BLOCKED (lateral movement prevention)
# - ICMP allowed (ping is a common dev diagnostic)
# - No catch-all DROP (paid tier = developer freedom)
#
# Still enforced:
# - IPv6 disabled (prevents Warden bypass)
# - Cloud metadata blocked
# - All external TCP redirected through Warden
# - All DNS redirected through Warden
# - Raw sockets blocked
# - VPN ports blocked
# ============================================================
set -euo pipefail

# ------------------------------------------------------------
# Step 0: Disable IPv6 (prevents Warden bypass)
# ------------------------------------------------------------
sysctl -w net.ipv6.conf.all.disable_ipv6=1
sysctl -w net.ipv6.conf.default.disable_ipv6=1
sysctl -w net.ipv6.conf.lo.disable_ipv6=1
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
# Step 1: Block dangerous destinations
# ------------------------------------------------------------

# Block cloud metadata (Hetzner/AWS/GCP/Azure)
iptables -I OUTPUT -m owner --uid-owner dev -d 169.254.0.0/16 -j DROP

# Block private/internal networks (prevent lateral movement between users)
# User A must NOT be able to scan User B on the Hetzner private subnet
iptables -I OUTPUT -m owner --uid-owner dev -d 10.0.0.0/8 -j DROP
iptables -I OUTPUT -m owner --uid-owner dev -d 172.16.0.0/12 -j DROP
iptables -I OUTPUT -m owner --uid-owner dev -d 192.168.0.0/16 -j DROP

# Carve the namespace veth subnet (10.200.0.0/11) out of the 10.0.0.0/8
# DROP so agent-bridge (running as dev in the default netns) can reply
# to project namespaces. 10.200.0.0/11 is the deterministic range
# produced by getNamespaceIp()'s HMAC formula (octet1 = 200..254). This
# MUST be inserted AFTER the 10.0.0.0/8 DROP above so -I places it at
# position 1, firing before the broader DROP.
#
# Without this, every namespace → MCP endpoint round-trip fails at
# reply time because the bridge's response packet gets dropped by its
# own filter. That's the bug that caused curl timeouts from inside
# sbx-b7s5l7e to 10.205.29.101:7702 — discovered only after the real
# term-proxy shipped and freed up 7702 for MCP.
iptables -I OUTPUT -m owner --uid-owner dev -d 10.200.0.0/11 -j ACCEPT

# Allow namespace veth sources to reach the MCP endpoint on port 7702.
# The `ea-+` interface wildcard restricts this to traffic actually
# arriving on a namespace veth (not spoofed packets from eth0 via
# rp_filter=2 loose mode). The default provisioning rules.v4 has a
# catch-all INPUT DROP that would otherwise block namespace MCP traffic.
iptables -I INPUT -i ea-+ -s 10.200.0.0/11 -p tcp --dport 7702 -j ACCEPT

# ------------------------------------------------------------
# Step 2: NAT — Redirect external TCP through Warden
# Only external traffic (not localhost) gets redirected
# ------------------------------------------------------------

# Redirect external TCP from dev → Warden proxy
iptables -t nat -A OUTPUT -m owner --uid-owner dev -p tcp \
  ! -d 127.0.0.0/8 -j REDIRECT --to-port 8080

# Redirect external DNS from dev → Warden DNS resolver
iptables -t nat -A OUTPUT -m owner --uid-owner dev -p udp --dport 53 \
  ! -d 127.0.0.0/8 -j REDIRECT --to-port 5353

# ------------------------------------------------------------
# Step 3: Block agent from reaching internal services on localhost
# Prevents cross-project attacks via file-api (forged X-Auth-User),
# WebSocket injection via agent-bridge, and direct opencode access.
# Shield (3005) is NOT blocked — file-api needs it for entitlement
# checks, gate requests, git ops. Shield is protected by IPC token
# (shield-ipc group), not iptables.
# ------------------------------------------------------------
iptables -A OUTPUT -m owner --uid-owner dev -d 127.0.0.0/8 -p tcp --dport 3002 -j DROP  # file-api
iptables -A OUTPUT -m owner --uid-owner dev -d 127.0.0.0/8 -p tcp --dport 4096 -j DROP  # opencode server
iptables -A OUTPUT -m owner --uid-owner dev -d 127.0.0.0/8 -p tcp --dport 7700 -j DROP  # agent-bridge

# ------------------------------------------------------------
# Step 4: Block protocol-level bypass vectors
# ------------------------------------------------------------

# Block raw sockets (IP-in-IP, GRE, ESP)
iptables -A OUTPUT -m owner --uid-owner dev -p 41 -j DROP
iptables -A OUTPUT -m owner --uid-owner dev -p 47 -j DROP
iptables -A OUTPUT -m owner --uid-owner dev -p 50 -j DROP

# Block VPN ports
iptables -A OUTPUT -m owner --uid-owner dev -p udp --dport 51820 -j DROP  # WireGuard
iptables -A OUTPUT -m owner --uid-owner dev -p udp --dport 1194 -j DROP   # OpenVPN

echo "[warden-iptables-dev] Tunnel Guard rules applied — dev traffic filtered"
