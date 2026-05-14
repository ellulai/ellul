#!/bin/bash
# ellul.ai Git Wrapper
# Routes pull/fetch through sovereign-shield for credential isolation.
# All other commands pass through to the real git binary.
REAL_GIT=/usr/bin/git

# Resolve project name from the current working directory.
# Expects ~/projects/<name> structure.
_resolve_project() {
  local dir
  dir="$(pwd)"
  if [[ "$dir" == */projects/* ]]; then
    echo "$dir" | sed -E 's|.*/projects/([^/]+).*|\1|'
  else
    basename "$dir"
  fi
}

# If GIT_CREDENTIAL_SESSION is already set, we're being called by
# sovereign-shield internally — pass through to real git.
if [ -n "$GIT_CREDENTIAL_SESSION" ]; then
  exec $REAL_GIT "$@"
fi

case "$1" in
  pull)
    # Route through sovereign-shield (fetch + rebase, credentials in memory)
    _P=$(_resolve_project)
    RESULT=$(curl -sf --max-time 60 -X POST http://localhost:3005/api/internal/git-pull \
      -H "Content-Type: application/json" \
      -d "{\"project\":\"$_P\"}" 2>&1)
    if echo "$RESULT" | grep -q '"success":true'; then
      OUTPUT=$(echo "$RESULT" | sed -n 's/.*"output":"\([^"]*\)".*/\1/p')
      echo "${OUTPUT:-Already up to date.}"
      exit 0
    else
      ERROR=$(echo "$RESULT" | sed -n 's/.*"error":"\([^"]*\)".*/\1/p')
      echo "error: ${ERROR:-Pull failed}" >&2
      exit 1
    fi
    ;;
  fetch)
    # Route through sovereign-shield (fetch only, no rebase)
    _P=$(_resolve_project)
    RESULT=$(curl -sf --max-time 60 -X POST http://localhost:3005/api/internal/git-fetch \
      -H "Content-Type: application/json" \
      -d "{\"project\":\"$_P\"}" 2>&1)
    if echo "$RESULT" | grep -q '"success":true'; then
      OUTPUT=$(echo "$RESULT" | sed -n 's/.*"output":"\([^"]*\)".*/\1/p')
      [ -n "$OUTPUT" ] && echo "$OUTPUT"
      exit 0
    else
      ERROR=$(echo "$RESULT" | sed -n 's/.*"error":"\([^"]*\)".*/\1/p')
      echo "error: ${ERROR:-Fetch failed}" >&2
      exit 1
    fi
    ;;
  *)
    exec $REAL_GIT "$@"
    ;;
esac
