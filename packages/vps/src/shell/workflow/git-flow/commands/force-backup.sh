cmd_force_backup() {
  require_push_token

  if ! git remote -v | grep -q origin; then
    fail "No remote configured. Run git-setup first."
    return 1
  fi

  git add -A
  if ! git diff --cached --quiet; then
    TIMESTAMP=$(date '+%Y-%m-%d %H:%M')
    git commit -m "Backup from ellul.ai ($TIMESTAMP)" >/dev/null
  fi

  _P="$GIT_PROJECT"
  PUSH_RESULT=$(curl -s --max-time 60 -X POST http://localhost:3005/api/internal/git-push \
    -H "Content-Type: application/json" \
    -d "{\"token\":\"$GIT_PUSH_TOKEN\",\"project\":\"$_P\",\"force\":true}" 2>&1) || true

  if echo "$PUSH_RESULT" | grep -q '"success":true'; then
    ok "Force-pushed to remote"
  else
    fail "Force push failed"
    return 1
  fi
}
