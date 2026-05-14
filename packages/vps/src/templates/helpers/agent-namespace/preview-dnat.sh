  # Preview DNAT (host-side) — per-project preview port forwarding
  __PREVIEW_ARRAY_VAR__=($SHARED_PREVIEW_PORTS)
  for PPORT in "${__PREVIEW_ARRAY_VAR__[@]}"; do
    if [ "$PPORT" != "0" ] && [ -n "$PPORT" ] && echo "$PPORT" | grep -qE '^[0-9]+$'; then
      if [ "$PPORT" -lt 4000 ] || [ "$PPORT" -gt 4099 ]; then continue; fi
      $IPTABLES -t nat -D PREROUTING -s $NS_IP/32 -d $HOST_IP/32 -p tcp --dport $PPORT -j DNAT --to-destination 127.0.0.1:$PPORT 2>/dev/null || true
      $IPTABLES -t nat -A PREROUTING -s $NS_IP/32 -d $HOST_IP/32 -p tcp --dport $PPORT -j DNAT --to-destination 127.0.0.1:$PPORT
    fi
  done

  # NS-side network config (via ip netns exec on host)
  $IP netns exec "$NS_NETNS" $IP link set lo up
  $IP netns exec "$NS_NETNS" $IP addr add $NS_IP/30 dev $VETH_NS
  $IP netns exec "$NS_NETNS" $IP link set $VETH_NS up
  $IP netns exec "$NS_NETNS" $IP route add default via $HOST_IP

  # NS-internal firewall (batched via iptables-restore for single fork+exec).
  # Only accept traffic from host IP. No DNAT to 127.0.0.1 — services bind to
  # 0.0.0.0, bridge connects directly to NS_IP. DNAT + route_localnet is
  # incompatible with ProtectKernelTunables=true on agent-bridge.
  _NS_FILTER="*filter
-A INPUT -i lo -j ACCEPT
-A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
-A INPUT -s $HOST_IP/32 -j ACCEPT
-A INPUT -j DROP
COMMIT"
  echo "$_NS_FILTER" | $IP netns exec "$NS_NETNS" $IPTABLES-restore --noflush
