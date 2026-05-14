  # Write cleanup script to HOST filesystem (direct iptables, no nsenter)
  cat > "/run/.ns-$PROJECT/ns-cleanup.sh" <<NSCLEANEOF
#!/bin/bash
$IPTABLES -D FORWARD -s $NS_IP/32 -d $HOST_IP/30 -j ACCEPT 2>/dev/null || true
$IPTABLES -D FORWARD -s $NS_IP/32 -d 10.0.0.0/8 -j DROP 2>/dev/null || true
$IPTABLES -D FORWARD -s $NS_IP/32 -j ACCEPT 2>/dev/null || true
$IPTABLES -D FORWARD -d $NS_IP/32 -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || true
$IPTABLES -t nat -D POSTROUTING -s $NS_IP/32 -j MASQUERADE 2>/dev/null || true
$IPTABLES -t nat -D PREROUTING -s $NS_IP/32 -d $HOST_IP/32 -p udp --dport 53 -j DNAT --to-destination 127.0.0.54:53 2>/dev/null || true
$IPTABLES -t nat -D PREROUTING -s $NS_IP/32 -d $HOST_IP/32 -p tcp --dport 53 -j DNAT --to-destination 127.0.0.54:53 2>/dev/null || true
$IPTABLES -t nat -D PREROUTING -s $NS_IP/32 -d $HOST_IP/32 -p tcp --dport 18790 -j DNAT --to-destination 127.0.0.1:18790 2>/dev/null || true
$IPTABLES -t nat -D PREROUTING -s $NS_IP/32 -d $HOST_IP/32 -p tcp --dport 7701 -j DNAT --to-destination 127.0.0.1:7701 2>/dev/null || true
$IPTABLES -t nat -D PREROUTING -s $NS_IP/32 -d $HOST_IP/32 -p tcp --dport 7702 -j DNAT --to-destination 127.0.0.1:7702 2>/dev/null || true
$IP link del $VETH_HOST 2>/dev/null || true
/usr/bin/nsenter --target 1 --mount -- $IP netns del $NS_NETNS 2>/dev/null || true
NSCLEANEOF
  for CLEANUP_PORT in "${__PREVIEW_ARRAY_VAR__[@]}"; do
    if [ "$CLEANUP_PORT" != "0" ] && [ -n "$CLEANUP_PORT" ] && [ "$CLEANUP_PORT" -ge 4000 ] 2>/dev/null && [ "$CLEANUP_PORT" -le 4099 ] 2>/dev/null; then
      echo "$IPTABLES -t nat -D PREROUTING -s $NS_IP/32 -d $HOST_IP/32 -p tcp --dport $CLEANUP_PORT -j DNAT --to-destination 127.0.0.1:$CLEANUP_PORT 2>/dev/null || true" >> "/run/.ns-$PROJECT/ns-cleanup.sh"
    fi
  done
  chmod 700 "/run/.ns-$PROJECT/ns-cleanup.sh"