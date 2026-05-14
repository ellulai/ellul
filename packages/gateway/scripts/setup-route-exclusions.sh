#!/usr/bin/env bash
#
# Sets up Cloudflare Workers route exclusions for subdomains that should
# bypass the gateway Worker entirely (zero invocations).
#
# Route exclusions can't be declared in wrangler.jsonc — they must be
# created via the Cloudflare API as routes with no associated script.
#
# Usage:
#   CLOUDFLARE_API_TOKEN=xxx ./scripts/setup-route-exclusions.sh
#
# Or if already authenticated via `wrangler login`, the token is read
# from ~/.wrangler/config/default.toml automatically.
#
set -euo pipefail

ZONE_ID="2f62da89620d46fe533128798048d24b"

# Resolve API token: env var > wrangler's own token (handles OAuth refresh)
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  # wrangler whoami triggers an OAuth token refresh if expired,
  # then we read the refreshed token from the config file.
  npx wrangler whoami >/dev/null 2>&1 || true
  for WRANGLER_CONFIG in \
    "$HOME/.wrangler/config/default.toml" \
    "$HOME/Library/Preferences/.wrangler/config/default.toml" \
    "${XDG_CONFIG_HOME:-$HOME/.config}/.wrangler/config/default.toml"; do
    if [ -f "$WRANGLER_CONFIG" ]; then
      # macOS grep doesn't support -P; use sed instead
      CLOUDFLARE_API_TOKEN=$(sed -n 's/^oauth_token *= *"\(.*\)"/\1/p' "$WRANGLER_CONFIG" 2>/dev/null || true)
      [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && break
    fi
  done
  if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
    echo "Error: CLOUDFLARE_API_TOKEN not set and no wrangler config found."
    echo "Run 'wrangler login' or export CLOUDFLARE_API_TOKEN."
    exit 1
  fi
fi

API="https://api.cloudflare.com/client/v4/zones/$ZONE_ID/workers/routes"
AUTH="Authorization: Bearer $CLOUDFLARE_API_TOKEN"

# Patterns to exclude (no Worker script — requests go direct to origin)
EXCLUSIONS=("api.ellul.ai/*")

echo "Fetching existing routes..."
EXISTING=$(curl -s -H "$AUTH" "$API")

for PATTERN in "${EXCLUSIONS[@]}"; do
  # Check if this exclusion route already exists (pattern with no script)
  EXISTS=$(echo "$EXISTING" | python3 -c "
import sys, json
data = json.load(sys.stdin)
routes = data.get('result', [])
for r in routes:
    if r.get('pattern') == '$PATTERN' and not r.get('script'):
        print('yes')
        break
else:
    print('no')
" 2>/dev/null || echo "no")

  if [ "$EXISTS" = "yes" ]; then
    echo "Route exclusion already exists: $PATTERN"
  else
    echo "Creating route exclusion: $PATTERN"
    RESULT=$(curl -s -X POST "$API" \
      -H "$AUTH" \
      -H "Content-Type: application/json" \
      -d "{\"pattern\": \"$PATTERN\"}")

    SUCCESS=$(echo "$RESULT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print('true' if data.get('success') else 'false')
" 2>/dev/null || echo "false")

    if [ "$SUCCESS" = "true" ]; then
      echo "Created route exclusion: $PATTERN"
    else
      echo "Failed to create route exclusion: $PATTERN"
      echo "$RESULT" | python3 -m json.tool 2>/dev/null || echo "$RESULT"
      exit 1
    fi
  fi
done

echo "Route exclusions configured."
