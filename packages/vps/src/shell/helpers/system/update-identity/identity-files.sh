
# Identity files live on boot partition (never vault-bound)
IDENTITY_DIR="/etc/ellul-bootstrap"
mkdir -p "$IDENTITY_DIR" 2>/dev/null

# Update server-id (used by heartbeat signing + vps-event webhooks)
echo -n "$SERVER_ID" > "$IDENTITY_DIR/server-id"

# Update domain + dev-domain if provided
if [ -n "$DOMAIN" ]; then
  echo -n "$DOMAIN" > /etc/ellul/domain
  _APP_ZONE=$(cat /etc/ellul/app-zone 2>/dev/null)
  [ -z "$_APP_ZONE" ] && { echo "FATAL: /etc/ellul/app-zone missing"; exit 1; }
  echo -n "${SERVER_ID:0:8}-dev.${_APP_ZONE}" > /etc/ellul/dev-domain
fi

# Update owner.lock (used by sovereign-shield for ownership verification)
# File may be immutable (chattr +i) -- remove flag first, write, re-lock
if [ -n "$USER_ID" ]; then
  chattr -i /etc/ellul/owner.lock 2>/dev/null || true
  echo -n "$USER_ID" > /etc/ellul/owner.lock
  chmod 400 /etc/ellul/owner.lock
  chattr +i /etc/ellul/owner.lock 2>/dev/null || true
fi

# Update billing tier
if [ -n "$BILLING_TIER" ]; then
  echo -n "$BILLING_TIER" > /etc/ellul/billing-tier
fi

# Update product type
if [ -n "$PRODUCT" ]; then
  echo -n "$PRODUCT" > /etc/ellul/product
fi

# Update security tier (e.g. web_locked carries over from old server)
if [ -n "$SECURITY_TIER" ]; then
  echo -n "$SECURITY_TIER" > /etc/ellul/security-tier
fi

# Update locale intent so the enforcer's reconciler propagates it on the
# next heartbeat tick. Closes the cold-wake gap where a JP user claiming
# a pool server saw EN MOTD until they opened the chat iframe (which
# would have written the same intent file). shield-data is
# shield-runner:shield-runner 700 — root writes through. See ADR 0001.
if [ -n "$USER_LOCALE" ]; then
  case "$USER_LOCALE" in
    en|ja|ko|de|pt-BR|fr)
      printf '%s\n' "$USER_LOCALE" > /etc/ellul/shield-data/user-locale 2>/dev/null && {
        chmod 644 /etc/ellul/shield-data/user-locale 2>/dev/null || true
        chown shield-runner:shield-runner /etc/ellul/shield-data/user-locale 2>/dev/null || true
      }
      ;;
    *)
      # Unknown value from the wake command — ignore. The enforcer's
      # validator would reject it anyway; better to refuse at write time.
      ;;
  esac
fi

# Update metadata.json to keep it consistent with identity files
if [ -f /opt/ellul/metadata.json ]; then
  jq --arg sid "$SERVER_ID" \
     --arg dom "${DOMAIN:-$(jq -r '.domain // empty' /opt/ellul/metadata.json)}" \
     --arg uid "${USER_ID:-$(jq -r '.user_id // empty' /opt/ellul/metadata.json)}" \
     --arg dm "${DEPLOYMENT_MODEL:-$(jq -r '.deployment_model // empty' /opt/ellul/metadata.json)}" \
     --arg prod "${PRODUCT:-$(jq -r '.product // empty' /opt/ellul/metadata.json)}" \
     '.server_id=$sid | .domain=$dom | .user_id=$uid | .deployment_model=$dm | .product=$prod' \
     /opt/ellul/metadata.json > /opt/ellul/metadata.json.tmp \
  && mv /opt/ellul/metadata.json.tmp /opt/ellul/metadata.json \
  && chmod 600 /opt/ellul/metadata.json \
  || true
fi

# Regenerate Ed25519 heartbeat keypair (new identity = new keys)
openssl genpkey -algorithm Ed25519 -out "$IDENTITY_DIR/heartbeat.key" 2>/dev/null
openssl pkey -in "$IDENTITY_DIR/heartbeat.key" -pubout -out "$IDENTITY_DIR/heartbeat.pub" 2>/dev/null
chmod 600 "$IDENTITY_DIR/heartbeat.key"
chmod 644 "$IDENTITY_DIR/heartbeat.pub"

# Sync /etc/default/ellul: update server-id and domain only.
# The ai-proxy-token in env is the TEMP server's token — leave it as-is.
# The DB swap uses the temp server's aiProxyTokenHash, so env and DB match.
# Also update the vault's ai-proxy-token file to match the env token,
# so after reboot (fstab bind mount) the token stays consistent.
if [ -f /etc/default/ellul ]; then
  sed -i "s|^ELLUL_SERVER_ID=.*|ELLUL_SERVER_ID=$SERVER_ID|" /etc/default/ellul
  if [ -z "$DOMAIN" ]; then echo "FATAL: DOMAIN not set for identity update"; exit 1; fi
  sed -i "s|^ELLUL_DOMAIN=.*|ELLUL_DOMAIN=${DOMAIN}|" /etc/default/ellul

  # Write token to boot partition (never vault-bound, survives vault restore)
  ENV_TOKEN=$(grep '^ELLUL_AI_TOKEN=' /etc/default/ellul-secrets 2>/dev/null | cut -d= -f2 || true)
  if [ -n "$ENV_TOKEN" ]; then
    echo -n "$ENV_TOKEN" > "$IDENTITY_DIR/ai-proxy-token"
    chmod 640 "$IDENTITY_DIR/ai-proxy-token"
    chown root:shield "$IDENTITY_DIR/ai-proxy-token" 2>/dev/null || true
  fi
fi
