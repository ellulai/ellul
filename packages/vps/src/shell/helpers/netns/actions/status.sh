status)
    if [ -z "$NS_NAME" ]; then
      echo '{"success":false,"error":"Usage: status <ns-name>"}'
      exit 1
    fi

    EXISTS=false
    ALIVE=false
    PID_COUNT=0
    RULE_COUNT=0

    if ip netns list | grep -q "^${NS_NAME} "; then
      EXISTS=true
      PID_COUNT=$(ip netns pids "$NS_NAME" 2>/dev/null | wc -l)
      if [ "$PID_COUNT" -gt 0 ]; then
        ALIVE=true
      fi
      RULE_COUNT=$(ip netns exec "$NS_NAME" nft list ruleset 2>/dev/null | grep -c "accept" || echo 0)
    fi

    echo "{\"exists\":${EXISTS},\"alive\":${ALIVE},\"pidCount\":${PID_COUNT},\"ruleCount\":${RULE_COUNT}}"
    ;;
