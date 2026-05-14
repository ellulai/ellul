select_project() {
  PROJECTS_DIR="$HOME/projects"
  mkdir -p "$PROJECTS_DIR"
  echo ""
  echo -e "${CYAN}PROJECT SELECTOR${NC}"
  echo ""
  EXISTING_PROJECTS=$(ls -d "$PROJECTS_DIR"/*/ 2>/dev/null | xargs -n1 basename 2>/dev/null || true)
  if [ -n "$EXISTING_PROJECTS" ]; then
    echo -e "${CYAN}Existing projects:${NC}"
    echo "$EXISTING_PROJECTS" | while read -r proj; do
      echo "  * $proj"
    done
    echo ""
  fi
  echo -e "What would you like to do?"
  echo ""
  echo -e "  ${GREEN}1)${NC} Work on current directory (${CYAN}$(basename "$(pwd)")${NC})"
  echo -e "  ${GREEN}2)${NC} Create a ${YELLOW}new${NC} project"
  echo ""
  read -p "Choose [1/2]: " CHOICE
  echo ""
  case "$CHOICE" in
    2|new|n)
      read -p "Project name (e.g., shop, blog, api): " NEW_PROJECT_NAME
      NEW_PROJECT_NAME=$(echo "$NEW_PROJECT_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//')
      if [ -z "$NEW_PROJECT_NAME" ]; then
        error "Invalid project name"
      fi
      NEW_PROJECT_PATH="$PROJECTS_DIR/$NEW_PROJECT_NAME"
      if [ -d "$NEW_PROJECT_PATH" ]; then
        warn "Project already exists: $NEW_PROJECT_NAME"
        log "Switching to existing project..."
        cd "$NEW_PROJECT_PATH"
      else
        log "Creating new project: $NEW_PROJECT_NAME"
        mkdir -p "$NEW_PROJECT_PATH"
        cd "$NEW_PROJECT_PATH"
        git init --quiet
        success "Initialized git repository"
      fi
      PROJECT_DIR="$NEW_PROJECT_PATH"
      echo ""
      success "Working in: $PROJECT_DIR"
      echo ""
      ;;
    *)
      log "Working in current directory: $(pwd)"
      PROJECT_DIR="$(pwd)"
      ;;
  esac
}
