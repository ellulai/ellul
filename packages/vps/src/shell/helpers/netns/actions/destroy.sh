destroy)
    if [ -z "$NS_NAME" ]; then
      echo '{"success":false,"error":"Usage: destroy <ns-name>"}'
      exit 1
    fi

    # Kill all processes in the namespace
    ip netns pids "$NS_NAME" 2>/dev/null | xargs -r kill -9 2>/dev/null || true

    # Remove localhost DNAT rule (find and delete any OUTPUT DNAT rules for this NS IP)
    # Extract the NS IP from the veth peer before deleting the link
    NS_HASH=$(echo -n "${NS_NAME}" | sha256sum | cut -c1-8)
    VETH_HOST="v-${NS_HASH}"
    NS_IP_CLEANUP=$(ip addr show "$VETH_HOST" 2>/dev/null | grep -oP 'peer \K[0-9.]+' || true)
    if [ -n "$NS_IP_CLEANUP" ]; then
      iptables -t nat -S OUTPUT 2>/dev/null | grep "DNAT.*$NS_IP_CLEANUP" | while read -r rule; do
        iptables -t nat $(echo "$rule" | sed 's/^-A/-D/') 2>/dev/null || true
      done
    fi

    # Delete veth pair (host side — automatically deletes peer)
    ip link delete "$VETH_HOST" 2>/dev/null || true

    # Delete namespace
    ip netns delete "$NS_NAME" 2>/dev/null || true

    # Clean up resolv.conf
    rm -rf "/etc/netns/${NS_NAME}" 2>/dev/null || true

    # Clean up data vault (optional — preserve data across redeploys)
    # rm -rf "/var/lib/ellul-shielded/${NS_NAME}" 2>/dev/null || true

    echo '{"success":true}'
    ;;
