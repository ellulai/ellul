
# --- Phase 1: Regenerate Caddyfile BEFORE restarting anything ---
# Config must be on disk before Caddy starts, or it boots with stale domain.
CADDY_REGEN=false
if [ -n "$DOMAIN" ]; then
  SHORT_ID="${SERVER_ID:0:8}"

  # Resolve deployment model: explicit param → metadata.json → Caddyfile heuristic
  MODEL="$DEPLOYMENT_MODEL"
  if [ -z "$MODEL" ] && [ -f /opt/ellul/metadata.json ]; then
    MODEL=$(jq -r '.deployment_model // empty' /opt/ellul/metadata.json 2>/dev/null)
  fi
  if [ -z "$MODEL" ]; then
    # Fallback: detect from Caddyfile (auto_https off = proxied, else = direct)
    MODEL="proxied"
    if [ -f /etc/caddy/Caddyfile ]; then
      if ! grep -q "auto_https off" /etc/caddy/Caddyfile 2>/dev/null; then
        MODEL="direct"
      fi
    fi
  fi

  _PZ=$(cat /etc/ellul/platform-zone 2>/dev/null)
  _AZ=$(cat /etc/ellul/app-zone 2>/dev/null)
  [ -z "$_PZ" ] || [ -z "$_AZ" ] && { log "FATAL: platform-zone or app-zone missing"; exit 1; }
  if [ "$MODEL" = "direct" ]; then
    CODE_DOMAIN="${SHORT_ID}-dcode.${_PZ}"
    DEV_DOMAIN="${SHORT_ID}-ddev.${_AZ}"
  else
    CODE_DOMAIN="${SHORT_ID}-code.${_PZ}"
    DEV_DOMAIN="${SHORT_ID}-dev.${_AZ}"
  fi

  # ── Ensure origin certs exist before caddy-gen ──
  # On wake/migration, origin certs may not exist yet in the vault.
  # Without them, caddy validate fails and no Caddyfile is written.
  # Extract from metadata.json (written by cloud-init) as a fallback.
  if [ "$MODEL" != "direct" ]; then
    if [ ! -f /etc/caddy/origin.crt ] && [ -f /opt/ellul/metadata.json ]; then
      log "Origin certs missing — extracting from metadata.json"
      _OC=$(jq -r '.cf_origin_cert // empty' /opt/ellul/metadata.json 2>/dev/null)
      _OK=$(jq -r '.cf_origin_key // empty' /opt/ellul/metadata.json 2>/dev/null)
      if [ -n "$_OC" ] && [ -n "$_OK" ]; then
        echo "$_OC" > /etc/caddy/origin.crt
        echo "$_OK" > /etc/caddy/origin.key
        chmod 640 /etc/caddy/origin.key
        chown caddy:caddy /etc/caddy/origin.crt /etc/caddy/origin.key
        log "Origin certs written from metadata.json"
      fi
    fi
    if [ ! -f /etc/caddy/cf-origin-pull-ca.pem ]; then
      # Cloudflare Authenticated Origin Pulls CA — public cert, safe to download
      curl -sf --max-time 10 "https://developers.cloudflare.com/ssl/static/authenticated_origin_pull_ca.pem" \
        -o /etc/caddy/cf-origin-pull-ca.pem 2>/dev/null && \
        chown caddy:caddy /etc/caddy/cf-origin-pull-ca.pem && \
        log "AOP CA cert downloaded" || \
        log "WARN: AOP CA cert download failed (caddy validate may fail)"
    fi
  fi

  # Validate domain format before passing to caddy-gen
  if ! echo "$DOMAIN" | grep -qE '^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,}$'; then
    log "ERROR: Invalid domain format — rejecting"
    exit 1
  fi

  # Atomic write: generate to .tmp, validate, then mv into place.
  # stdout -> .tmp (the Caddyfile), stderr -> script stderr (visible in logs)
  if node /usr/local/bin/ellul-caddy-gen --model "$MODEL" --main-domain "$DOMAIN" --code-domain "$CODE_DOMAIN" --dev-domain "$DEV_DOMAIN" > /etc/caddy/Caddyfile.tmp; then
    # Ensure /run/caddy exists for admin socket validation (tmpfs, may not survive reboot/migration)
    mkdir -p /run/caddy && chown caddy:caddy /run/caddy && chmod 2770 /run/caddy
    # Validate BEFORE moving -- never overwrite with a broken config.
    # Retry once after 5s if validation fails — sovereign-shield may still be
    # generating origin certs or the AOP CA download may be in flight.
    _caddy_valid=false
    for _cv_attempt in 1 2; do
      if caddy validate --config /etc/caddy/Caddyfile.tmp --adapter caddyfile >/dev/null 2>&1; then
        _caddy_valid=true
        break
      fi
      if [ $_cv_attempt -eq 1 ]; then
        log "WARN: Caddyfile validation failed (attempt 1/2), retrying in 5s..."
        sleep 5
      fi
    done

    if [ "$_caddy_valid" = "true" ]; then
      mv /etc/caddy/Caddyfile.tmp /etc/caddy/Caddyfile
      # 664 (caddy group-writable) — see caddy-main.sh for rationale:
      # shield-runner is in the caddy group and needs to overwrite this
      # file from its startup regen path. 644 leaves shield-runner
      # read-only → `caddyfile-regen: skipped — EACCES`.
      chown caddy:caddy /etc/caddy/Caddyfile 2>/dev/null || true
      chmod 664 /etc/caddy/Caddyfile
      CADDY_REGEN=true
      log "Caddyfile regenerated and validated (model=$MODEL)"
    else
      log "ERROR: generated Caddyfile failed validation after 2 attempts, keeping existing"
      rm -f /etc/caddy/Caddyfile.tmp
      FAILURES="${FAILURES} caddy-config"
    fi
  else
    log "ERROR: caddy-gen failed, keeping existing Caddyfile"
    rm -f /etc/caddy/Caddyfile.tmp
    FAILURES="${FAILURES} caddy-gen"
  fi
fi
