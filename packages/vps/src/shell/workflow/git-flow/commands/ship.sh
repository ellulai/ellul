cmd_ship() {
  require_push_token

  CURRENT_BRANCH=$(git branch --show-current)
  if [ "$CURRENT_BRANCH" != "main" ]; then
    info "Merging $CURRENT_BRANCH into main..."
    git checkout main >/dev/null 2>&1
    if [ -n "$CURRENT_BRANCH" ]; then
      git merge "$CURRENT_BRANCH" --no-edit >/dev/null 2>&1 || {
        fail "Merge conflict — resolve manually"
        return 1
      }
    fi
  fi

  if git remote -v | grep -q origin; then
    info "Pulling latest..."
    _P="$GIT_PROJECT"
    curl -s --max-time 60 -X POST http://localhost:3005/api/internal/git-pull \
      -H "Content-Type: application/json" \
      -d "{\"project\":\"$_P\"}" >/dev/null 2>&1 || true
  fi

  info "Installing dependencies..."
  npm ci --prefer-offline 2>/dev/null || npm install >/dev/null 2>&1
  info "Building..."
  npm run build >/dev/null 2>&1

  info "Restarting server..."
  if [ -f ecosystem.config.js ]; then
    pm2 startOrRestart ecosystem.config.js --env production >/dev/null 2>&1
  else
    pm2 delete prod 2>/dev/null || true
    pm2 start npm --name "prod" -- start -- -p 3001 >/dev/null 2>&1
  fi
  pm2 save >/dev/null 2>&1

  DOMAIN=$(cat /etc/ellul/domain 2>/dev/null || echo "your-domain")
  ok "Live at https://$DOMAIN/"
}
