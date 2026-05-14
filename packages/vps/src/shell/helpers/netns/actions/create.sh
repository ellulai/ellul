create)
    if [ -z "$NS_NAME" ] || [ -z "$PORT" ]; then
      echo '{"success":false,"error":"Usage: create <ns-name> <port>"}'
      exit 1
    fi

    calc_ips "$PORT"
    ensure_forwarding

    # Veth interface names (max 15 chars).
    # Use hash-based names to avoid leaking app names in 'ip link show' output.
    NS_HASH=$(echo -n "${NS_NAME}" | sha256sum | cut -c1-8)
    VETH_HOST="v-${NS_HASH}"
    VETH_NS="vn-${NS_HASH}"

    # Create namespace if it doesn't exist
    if ! ip netns list | grep -q "^${NS_NAME} "; then
      ip netns add "$NS_NAME"
    fi

    # Create veth pair if it doesn't exist
    if ! ip link show "$VETH_HOST" >/dev/null 2>&1; then
      ip link add "$VETH_HOST" type veth peer name "$VETH_NS"
      ip link set "$VETH_NS" netns "$NS_NAME"

      # Configure host side
      ip addr add "${HOST_IP}/30" dev "$VETH_HOST"
      ip link set "$VETH_HOST" up

      # Configure namespace side
      ip netns exec "$NS_NAME" ip addr add "${NS_IP}/30" dev "$VETH_NS"
      ip netns exec "$NS_NAME" ip link set "$VETH_NS" up
      ip netns exec "$NS_NAME" ip link set lo up
      ip netns exec "$NS_NAME" ip route add default via "$HOST_IP"
    fi

    # DNS resolver for the namespace
    mkdir -p "/etc/netns/${NS_NAME}"
    echo "nameserver ${HOST_IP}" > "/etc/netns/${NS_NAME}/resolv.conf"

    # Data vault directory (shield-runner owns, agent gets wx only)
    DATA_DIR="/var/lib/ellul-shielded/${NS_NAME}"
    mkdir -p "$DATA_DIR"
    chown shield-runner:"$SVC_USER" "$DATA_DIR"
    chmod 2730 "$DATA_DIR"

    # Localhost DNAT — route localhost:PORT to namespace IP.
    # RESTRICTED to caddy + shield-runner UIDs only (agent cannot reach preview).
    # If the agent curls localhost:PORT, it hits nothing (DNAT doesn't fire for its UID).
    CADDY_UID=$(id -u caddy 2>/dev/null || echo "")
    SHIELD_UID=$(id -u shield-runner 2>/dev/null || echo "")
    if [ -n "$CADDY_UID" ]; then
      if ! iptables -t nat -C OUTPUT -p tcp -d 127.0.0.1 --dport "$PORT" -m owner --uid-owner "$CADDY_UID" -j DNAT --to-destination "${NS_IP}:${PORT}" 2>/dev/null; then
        iptables -t nat -A OUTPUT -p tcp -d 127.0.0.1 --dport "$PORT" -m owner --uid-owner "$CADDY_UID" -j DNAT --to-destination "${NS_IP}:${PORT}"
      fi
    fi
    if [ -n "$SHIELD_UID" ]; then
      if ! iptables -t nat -C OUTPUT -p tcp -d 127.0.0.1 --dport "$PORT" -m owner --uid-owner "$SHIELD_UID" -j DNAT --to-destination "${NS_IP}:${PORT}" 2>/dev/null; then
        iptables -t nat -A OUTPUT -p tcp -d 127.0.0.1 --dport "$PORT" -m owner --uid-owner "$SHIELD_UID" -j DNAT --to-destination "${NS_IP}:${PORT}"
      fi
    fi

    # Block agent from directly connecting to namespace subnet (prevents IP guessing)
    SVC_UID=$(id -u "$SVC_USER" 2>/dev/null || echo "")
    if [ -n "$SVC_UID" ]; then
      if ! iptables -C OUTPUT -m owner --uid-owner "$SVC_UID" -d 10.200.0.0/16 -j DROP 2>/dev/null; then
        iptables -I OUTPUT 1 -m owner --uid-owner "$SVC_UID" -d 10.200.0.0/16 -j DROP
      fi
    fi

    # Persist all iptables rules (DNAT + agent block)
    iptables-save > /etc/iptables/rules.v4 2>/dev/null || true

    echo "{\"success\":true,\"nsIp\":\"${NS_IP}\",\"hostIp\":\"${HOST_IP}\"}"
    ;;
