cmd_ship_manual() {
  local APP_NAME=$(get_app_name)
  local PORT=$(find_available_port)
  local DOMAIN=$(cat /etc/ellul/domain 2>/dev/null || echo "your-domain")
  log "App: $APP_NAME"
  log "Port: $PORT"
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
  log "Starting with PM2..."
  pm2 delete "$APP_NAME" 2>/dev/null || true
  pm2 start npm --name "$APP_NAME" -- start -- -p "$PORT"
  pm2 save
  log "Exposing to subdomain..."
  sudo /usr/local/bin/ellul-expose "$APP_NAME" "$PORT"
  echo ""
  success "App deployed!"
  echo ""
  echo -e "  ${GREEN}Live at:${NC} https://$APP_NAME.$DOMAIN"
  echo ""
}
