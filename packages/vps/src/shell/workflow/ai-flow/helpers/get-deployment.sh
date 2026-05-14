get_existing_deployment() {
  # Check if current directory already has a deployment
  # Matches by exact projectPath first, then by directory name as fallback
  local APPS_DIR="$HOME/.ellul/apps"
  local CURRENT_PATH="$(pwd)"
  local DIR_NAME=$(basename "$CURRENT_PATH")

  [ -d "$APPS_DIR" ] || return 1

  # First pass: exact projectPath match
  for app_file in "$APPS_DIR"/*.json; do
    [ -f "$app_file" ] || continue
    local APP_PATH=$(jq -r '.projectPath // empty' "$app_file" 2>/dev/null)
    if [ "$APP_PATH" = "$CURRENT_PATH" ]; then
      local APP_NAME=$(jq -r '.name // empty' "$app_file" 2>/dev/null)
      local APP_PORT=$(jq -r '.port // empty' "$app_file" 2>/dev/null)
      local APP_URL=$(jq -r '.url // empty' "$app_file" 2>/dev/null)
      echo "$APP_NAME|$APP_PORT|$APP_URL"
      return 0
    fi
  done

  # Second pass: match by app name == directory name (handles path mismatches)
  for app_file in "$APPS_DIR"/*.json; do
    [ -f "$app_file" ] || continue
    local APP_NAME=$(jq -r '.name // empty' "$app_file" 2>/dev/null)
    if [ "$APP_NAME" = "$DIR_NAME" ]; then
      local APP_PORT=$(jq -r '.port // empty' "$app_file" 2>/dev/null)
      local APP_URL=$(jq -r '.url // empty' "$app_file" 2>/dev/null)
      echo "$APP_NAME|$APP_PORT|$APP_URL"
      return 0
    fi
  done

  return 1
}
