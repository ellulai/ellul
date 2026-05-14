#!/bin/bash
set -e
ACTION="$1"
PROJECT_DIR="${2:-$HOME/projects}"

GREEN='\033[32m'
CYAN='\033[36m'
YELLOW='\033[33m'
RED='\033[31m'
NC='\033[0m'

CONTEXT_DIR="$HOME/.ellul/context"
GLOBAL_CTX="$CONTEXT_DIR/global.md"
CURRENT_CTX="$CONTEXT_DIR/current.md"
PROXY_URL="__API_URL__/api/ai"
PROXY_TOKEN="$ELLUL_AI_TOKEN"

log() { echo -e "${CYAN}[ai-flow]${NC} $1"; }
success() { echo -e "${GREEN}*${NC} $1"; }
warn() { echo -e "${YELLOW}!${NC} $1"; }
error() { echo -e "${RED}x${NC} $1"; exit 1; }

cd "$PROJECT_DIR" 2>/dev/null || error "Project not found: $PROJECT_DIR"

__REFRESH_CONTEXT__

__ENSURE_GITIGNORE__

__CMD_SAVE__

__SELECT_PROJECT__

__FIND_AVAILABLE_PORT__

__GET_APP_NAME__

__GET_EXISTING_DEPLOYMENT__

__CMD_SHIP__

__CMD_SHIP_UPDATE__

__CMD_SHIP_MANUAL__

__CMD_HELP__

case "$ACTION" in
  save) cmd_save ;;
  ship) cmd_ship ;;
  help|--help|-h) cmd_help ;;
  *) cmd_help ;;
esac