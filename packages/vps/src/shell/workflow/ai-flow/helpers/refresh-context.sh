refresh_context() {
  log "Generating AI context..."
  /usr/local/bin/ellul-ctx "$(pwd)" >/dev/null 2>&1
  success "Context ready"
}
