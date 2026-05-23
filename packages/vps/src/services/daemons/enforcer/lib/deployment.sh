#!/bin/bash
# Enforcer Deployment Functions
# Ensures base CORS headers are present in Caddyfile.
# Ensures gateway origin hostname is in Caddy site block addresses.
#
# Phase 4 cleanup: switch_deployment_model() was moved to the sovereign-shield
# bridge and is no longer processed by the enforcer. Deployment model switching
# (Cloudflare Edge / Direct Connect) is now handled via WebSocket bridge commands
# routed through sovereign-shield (port 3005) instead of heartbeat polling.

# Ensure gateway origin hostname is in Caddy site block addresses.
# Origin tag is identity-based (shortId) and immutable — written once at provision.
ensure_gateway_origin() {
  local CADDYFILE="/etc/caddy/Caddyfile"
  [ ! -f "$CADDYFILE" ] && return

  # Only for proxied model (has auto_https off and origin certs)
  grep -q 'auto_https off' "$CADDYFILE" 2>/dev/null || return
  grep -q 'origin-pull-ca.pem' "$CADDYFILE" 2>/dev/null || return

  local TAG
  TAG=$(cat /etc/ellul/origin-tag 2>/dev/null)
  [ -z "$TAG" ] && return

  local PLATFORM_ZONE
  PLATFORM_ZONE=$(cat /etc/ellul/platform-zone 2>/dev/null)
  [ -z "$PLATFORM_ZONE" ] && return
  local ORIGIN_AI="o-${TAG}.${PLATFORM_ZONE}"

  # Already patched? Skip.
  grep -q "$ORIGIN_AI" "$CADDYFILE" 2>/dev/null && return

  log "GATEWAY: Adding origin hostname ${ORIGIN_AI} to Caddyfile site blocks..."

  local TMPFILE
  TMPFILE=$(mktemp)

  local ZONE_ESC
  ZONE_ESC=$(echo "$PLATFORM_ZONE" | sed 's/\./\\./g')
  sed "s/\(\.${ZONE_ESC}:443\) {$/\1, ${ORIGIN_AI}:443 {/" "$CADDYFILE" \
    > "$TMPFILE"

  if caddy validate --config "$TMPFILE" --adapter caddyfile 2>/dev/null; then
    mv "$TMPFILE" "$CADDYFILE"
    chmod 644 "$CADDYFILE"
    caddy reload --config "$CADDYFILE" --adapter caddyfile --address unix//run/caddy/admin.sock 2>/dev/null || true
    log "GATEWAY: Origin hostname added and Caddy reloaded"
  else
    rm -f "$TMPFILE"
    log "GATEWAY: WARNING -- Caddy validation failed after adding origin hostname, reverted"
  fi
}

# Ensure gateway Host rewrite is present.
# The gateway Worker sends X-Forwarded-Host with the original hostname because
# resolveOverride rewrites the Host header to the origin hostname (o-{tag}.{zone}).
# This request_header directive restores the original Host so @code/@main/@dev matchers work.
# Only applies to gateway deployment model (mTLS + auto_https off).
ensure_gateway_host_rewrite() {
  local CADDYFILE="/etc/caddy/Caddyfile"
  [ ! -f "$CADDYFILE" ] && return

  # Only for proxied model
  grep -q 'auto_https off' "$CADDYFILE" 2>/dev/null || return
  grep -q 'origin-pull-ca.pem' "$CADDYFILE" 2>/dev/null || return

  # Already patched? Skip.
  grep -q 'request_header @has_xfh Host' "$CADDYFILE" 2>/dev/null && return

  local PLATFORM_ZONE APP_ZONE
  PLATFORM_ZONE=$(cat /etc/ellul/platform-zone 2>/dev/null)
  APP_ZONE=$(cat /etc/ellul/app-zone 2>/dev/null)
  [ -z "$PLATFORM_ZONE" ] && return

  log "GATEWAY: Adding Host rewrite from X-Forwarded-Host to Caddyfile..."

  local TMPFILE
  TMPFILE=$(mktemp)

  awk -v pz="$PLATFORM_ZONE" -v az="$APP_ZONE" '
    (index($0, pz ":443") > 0 || (az != "" && index($0, az ":443") > 0)) && /\{$/ && !done_block[NR] {
      print
      print "    @has_xfh header X-Forwarded-Host *"
      print "    request_header @has_xfh Host {http.request.header.X-Forwarded-Host}"
      done_block[NR] = 1
      next
    }
    { print }
  ' "$CADDYFILE" > "$TMPFILE"

  if caddy validate --config "$TMPFILE" --adapter caddyfile 2>/dev/null; then
    mv "$TMPFILE" "$CADDYFILE"
    chmod 644 "$CADDYFILE"
    caddy reload --config "$CADDYFILE" --adapter caddyfile --address unix//run/caddy/admin.sock 2>/dev/null || true
    log "GATEWAY: Host rewrite added and Caddy reloaded"
  else
    rm -f "$TMPFILE"
    log "GATEWAY: WARNING -- Caddy validation failed after adding Host rewrite, reverted"
  fi
}

# Ensure base CORS headers exist at the SITE BLOCK level of every site block.
# Site-block-level CORS covers ALL responses -- including 502s from downed backends,
# unmatched hosts, deployed app handlers, and any future routes.
# Old servers may have CORS only inside handle @code / handle @main (8-space indent);
# this function adds site-level CORS (4-space indent) which supersedes those.
# Runs on every heartbeat -- idempotent, skips instantly if already patched.
ensure_cors_headers() {
  local CADDYFILE="/etc/caddy/Caddyfile"
  [ ! -f "$CADDYFILE" ] && return

  grep -q '^    # Base CORS for dashboard' "$CADDYFILE" 2>/dev/null && return

  local PLATFORM_ZONE CONSOLE_ORIGIN
  PLATFORM_ZONE=$(cat /etc/ellul/platform-zone 2>/dev/null)
  CONSOLE_ORIGIN=$(cat /etc/ellul/console-origin 2>/dev/null)
  [ -z "$PLATFORM_ZONE" ] || [ -z "$CONSOLE_ORIGIN" ] && return

  grep -q "$PLATFORM_ZONE" "$CADDYFILE" 2>/dev/null || return

  log "CORS: Patching site-block-level CORS headers into Caddyfile..."

  local TMPFILE
  TMPFILE=$(mktemp)

  awk -v console_origin="$CONSOLE_ORIGIN" '
    /^[^ {].*\{$/ { in_block = 1; block_patched = 0 }
    /^\}/ { in_block = 0 }

    in_block && !block_patched && /^    @(has_xfh|code|main|dev) / {
      print "    # Base CORS for dashboard -- ensure allow-origin on all responses"
      printf "    header ?Access-Control-Allow-Origin \"%s\"\n", console_origin
      print "    header ?Access-Control-Allow-Credentials \"true\""
      block_patched = 1
    }
    in_block && !block_patched && /^    import \/etc\/caddy\/app-routes/ {
      print "    # Base CORS for dashboard -- ensure allow-origin on all responses"
      printf "    header ?Access-Control-Allow-Origin \"%s\"\n", console_origin
      print "    header ?Access-Control-Allow-Credentials \"true\""
      block_patched = 1
    }
    { print }
  ' "$CADDYFILE" > "$TMPFILE"

  if caddy validate --config "$TMPFILE" --adapter caddyfile 2>/dev/null; then
    mv "$TMPFILE" "$CADDYFILE"
    chmod 644 "$CADDYFILE"
    caddy reload --config "$CADDYFILE" --adapter caddyfile --address unix//run/caddy/admin.sock 2>/dev/null || true
    log "CORS: Site-block-level CORS patched and Caddy reloaded"
  else
    rm -f "$TMPFILE"
    log "CORS: WARNING -- Caddy validation failed after CORS patch, reverted"
  fi
}


# Commands now flow through the command queue (API → DB → enforcer poll → file-api).
# Daemon site block (daemon.caddy) is cleaned up on self-update.

