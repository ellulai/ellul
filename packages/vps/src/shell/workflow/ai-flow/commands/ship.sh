cmd_ship() {
  select_project
  refresh_context

  # Check for existing deployment
  EXISTING=$(get_existing_deployment)
  if [ -n "$EXISTING" ]; then
    EXISTING_NAME=$(echo "$EXISTING" | cut -d'|' -f1)
    EXISTING_PORT=$(echo "$EXISTING" | cut -d'|' -f2)
    EXISTING_URL=$(echo "$EXISTING" | cut -d'|' -f3)
    echo ""
    success "Found existing deployment: $EXISTING_NAME"
    echo -e "  URL: $EXISTING_URL"
    echo -e "  Port: $EXISTING_PORT"
    echo ""
    log "Updating existing deployment..."
    DEPLOY_MODE="update"
    APP_NAME="$EXISTING_NAME"
    PORT="$EXISTING_PORT"
  else
    log "New deployment (no existing app found)"
    DEPLOY_MODE="create"
    APP_NAME=""
    PORT=""
  fi

  echo ""
  if ! git diff --quiet || ! git diff --cached --quiet; then
    warn "Stashing uncommitted changes..."
    git stash push -m "pre-ship-$(date +%s)"
  fi

  if [ "$DEPLOY_MODE" = "update" ]; then
    # Direct update - no AI needed for existing apps
    cmd_ship_update "$APP_NAME" "$PORT"
  else
    cmd_ship_manual
  fi
}
