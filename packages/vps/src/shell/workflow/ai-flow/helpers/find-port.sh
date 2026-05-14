find_available_port() {
  local PORT=3000
  local USED_PORTS=$(pm2 jlist 2>/dev/null | jq -r '.[].pm2_env.PORT // empty' | sort -n)
  while echo "$USED_PORTS" | grep -q "^$PORT$" || netstat -tuln 2>/dev/null | grep -q ":$PORT "; do
    PORT=$((PORT + 1))
    if [ $PORT -ge 7681 ] && [ $PORT -le 7692 ]; then
      PORT=7693
    fi
  done
  echo $PORT
}
