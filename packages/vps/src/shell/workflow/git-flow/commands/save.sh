cmd_save() {
  require_push_token

  if git diff --quiet && git diff --cached --quiet; then
    ok "Nothing to save — working tree clean"
    return 0
  fi

  git add -A
  TIMESTAMP=$(date '+%Y-%m-%d %H:%M')
  CHANGED_FILES=$(git diff --cached --name-only | head -5 | tr '\n' ', ' | sed 's/,$//')
  MSG="Sync: $TIMESTAMP ($CHANGED_FILES)"
  git commit -m "$MSG" >/dev/null
  ok "Committed: $CHANGED_FILES"

  if git remote -v | grep -q origin; then
    _P="$GIT_PROJECT"
    PUSH_RESULT=$(curl -s --max-time 60 -X POST http://localhost:3005/api/internal/git-push \
      -H "Content-Type: application/json" \
      -d "{\"token\":\"$GIT_PUSH_TOKEN\",\"project\":\"$_P\"}" 2>&1) || true
    if echo "$PUSH_RESULT" | grep -q '"success":true'; then
      ok "Pushed to remote"
    else
      fail "Committed locally but push failed"
      return 1
    fi
  else
    info "No remote — saved locally only"
  fi
}
