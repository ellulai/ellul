cmd_save() {
  refresh_context
  ensure_gitignore
  log "Preparing to save changes..."
  if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
    warn "No changes to save."
    return 0
  fi
  git add -A
  success "Staged all changes"
  echo ""
  log "Changes to commit:"
  git diff --cached --stat
  echo ""
  log "Generating commit message..."
  DIFF=$(git diff --cached --no-color | head -200)
  FILES_CHANGED=$(git diff --cached --name-only | tr '\n' ', ' | sed 's/,$//')
  # /usr/local/bin/opencode is the TMPDIR-isolation wrapper around the real
  # bun binary at /usr/local/libexec/ellul/opencode — bun extracts its
  # embedded dylib per spawn and never unlinks it, the wrapper scopes that
  # leak to a per-invocation tmpdir cleaned on exit.
  if [ -n "$DIFF" ]; then
    AI_PROMPT="Generate a single-line conventional commit (feat/fix/chore/docs/refactor).
Files: $FILES_CHANGED
Diff (truncated):
$DIFF
Reply with ONLY the commit message."
    MSG=$(echo "$AI_PROMPT" | timeout 30 /usr/local/bin/opencode --no-cache 2>/dev/null | tail -1 | tr -d '\n' || true)
    if [ -z "$MSG" ] || [ ${#MSG} -gt 100 ] || [ ${#MSG} -lt 5 ]; then
      MSG="chore: sync changes ($FILES_CHANGED)"
    fi
  else
    TIMESTAMP=$(date '+%m-%d %H:%M')
    MSG="chore: sync $TIMESTAMP ($FILES_CHANGED)"
  fi
  log "Committing: $MSG"
  if git commit -m "$MSG"; then
    success "Committed!"
  else
    error "Commit failed (check pre-commit hook output)"
  fi
  log "Pushing to remote..."
  BRANCH=$(git branch --show-current)
  if git push origin "$BRANCH" 2>/dev/null; then
    success "Pushed to origin/$BRANCH"
  else
    log "Setting upstream..."
    git push --set-upstream origin "$BRANCH"
    success "Pushed to origin/$BRANCH"
  fi
  echo ""
  success "Changes saved!"
}
