# ── Idempotent host forwarding rules ──
ensure_forwarding() {
  sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1
  echo 'net.ipv4.ip_forward = 1' > /etc/sysctl.d/99-ellul-netns.conf

  # Forward chain — allow traffic to/from namespace subnets
  if ! iptables -C FORWARD -s 10.200.0.0/16 -j ACCEPT 2>/dev/null; then
    iptables -A FORWARD -s 10.200.0.0/16 -j ACCEPT
  fi
  if ! iptables -C FORWARD -d 10.200.0.0/16 -j ACCEPT 2>/dev/null; then
    iptables -A FORWARD -d 10.200.0.0/16 -j ACCEPT
  fi

  # NAT — masquerade outbound traffic from namespaces
  if ! iptables -t nat -C POSTROUTING -s 10.200.0.0/16 -j MASQUERADE 2>/dev/null; then
    iptables -t nat -A POSTROUTING -s 10.200.0.0/16 -j MASQUERADE
  fi

  # DNS DNAT — redirect DNS queries from namespace veth IPs to systemd-resolved
  # (each namespace's resolv.conf points to its HOST_IP)
  if ! iptables -t nat -C PREROUTING -s 10.200.0.0/16 -p udp --dport 53 -j DNAT --to-destination 127.0.0.53:53 2>/dev/null; then
    iptables -t nat -A PREROUTING -s 10.200.0.0/16 -p udp --dport 53 -j DNAT --to-destination 127.0.0.53:53
  fi
  if ! iptables -t nat -C PREROUTING -s 10.200.0.0/16 -p tcp --dport 53 -j DNAT --to-destination 127.0.0.53:53 2>/dev/null; then
    iptables -t nat -A PREROUTING -s 10.200.0.0/16 -p tcp --dport 53 -j DNAT --to-destination 127.0.0.53:53
  fi

  # Persist rules
  iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
}
