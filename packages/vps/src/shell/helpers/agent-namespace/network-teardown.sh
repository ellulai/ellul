  TEARDOWN_SHORT=$(echo "$PROJECT" | sed 's/^sbx-//')
  $IP link del "ea-$TEARDOWN_SHORT" 2>/dev/null || true
  /usr/bin/nsenter --target 1 --mount -- $IP netns del "ellul-$PROJECT" 2>/dev/null || true