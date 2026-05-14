cmd_ship_update() {
  local APP_NAME="$1"
  local PORT="$2"
  local DOMAIN=$(cat /etc/ellul/domain 2>/dev/null || echo "your-domain")

  log "Updating: $APP_NAME (port $PORT)"
  log "Pulling latest..."
  git pull origin "$(git branch --show-current)" --rebase || true

  log "Installing dependencies..."
  if [ -f "pnpm-lock.yaml" ]; then
    pnpm install --frozen-lockfile
  elif [ -f "package-lock.json" ]; then
    npm ci
  else
    npm install
  fi

  log "Building..."
  npm run build

  log "Restarting PM2 process..."
  pm2 restart "$APP_NAME" 2>/dev/null || {
    warn "Process not found in PM2, starting fresh..."
    pm2 delete "$APP_NAME" 2>/dev/null || true
    pm2 start npm --name "$APP_NAME" -- start -- -p "$PORT"
  }
  pm2 save

  echo ""
  success "App updated!"
  echo ""
  echo -e "  ${GREEN}Live at:${NC} https://$APP_NAME.$DOMAIN"
  echo ""
}
