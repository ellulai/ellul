#!/bin/bash
set -e

# $ELLUL_GIT_PROJECT is the APP ROOT (e.g. "sbx-xyz/my-app"), never a monorepo
# package path or a bare sandbox slug. The bridge sets it before spawning.
# `.git/` lives at the app root: one git repo per app, not per sandbox.
GIT_PROJECT="${ELLUL_GIT_PROJECT:-}"

if [ -z "$GIT_PROJECT" ]; then
  echo "  ✗ ELLUL_GIT_PROJECT is not set — git-flow requires an active app" >&2
  exit 2
fi

cd "$HOME/projects/$GIT_PROJECT" 2>/dev/null || {
  echo "  ✗ App directory not found: $HOME/projects/$GIT_PROJECT" >&2
  exit 2
}

if [ ! -d .git ]; then
  echo "  ✗ Not a git repo: $HOME/projects/$GIT_PROJECT — scaffold or clone first" >&2
  exit 2
fi

ok() { echo "  ✓ $1"; }
info() { echo "  $1"; }
fail() { echo "  ✗ $1"; }

require_push_token() {
  if [ -z "$GIT_PUSH_TOKEN" ]; then
    fail "Not authorized — click Git Sync in the console to push"
    exit 1
  fi
}

__CMD_BRANCH__

__CMD_SAVE__

__CMD_SHIP__

__CMD_BACKUP__

__CMD_FORCE_BACKUP__

__CMD_PULL_LATEST__

case "$1" in
  branch) cmd_branch ;;
  save) cmd_save ;;
  ship) cmd_ship ;;
  backup) cmd_backup ;;
  force-backup) cmd_force_backup ;;
  pull) cmd_pull_latest ;;
  *)
    echo ""
    echo "Git Flow"
    echo ""
    echo "  save           Commit and push changes"
    echo "  backup         Sync all code to remote"
    echo "  force-backup   Overwrite remote with local code"
    echo "  pull           Pull latest from remote"
    echo "  branch         Create a feature branch"
    echo "  ship           Build and deploy to production"
    echo ""
    ;;
esac