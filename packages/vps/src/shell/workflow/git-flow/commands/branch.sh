cmd_branch() {
  echo "New Branch"
  printf '  Branch name (empty to cancel): '
  read -r BRANCH_NAME
  if [ -z "$BRANCH_NAME" ]; then
    return 0
  fi
  BRANCH_NAME=$(echo "$BRANCH_NAME" | tr ' ' '-' | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]//g')
  if git rev-parse --verify "$BRANCH_NAME" >/dev/null 2>&1; then
    info "Branch '$BRANCH_NAME' already exists"
    printf '  Switch to it? [y/N] '
    read -r CONFIRM
    if [ "$CONFIRM" = "y" ] || [ "$CONFIRM" = "Y" ]; then
      git checkout "$BRANCH_NAME" >/dev/null 2>&1
      ok "Switched to $BRANCH_NAME"
    fi
    return 0
  fi
  git checkout -b "$BRANCH_NAME" >/dev/null 2>&1
  ok "Created branch: $BRANCH_NAME"
}
