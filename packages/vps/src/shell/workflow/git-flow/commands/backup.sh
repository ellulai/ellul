cmd_backup() {
  require_push_token

  if ! git remote -v | grep -q origin; then
    fail "No remote configured. Run git-setup first."
    return 1
  fi

  # Stage and commit any uncommitted changes
  git add -A
  COMMITTED=false
  if ! git diff --cached --quiet; then
    TIMESTAMP=$(date '+%Y-%m-%d %H:%M')
    git commit -m "Backup from ellul.ai ($TIMESTAMP)" >/dev/null
    COMMITTED=true
  fi

  # Count unpushed commits
  BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
  AHEAD=$(git rev-list --count "origin/$BRANCH..HEAD" 2>/dev/null || echo "0")

  if [ "$AHEAD" = "0" ]; then
    ok "Already up to date"
    return 0
  fi

  # Push
  _P="$GIT_PROJECT"
  PUSH_RESULT=$(curl -s --max-time 60 -X POST http://localhost:3005/api/internal/git-push \
    -H "Content-Type: application/json" \
    -d "{\"token\":\"$GIT_PUSH_TOKEN\",\"project\":\"$_P\"}" 2>&1) || true

  if echo "$PUSH_RESULT" | grep -q '"success":true'; then
    if [ "$COMMITTED" = "true" ]; then
      ok "Committed and pushed to remote"
    else
      ok "Pushed $AHEAD commit(s) to remote"
    fi
  else
    if [ "$COMMITTED" = "true" ]; then
      fail "Committed locally but push failed"
    else
      fail "Push failed"
    fi
    info "Try 'git-flow force-backup' if the remote has diverged"
    return 1
  fi
}
