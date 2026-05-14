get_app_name() {
  # Resolve the app name from the current working directory. Under the
  # nested-app model the leaf segment is the app subdir, but running from a
  # sandbox root (a container, not an app) would return the sandbox slug —
  # we explicitly refuse that so callers like deploy/pm2 don't try to treat
  # a sandbox as an app. Pass ELLUL_APP_NAME explicitly to override.
  if [ -n "$ELLUL_APP_NAME" ]; then
    echo "$ELLUL_APP_NAME"
    return 0
  fi
  local CWD=$(pwd)
  local DIR_NAME=$(basename "$CWD")
  # Refuse sandbox-slug cwds (sbx- prefix + 7 hex chars). Callers should cd
  # into an app root before invoking this helper.
  if [[ "$DIR_NAME" =~ ^sbx-[a-z0-9]{7}$ ]]; then
    echo "" >&2
    echo "get_app_name: refusing to treat sandbox root as an app; cd into the app subfolder first or set ELLUL_APP_NAME" >&2
    return 1
  fi
  echo "$DIR_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//'
}
