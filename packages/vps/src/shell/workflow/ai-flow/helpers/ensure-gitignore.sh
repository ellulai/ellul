ensure_gitignore() {
  if [ ! -f .gitignore ]; then
    log "Creating .gitignore..."
    cat > .gitignore <<'GITIGNORE'
.env
.env.*
!.env.example
node_modules/
.next/
dist/
build/
GITIGNORE
    git add .gitignore
    success "Created .gitignore"
  fi
}
