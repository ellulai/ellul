#!/bin/bash
set -euo pipefail
# ellul-gbrain-init — gbrain bootstrap + lifecycle (runs as root via sudo).
# Subcommands:
#   (none)  — idempotent first-time init: DB + credentials + systemd unit fix
#   --wipe  — drop + recreate the gbrain database (preserves credentials)

GBRAIN_DIR="/opt/ellul/gbrain"
CONFIG_DIR="/etc/ellul/gbrain"
ENV_FILE="$CONFIG_DIR/env"
DB_PASS_FILE="$CONFIG_DIR/db-password"
TOKEN_FILE="$CONFIG_DIR/access-token"
UNIT_FILE="/etc/systemd/system/ellul-gbrain.service"

log() { echo "[gbrain-init] $*"; }

if [ ! -f "$GBRAIN_DIR/src/cli.ts" ]; then
  log "ERROR: gbrain not pre-installed at $GBRAIN_DIR"
  exit 1
fi

if ! systemctl is-active --quiet postgresql 2>/dev/null; then
  log "ERROR: postgresql is not running"
  exit 1
fi

mkdir -p "$CONFIG_DIR"

# ── --wipe: drop + recreate database ──
if [ "${1:-}" = "--wipe" ]; then
  runuser -u postgres -- psql -c 'DROP DATABASE IF EXISTS gbrain;' 2>/dev/null || true
  runuser -u postgres -- psql -c 'DROP ROLE IF EXISTS gbrain_app;' 2>/dev/null || true
  rm -f "$DB_PASS_FILE" "$ENV_FILE"
  log "Database and credentials wiped — will recreate below"
fi

# ── Generate DB password if missing ──
if [ ! -f "$DB_PASS_FILE" ]; then
  head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32 > "$DB_PASS_FILE"
  chmod 600 "$DB_PASS_FILE"
  chown root:root "$DB_PASS_FILE"
  log "Generated database password"
fi

GBRAIN_DB_PASS=$(cat "$DB_PASS_FILE")

# ── Create role + database (idempotent) ──
runuser -u postgres -- psql -v ON_ERROR_STOP=0 << GBRAINSQL 2>/dev/null
DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gbrain_app') THEN
      CREATE ROLE gbrain_app LOGIN BYPASSRLS PASSWORD '${GBRAIN_DB_PASS}';
    ELSE
      ALTER ROLE gbrain_app PASSWORD '${GBRAIN_DB_PASS}';
      ALTER ROLE gbrain_app BYPASSRLS;
    END IF;
  END \$\$;

-- gbrain migrations create event triggers for auto-RLS. PG 17+ has
-- pg_create_event_trigger; PG 16 requires SUPERUSER. The role is
-- localhost-only with token-gated HTTP access — SUPERUSER is safe here.
ALTER ROLE gbrain_app SUPERUSER;

SELECT 'CREATE DATABASE gbrain OWNER gbrain_app' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'gbrain')
\gexec
GBRAINSQL
log "PostgreSQL role + database ready"

runuser -u postgres -- psql -d gbrain -c 'CREATE EXTENSION IF NOT EXISTS vector;' 2>/dev/null || log "WARN: pgvector extension install failed"

# ── Write env file ──
cat > "$ENV_FILE" << ENVEOF
GBRAIN_DATABASE_URL=postgresql://gbrain_app:${GBRAIN_DB_PASS}@127.0.0.1:5432/gbrain
ENVEOF
chmod 600 "$ENV_FILE"
chown root:root "$ENV_FILE"
log "Env file written"

# ── Generate access token if missing ──
TOKEN_CREATED=false
if [ ! -f "$TOKEN_FILE" ]; then
  head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 48 > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
  chown root:root "$TOKEN_FILE"
  TOKEN_CREATED=true
  log "Generated access token"
fi

# ── Register token in gbrain's access_tokens table ──
# gbrain validates Bearer tokens by SHA-256 hash lookup in this table.
# The table may not exist yet (created by gbrain's schema migration on
# first start), so we create it idempotently here.
GBRAIN_TOKEN=$(cat "$TOKEN_FILE")
GBRAIN_TOKEN_HASH=$(printf '%s' "$GBRAIN_TOKEN" | openssl dgst -sha256 -hex 2>/dev/null | awk '{print $NF}')
runuser -u postgres -- psql -d gbrain -v ON_ERROR_STOP=0 << TOKENSQL 2>/dev/null
CREATE TABLE IF NOT EXISTS access_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  permissions  JSONB,
  scopes       TEXT[],
  created_at   TIMESTAMPTZ DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);
INSERT INTO access_tokens (name, token_hash)
  VALUES ('agent-bridge', '${GBRAIN_TOKEN_HASH}')
  ON CONFLICT (token_hash) DO NOTHING;
TOKENSQL
log "Access token registered in database"

# ── Copy token to bridge-readable path ──
# The bridge runs as SVC_USER and cannot read root:root 600 files.
# /etc/ellul/agent-bridge/ is already bridge-owned territory.
BRIDGE_TOKEN_PATH="/etc/ellul/agent-bridge/gbrain-token"
mkdir -p /etc/ellul/agent-bridge
cat "$TOKEN_FILE" > "$BRIDGE_TOKEN_PATH"
chmod 644 "$BRIDGE_TOKEN_PATH"
log "Token copied to bridge-readable path"

# ── Fix stale systemd unit if needed ──
UNIT_CHANGED=false
if [ -f "$UNIT_FILE" ]; then
  if grep -q 'src/index.ts' "$UNIT_FILE"; then
    sed -i 's|src/index\.ts|src/cli.ts|g' "$UNIT_FILE"
    UNIT_CHANGED=true
    log "Fixed systemd unit entry point (index.ts → cli.ts)"
  fi
  if grep -q 'ExecStartPre=.*migrate' "$UNIT_FILE"; then
    sed -i '/ExecStartPre=.*migrate/d' "$UNIT_FILE"
    UNIT_CHANGED=true
    log "Removed stale ExecStartPre migrate (serve handles schema internally)"
  fi
  if ! grep -q '/root' "$UNIT_FILE"; then
    sed -i 's|^ReadWritePaths=.*|& /root|' "$UNIT_FILE"
    UNIT_CHANGED=true
    log "Added /root to ReadWritePaths (bun cache)"
  fi
  if ! grep -q 'StandardError=' "$UNIT_FILE"; then
    sed -i "/^ExecStart=/a StandardOutput=append:${CONFIG_DIR}/service.log\nStandardError=append:${CONFIG_DIR}/service.log" "$UNIT_FILE"
    UNIT_CHANGED=true
    log "Added service log capture"
  fi
  if grep -q 'BUN_JSC_MAX_HEAP_SIZE' "$UNIT_FILE"; then
    sed -i '/BUN_JSC_MAX_HEAP_SIZE/d' "$UNIT_FILE"
    UNIT_CHANGED=true
    log "Removed invalid BUN_JSC_MAX_HEAP_SIZE (unsupported in Bun 1.2+)"
  fi
  if grep -q 'ellul-control-plane.slice' "$UNIT_FILE"; then
    sed -i 's|ellul-control-plane.slice|ellul.slice|' "$UNIT_FILE"
    UNIT_CHANGED=true
    log "Moved gbrain out of control-plane slice (reduces memory pressure on bridge)"
  fi
  if [ "$UNIT_CHANGED" = true ]; then
    systemctl daemon-reload
  fi
fi

# ── Clean up stale heap.env (BUN_JSC_MAX_HEAP_SIZE unsupported in Bun 1.2+) ──
rm -f "$CONFIG_DIR/heap.env"

touch "$CONFIG_DIR/service.log"
chmod 644 "$CONFIG_DIR/service.log"

log "Initialization complete"
