cmd_pull_latest() {
  if ! git remote -v | grep -q origin; then
    fail "No remote configured. Run git-setup first."
    return 1
  fi

  info "Pulling latest..."
  _P="$GIT_PROJECT"
  PULL_RESULT=$(curl -s --max-time 60 -X POST http://localhost:3005/api/internal/git-pull \
    -H "Content-Type: application/json" \
    -d "{\"project\":\"$_P\"}" 2>&1) || true

  if echo "$PULL_RESULT" | grep -q '"success":true'; then
    ok "Up to date"
  else
    fail "Pull failed — you may have conflicts to resolve"
    return 1
  fi
}
