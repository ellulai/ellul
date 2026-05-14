#!/bin/bash
PROJECTS_DIR="$HOME/projects"
TARGET_PROJECT="$1"

GREEN='\033[32m'
CYAN='\033[36m'
YELLOW='\033[33m'
RED='\033[31m'
NC='\033[0m'

log() { echo -e "${CYAN}[undo]${NC} $1"; }
success() { echo -e "${GREEN}*${NC} $1"; }
warn() { echo -e "${YELLOW}!${NC} $1"; }
error() { echo -e "${RED}x${NC} $1" >&2; exit 1; }

rollback_project() {
  local PROJECT_PATH="$1"
  local PROJECT_NAME=$(basename "$PROJECT_PATH")
  echo ""
  echo -e "${CYAN}TIME MACHINE: UNDO${NC}"
  echo ""
  cd "$PROJECT_PATH" || error "Project not found: $PROJECT_PATH"
  if ! git rev-parse --is-inside-work-tree &>/dev/null; then
    error "Not a git repository: $PROJECT_PATH"
  fi
  log "Project: $PROJECT_NAME"
  log "Location: $PROJECT_PATH"
  echo ""
  echo -e "${CYAN}Recent history:${NC}"
  git log --oneline -5 --pretty=format:"  %C(yellow)%h%Creset %s %C(dim)(%cr)%Creset" 2>/dev/null || true
  echo ""
  echo ""
  echo -e "${YELLOW}This will reset to the previous commit (HEAD@{1})${NC}"
  echo -e "  All uncommitted changes will be ${RED}LOST${NC}."
  echo ""
  read -p "Type 'UNDO' to confirm: " CONFIRM
  echo ""
  if [ "$CONFIRM" != "UNDO" ]; then
    log "Rollback cancelled."
    exit 0
  fi
  log "Rolling back git..."
  if git reset --hard HEAD@{1} 2>/dev/null; then
    success "Git reset complete"
  else
    warn "Reflog not available, resetting to HEAD~1..."
    git reset --hard HEAD~1 || error "Git reset failed"
    success "Git reset complete"
  fi
  if [ -f "package.json" ]; then
    log "Reinstalling dependencies..."
    if [ -f "pnpm-lock.yaml" ]; then
      pnpm install --frozen-lockfile 2>/dev/null || pnpm install
    elif [ -f "package-lock.json" ]; then
      npm ci 2>/dev/null || npm install
    else
      npm install
    fi
    success "Dependencies installed"
  fi
  if pm2 describe "$PROJECT_NAME" &>/dev/null; then
    log "Restarting PM2 process..."
    pm2 restart "$PROJECT_NAME"
    success "PM2 restarted"
  fi
  echo ""
  success "Rolled back to previous version!"
  echo ""
  log "New HEAD:"
  git log --oneline -1 --pretty=format:"  %C(yellow)%h%Creset %s" 2>/dev/null
  echo ""
  echo ""
}

if [ -n "$TARGET_PROJECT" ]; then
  if [ -d "$TARGET_PROJECT" ]; then
    rollback_project "$TARGET_PROJECT"
  elif [ -d "$PROJECTS_DIR/$TARGET_PROJECT" ]; then
    rollback_project "$PROJECTS_DIR/$TARGET_PROJECT"
  else
    error "Project not found: $TARGET_PROJECT"
  fi
else
  echo ""
  echo -e "${CYAN}Available apps:${NC}"
  echo ""
  # Under the nested-app model each sandbox holds its apps in subfolders with
  # their own `.git`. Discover every app root by finding `.git` dirs at depth
  # 2 (sandbox/app/.git). Skip sandbox-level entries — sandboxes are
  # containers, not repos, and git ops on them would fail.
  mapfile -t APP_PATHS < <(find "$PROJECTS_DIR" -maxdepth 3 -type d -name ".git" 2>/dev/null \
    | sed 's|/\.git$||' \
    | sort)
  if [ ${#APP_PATHS[@]} -eq 0 ]; then
    log "No apps with git repos found under $PROJECTS_DIR"
    exit 0
  fi
  INDEX=1
  for path in "${APP_PATHS[@]}"; do
    rel="${path#$PROJECTS_DIR/}"
    echo "  $INDEX) $rel"
    INDEX=$((INDEX + 1))
  done
  echo ""
  read -p "Select app number: " SELECTION
  if [ -z "$SELECTION" ] || ! [[ "$SELECTION" =~ ^[0-9]+$ ]]; then
    error "Invalid selection"
  fi
  SELECTED_INDEX=$((SELECTION - 1))
  if [ $SELECTED_INDEX -lt 0 ] || [ $SELECTED_INDEX -ge ${#APP_PATHS[@]} ]; then
    error "Invalid selection"
  fi
  rollback_project "${APP_PATHS[$SELECTED_INDEX]}"
fi
