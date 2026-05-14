apply-whitelist)
    if [ -z "$NS_NAME" ]; then
      echo '{"success":false,"error":"Usage: apply-whitelist <ns-name>"}'
      exit 1
    fi

    if ! ip netns list | grep -q "^${NS_NAME} "; then
      echo '{"success":false,"error":"Namespace does not exist"}'
      exit 1
    fi

    # Read destinations JSON from stdin
    DESTINATIONS=$(cat)

    # Parse port from namespace IP to reconstruct HOST_IP
    # Get the peer address from the namespace's default route
    HOST_IP=$(ip netns exec "$NS_NAME" ip route show default | awk '{print $3}')
    if [ -z "$HOST_IP" ]; then
      echo '{"success":false,"error":"Cannot determine host IP"}'
      exit 1
    fi

    # Build nftables rules
    RULES="table inet filter {
  chain output {
    type filter hook output priority 0; policy drop;
    oif lo accept
    ct state established,related accept
    ip daddr ${HOST_IP} udp dport 53 accept
    ip daddr ${HOST_IP} tcp dport 53 accept
"

    RULE_COUNT=0

    # Parse JSON array of {host, port, protocol} using python3 (available on all VPS images)
    while IFS='|' read -r host port protocol; do
      [ -z "$host" ] && continue

      # Resolve hostname to all IPs (handles CDN load balancing)
      if echo "$host" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
        # Already an IP
        IPS="$host"
      else
        # Resolve DNS — get ALL A records
        IPS=$(getent ahostsv4 "$host" 2>/dev/null | awk '{print $1}' | sort -u || echo "")
      fi

      for ip in $IPS; do
        [ -z "$ip" ] && continue
        if [ "$port" = "0" ]; then
          RULES+="    ip daddr ${ip} ${protocol} accept\n"
        else
          RULES+="    ip daddr ${ip} ${protocol} dport ${port} accept\n"
        fi
        RULE_COUNT=$((RULE_COUNT + 1))
      done
    done < <(echo "$DESTINATIONS" | python3 -c "
import sys, json
dests = json.load(sys.stdin)
for d in dests:
    print(f\"{d['host']}|{d['port']}|{d['protocol']}\")
" 2>/dev/null || true)

    RULES+="    counter drop
  }
  chain input {
    type filter hook input priority 0; policy drop;
    iif lo accept
    ct state established,related accept
    ip saddr ${HOST_IP} accept
    counter drop
  }
}"

    # Apply nftables rules inside the namespace
    echo -e "$RULES" | ip netns exec "$NS_NAME" nft -f -

    echo "{\"success\":true,\"ruleCount\":${RULE_COUNT}}"
    ;;
