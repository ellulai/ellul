#!/bin/bash
# Enforcer Heartbeat Functions
# Heartbeat, sync, and communication with ellul.ai API.

# Get all listening TCP ports (for ghost port detection)
get_active_ports() {
  get_listening_ports
}

# ── Identity on boot partition ───────────────────────────────────────
# Identity files live on /etc/ellul-bootstrap/ (root FS, never vault-bound).
# This means vault restore can never overwrite identity — no caching needed,
# no SKIP_VAULT_RESTORE, no race conditions. Clean separation:
#   /etc/ellul-bootstrap/ = per-boot identity (keys, tokens, server-id)
#   /etc/ellul/           = persistent user data (vault-bound: passkeys, secrets, config)
IDENTITY_DIR="/etc/ellul-bootstrap"

# Get auth token
get_token() {
  if [ -z "$TOKEN" ]; then
    # Read from boot partition (authoritative, never vault-bound)
    TOKEN=$(cat "$IDENTITY_DIR/ai-proxy-token" 2>/dev/null | tr -d '[:space:]' || true)
  fi
  echo "$TOKEN"
}

# ML-DSA-44 heartbeat signing (Phase 4: post-quantum asymmetric auth, FIPS 204)
# Signs timestamp:serverId with ML-DSA-44 private key. API verifies with stored public key.
# Compromised API cannot forge heartbeats -- only the VPS holds the private key.
# ML-DSA-44 replaces Ed25519 for quantum resistance (SNDL protection).
HEARTBEAT_KEY_FILE="$IDENTITY_DIR/heartbeat.key.json"
HEARTBEAT_PUB_FILE="$IDENTITY_DIR/heartbeat.pub.json"
SERVER_ID_FILE="$IDENTITY_DIR/server-id"
CRYPTO_BIN="/usr/local/bin/ellul-crypto"
COMMAND_SIGNING_PUBKEY_FILE="/etc/ellul/command-signing.pub"

# Compute ML-DSA-44 signature for heartbeat
# Sets: HB_SIGNATURE, HB_TIMESTAMP, HB_SERVER_ID, HB_PUBKEY
compute_heartbeat_signature() {
  HB_SIGNATURE=""
  HB_TIMESTAMP=""
  HB_SERVER_ID=""
  HB_PUBKEY=""

  [ ! -f "$HEARTBEAT_KEY_FILE" ] && return
  [ ! -x "$CRYPTO_BIN" ] && return

  HB_TIMESTAMP=$(date +%s)
  HB_SERVER_ID=$(cat "$SERVER_ID_FILE" 2>/dev/null | tr -d '\n')
  [ -z "$HB_SERVER_ID" ] && return

  local SIGN_DATA="${HB_TIMESTAMP}:${HB_SERVER_ID}"
  local SIGN_TMP=$(mktemp)
  printf '%s' "$SIGN_DATA" > "$SIGN_TMP"
  HB_SIGNATURE=$("$CRYPTO_BIN" sign --key "$HEARTBEAT_KEY_FILE" --input "$SIGN_TMP" --algorithm mldsa44 2>/dev/null || echo "")
  rm -f "$SIGN_TMP"

  # Read public key JSON for first-write-wins registration (base64-encoded for HTTP header safety)
  if [ -f "$HEARTBEAT_PUB_FILE" ]; then
    HB_PUBKEY=$(b64_encode_file "$HEARTBEAT_PUB_FILE" 2>/dev/null || echo "")
  fi
}

# Execute curl with optional ML-DSA-44 signature headers
# Usage: heartbeat_curl <url> <payload>
heartbeat_curl() {
  local HB_URL="$1"
  local HB_PAYLOAD="$2"
  local HB_CURL_ARGS=()

  local HB_BODY_FILE=/run/ellul-heartbeat-body
  HB_CURL_ARGS+=(-s -o "$HB_BODY_FILE" -w "%{http_code}" --connect-timeout 5 --max-time 10)
  HB_CURL_ARGS+=("$HB_URL" -X POST)
  HB_CURL_ARGS+=(-H "Authorization: Bearer $TOKEN")
  HB_CURL_ARGS+=(-H "Content-Type: application/json")

  # ML-DSA-44 signature headers (present when keypair exists)
  if [ -n "$HB_SIGNATURE" ]; then
    HB_CURL_ARGS+=(-H "X-Heartbeat-Signature: $HB_SIGNATURE")
    HB_CURL_ARGS+=(-H "X-Heartbeat-Timestamp: $HB_TIMESTAMP")
    HB_CURL_ARGS+=(-H "X-Server-Id: $HB_SERVER_ID")
    if [ -n "$HB_PUBKEY" ]; then
      HB_CURL_ARGS+=(-H "X-Heartbeat-Public-Key: $HB_PUBKEY")
    fi
  fi

  HB_CURL_ARGS+=(-d "$HB_PAYLOAD")
  curl "${HB_CURL_ARGS[@]}" 2>/dev/null
}

# ── Signed API Request ──────────────────────────────────────────────────
# Generic function for ALL outbound API calls. Computes a fresh ML-DSA-44
# signature and attaches X-Heartbeat-Signature / X-Heartbeat-Timestamp /
# X-Server-Id headers alongside the Bearer token.
#
# Usage: signed_api_request [curl args...]
# Examples:
#   signed_api_request -s -o /dev/null -w "%{http_code}" "$API_URL/api/servers/commands"
#   signed_api_request -s -o /dev/null -w "%{http_code}" -X POST -d "$PAYLOAD" "$API_URL/api/servers/log-drain"
#
# The function inserts Authorization, Content-Type, and signature headers
# automatically. Callers must NOT pass -H "Authorization: ..." themselves.
signed_api_request() {
  local SA_CURL_ARGS=()

  # Auth header
  local SA_TOKEN=$(get_token)
  SA_CURL_ARGS+=(-H "Authorization: Bearer $SA_TOKEN")
  SA_CURL_ARGS+=(-H "Content-Type: application/json")

  # Compute fresh ML-DSA-44 signature for this request
  if [ -f "$HEARTBEAT_KEY_FILE" ] && [ -x "$CRYPTO_BIN" ]; then
    local SA_TIMESTAMP=$(date +%s)
    local SA_SERVER_ID=$(cat "$SERVER_ID_FILE" 2>/dev/null | tr -d '\n')
    if [ -n "$SA_SERVER_ID" ]; then
      local SA_SIGN_DATA="${SA_TIMESTAMP}:${SA_SERVER_ID}"
      local SA_SIGN_TMP=$(mktemp)
      printf '%s' "$SA_SIGN_DATA" > "$SA_SIGN_TMP"
      local SA_SIGNATURE=$("$CRYPTO_BIN" sign --key "$HEARTBEAT_KEY_FILE" --input "$SA_SIGN_TMP" --algorithm mldsa44 2>/dev/null || echo "")
      rm -f "$SA_SIGN_TMP"
      if [ -n "$SA_SIGNATURE" ]; then
        SA_CURL_ARGS+=(-H "X-Heartbeat-Signature: $SA_SIGNATURE")
        SA_CURL_ARGS+=(-H "X-Heartbeat-Timestamp: $SA_TIMESTAMP")
        SA_CURL_ARGS+=(-H "X-Server-Id: $SA_SERVER_ID")
      else
        log "WARN: signed_api_request: ML-DSA-44 signing failed — request will be rejected by API"
      fi
    fi
  fi

  # Pass through all caller-provided args (URL, method, data, output flags, etc.)
  curl "${SA_CURL_ARGS[@]}" "$@" 2>/dev/null
}

# Main heartbeat — event-driven push with local enforcement every tick.
# Collects telemetry locally every 10s but only pushes to the API when
# state actually changes or a forced resync timer fires (every 60 ticks
# = ~10 min). Local enforcement runs unconditionally every tick.
# SIGUSR1 from the API (via file-api) sets WAKEUP=1 in the main loop,
# which forces an immediate push regardless of delta.
heartbeat_raw() {
  local TOKEN=$(get_token)
  [ -z "$TOKEN" ] && { log "Error: ELLUL_AI_TOKEN not set"; return 1; }
  local ACTIVE_SESSIONS=$(get_active_sessions)
  local RAM_USAGE=$(get_ram_usage)
  local CPU_USAGE=$(get_cpu_usage)
  local DEPLOYED_APPS=$(get_deployed_apps)
  local SSH_KEY_COUNT=$(get_ssh_key_count)
  local OPEN_PORTS=$(get_active_ports)
  local CURRENT_TAG=$(cat "$AGENT_VERSION_FILE" 2>/dev/null | tr -d '\n')
  local SETTINGS_FILE="/etc/ellul/shield-data/settings.json"
  local LOCAL_TERMINAL=$(jq -r '.terminalEnabled // true' "$SETTINGS_FILE" 2>/dev/null || echo "true")
  local LOCAL_SSH=$(jq -r '.sshEnabled // false' "$SETTINGS_FILE" 2>/dev/null || echo "false")
  local CHAIN_HEAD=$(cat /etc/ellul/shield-data/audit-chain-head 2>/dev/null || echo '{"seq":0,"hash":"genesis"}')
  local AGENT_STATUS=$(get_agent_status)
  local CHAIN_REJECTION="null"
  if [ -f /run/ellul-agent-sync-chain-rejection ]; then
    CHAIN_REJECTION=$(cat /run/ellul-agent-sync-chain-rejection 2>/dev/null)
    [ -z "$CHAIN_REJECTION" ] && CHAIN_REJECTION="null"
  fi
  local KR_VER=2
  if [ -f "$COMMAND_SIGNING_PUBKEY_FILE" ]; then
    KR_VER=$(jq -r '.version // 2' "$COMMAND_SIGNING_PUBKEY_FILE" 2>/dev/null)
  fi
  local SEC_TIER=$(detect_security_tier)
  local SEC_DEGRADED_BOOL=$([ "$SECURITY_DEGRADED" = true ] && echo true || echo false)
  local PAYLOAD=$(jq -n \
    --argjson activeSessions "$ACTIVE_SESSIONS" \
    --argjson deployments "$DEPLOYED_APPS" \
    --arg ramUsage "$RAM_USAGE" \
    --arg cpuUsage "$CPU_USAGE" \
    --arg securityTier "$SEC_TIER" \
    --arg sshKeyCount "$SSH_KEY_COUNT" \
    --arg openPorts "$OPEN_PORTS" \
    --arg currentTag "${CURRENT_TAG:-}" \
    --arg localTerminal "$LOCAL_TERMINAL" \
    --arg localSsh "$LOCAL_SSH" \
    --argjson auditChainHead "$CHAIN_HEAD" \
    --argjson agentStatus "$AGENT_STATUS" \
    --argjson chainRejection "$CHAIN_REJECTION" \
    --argjson securityViolations "$SECURITY_VIOLATION_COUNT" \
    --argjson securityCritical "$SECURITY_CRITICAL_COUNT" \
    --argjson securityWarning "$SECURITY_WARNING_COUNT" \
    --argjson securityDegraded "$SEC_DEGRADED_BOOL" \
    --argjson keyringVersion "$KR_VER" \
    '{activeSessions: $activeSessions, deployments: $deployments, ramUsage: ($ramUsage | tonumber), cpuUsage: ($cpuUsage | tonumber), securityTier: $securityTier, sshKeyCount: ($sshKeyCount | tonumber), open_ports: ($openPorts | split(",") | map(select(. != "") | tonumber)), currentTag: $currentTag, secretsLocal: true, localTerminalEnabled: ($localTerminal == "true"), localSshEnabled: ($localSsh == "true"), auditChainHead: $auditChainHead, agentStatus: $agentStatus, chainRejection: $chainRejection, securityViolations: $securityViolations, securityCritical: $securityCritical, securityWarning: $securityWarning, securityDegraded: $securityDegraded, keyringVersion: $keyringVersion}')

  # ── Delta detection: only push to API when state actually changes ────
  # Quantize CPU/RAM to 5% buckets so gradual drift does not trigger
  # pushes. Everything else is hashed verbatim — port changes,
  # deployments, agent status, security tier, settings all produce an
  # immediate push.
  local _HB_DIR="/var/lib/ellul"
  mkdir -p "$_HB_DIR" 2>/dev/null
  local _CPU_Q=$(( $(printf '%.0f' "$CPU_USAGE") / 5 * 5 ))
  local _RAM_Q=$(( $(printf '%.0f' "$RAM_USAGE") / 5 * 5 ))
  local _DELTA_INPUT="${_CPU_Q}|${_RAM_Q}|${OPEN_PORTS}|${DEPLOYED_APPS}|${AGENT_STATUS}|${LOCAL_TERMINAL}|${LOCAL_SSH}|${SEC_TIER}|${SSH_KEY_COUNT}|${CURRENT_TAG:-}|${CHAIN_HEAD}|${CHAIN_REJECTION}|${KR_VER}|${SECURITY_VIOLATION_COUNT:-0}|${SECURITY_CRITICAL_COUNT:-0}|${SECURITY_WARNING_COUNT:-0}|${SEC_DEGRADED_BOOL}"
  local _CUR_HASH=$(printf '%s' "$_DELTA_INPUT" | sha256sum | cut -d' ' -f1)
  local _PREV_HASH=$(cat "$_HB_DIR/delta-hash" 2>/dev/null | tr -d '[:space:]' || echo "")
  local _TICK=$(cat "$_HB_DIR/delta-tick" 2>/dev/null | tr -d '[:space:]' || echo "0")
  case "$_TICK" in (*[!0-9]*|"") _TICK=0 ;; esac

  local _SHOULD_PUSH="false"
  local _PUSH_REASON=""
  if [ "$_CUR_HASH" != "$_PREV_HASH" ]; then
    _SHOULD_PUSH="true"
    _PUSH_REASON="state_changed"
  elif [ "$_TICK" -ge "$FULL_RESYNC_INTERVAL_TICKS" ]; then
    _SHOULD_PUSH="true"
    _PUSH_REASON="forced_resync"
  elif [ "${WAKEUP:-0}" -eq 1 ]; then
    _SHOULD_PUSH="true"
    _PUSH_REASON="sigusr1_push"
  elif [ "${HEARTBEAT_FAILURES:-0}" -gt 0 ]; then
    _SHOULD_PUSH="true"
    _PUSH_REASON="retry_after_failure"
  elif [ -f /etc/ellul/boot-failures ] || [ -f /etc/ellul/pg-recovery-events ]; then
    _SHOULD_PUSH="true"
    _PUSH_REASON="pending_events"
  fi

  # ── Local enforcement runs every tick regardless of push decision ────
  local TERMINAL_ENABLED=$(jq -r '.terminalEnabled // "true"' "$SETTINGS_FILE" 2>/dev/null || echo "true")
  local SSH_ENABLED=$(jq -r '.sshEnabled // "false"' "$SETTINGS_FILE" 2>/dev/null || echo "false")
  enforce_settings "$TERMINAL_ENABLED" "$SSH_ENABLED"
  enforce_features
  enforce_caddy_permissions
  check_security_invariants
  if [ "${DEFERRED_ENFORCER_RESTART:-}" = "true" ]; then
    DEFERRED_ENFORCER_RESTART=false
    log "SECURITY: deferred enforcer self-restart to purge stale env secrets"
    exec systemctl restart ellul-enforcer
  fi
  ensure_cors_headers
  ensure_gateway_host_rewrite
  ensure_gateway_origin

  # ── Write local status every tick (WebSocket broadcast, no API call) ─
  write_local_status "$CPU_USAGE" "$RAM_USAGE" "$ACTIVE_SESSIONS" "$TERMINAL_ENABLED" "$SSH_ENABLED"

  if [ "$_SHOULD_PUSH" = "false" ]; then
    printf '%s' "$((_TICK + 1))" > "$_HB_DIR/delta-tick" 2>/dev/null || true
    LOG_SHIP_COUNTER=$((${LOG_SHIP_COUNTER:-0} + 1))
    if [ $LOG_SHIP_COUNTER -ge 5 ]; then
      LOG_SHIP_COUNTER=0
      ship_logs &
    fi
    return 0
  fi

  # ── Push to API ─────────────────────────────────────────────────────
  compute_heartbeat_signature
  local HTTP_CODE=$(heartbeat_curl "$API_URL/api/servers/heartbeat" "$PAYLOAD")

  if [ "$HTTP_CODE" = "200" ]; then
    HEARTBEAT_FAILURES=0
    printf '%s' "$_CUR_HASH" > "$_HB_DIR/delta-hash" 2>/dev/null || true
    printf '0' > "$_HB_DIR/delta-tick" 2>/dev/null || true
    rm -f /etc/ellul/boot-failures
    rm -f /etc/ellul/pg-recovery-events
    COMMANDS_PROCESSED=false
    if poll_and_execute_commands; then
      COMMANDS_PROCESSED=true
    fi
    fetch_entitlement_if_stale
    sync_agent_bundle
  else
    HEARTBEAT_FAILURES=$((HEARTBEAT_FAILURES + 1))
    printf '%s' "$((_TICK + 1))" > "$_HB_DIR/delta-tick" 2>/dev/null || true
    log "Heartbeat push failed (HTTP $HTTP_CODE, reason=$_PUSH_REASON), failure count: $HEARTBEAT_FAILURES"
    return 1
  fi

  LOG_SHIP_COUNTER=$((${LOG_SHIP_COUNTER:-0} + 1))
  if [ $LOG_SHIP_COUNTER -ge 5 ]; then
    LOG_SHIP_COUNTER=0
    ship_logs &
  fi
}

# ============================================
# Command Worker Subprocess Manager
# ============================================
#
# Heavy commands (block-migrate-upload/download, wake-mount) run as isolated
# background processes. The heartbeat loop is NEVER blocked by them.
#
# Protocol:
#   /run/ellul/workers/{cmdId}.json  — worker state (running/completed/failed)
#   /run/ellul/workers/{cmdId}.pid   — worker process ID
#
# The agent heartbeats independently of command execution — commands can't
# crash the heartbeat. Timeouts enforced.

WORKER_DIR="/run/ellul/workers"

# Commands that run as isolated background workers (all others run inline)
# Commands that run as isolated background workers.
# NOTE: block-migrate-upload/download are NOT workers. They tear down the
# filesystem (unmount, LUKS close) which destroys the parent heartbeat's
# access to signing keys and tokens. They MUST run inline.
is_heavy_command() {
  # No heavy commands currently — block-migrate runs inline with progress pings.
  # This function exists for future commands that are truly independent of
  # the parent's filesystem state.
  return 1
}

# Max runtime per command type (seconds). Parent kills worker past deadline.
worker_timeout() {
  case "$1" in
    block-migrate-upload)   echo 7200 ;;  # 2 hours
    block-migrate-download) echo 7200 ;;  # 2 hours
    *)                      echo 3600 ;;  # 1 hour default
  esac
}

# Spawn a heavy command as an isolated background subprocess.
# The parent NEVER waits — results are collected via report_worker_results().
spawn_worker() {
  local CMD_ID="$1" CMD_TYPE="$2" CMD_PAYLOAD="$3"
  mkdir -p "$WORKER_DIR"

  # Write initial state BEFORE fork (prevents race with fast-completing workers)
  printf '{"status":"running","type":"%s","startedAt":"%s"}' \
    "$CMD_TYPE" "$(date -u +%FT%TZ)" > "$WORKER_DIR/$CMD_ID.json"

  (
    # ── Subprocess isolation ──
    # OOM score +1000: kernel prefers killing this worker over the heartbeat parent.
    # Agent stays alive; commands are expendable.
    echo 1000 > /proc/self/oom_score_adj 2>/dev/null || true

    # Trap: if killed by signal, write failure state
    trap 'printf "{\"status\":\"failed\",\"code\":137,\"result\":{\"error\":\"killed by signal\"}}" > "'"$WORKER_DIR/$CMD_ID.json"'"' TERM INT

    local W_RESULT="" W_CODE=""

    case "$CMD_TYPE" in
      block-migrate-upload)
        W_RESULT=$(block_migrate_upload "$CMD_PAYLOAD" 2>&1) || true
        if echo "$W_RESULT" | jq -e '.success == true' >/dev/null 2>&1; then
          W_CODE="200"
        else
          W_CODE="500"
        fi
        ;;
      block-migrate-download)
        W_RESULT=$(block_migrate_download "$CMD_PAYLOAD" 2>&1) || true
        if echo "$W_RESULT" | jq -e '.success == true' >/dev/null 2>&1; then
          W_CODE="200"
        else
          W_CODE="500"
        fi
        ;;
      *)
        W_CODE="400"
        W_RESULT='{"error":"unknown worker command"}'
        ;;
    esac

    # Write result atomically (tmp + rename prevents partial reads)
    local _TMP="$WORKER_DIR/$CMD_ID.tmp"
    if [ "$W_CODE" = "200" ]; then
      printf '{"status":"completed","code":%s,"result":%s}' "$W_CODE" "$W_RESULT" > "$_TMP"
    else
      printf '{"status":"failed","code":%s,"result":%s}' "$W_CODE" \
        "$(echo "$W_RESULT" | jq -Rs . 2>/dev/null || echo '\"worker error\"')" > "$_TMP"
    fi
    mv -f "$_TMP" "$WORKER_DIR/$CMD_ID.json"
  ) &

  local WORKER_PID=$!
  disown "$WORKER_PID" 2>/dev/null || true
  echo "$WORKER_PID" > "$WORKER_DIR/$CMD_ID.pid"

  log "Worker spawned: $CMD_TYPE ($CMD_ID) pid=$WORKER_PID oom_score=1000"
}

# Check for completed/failed/timed-out workers and report results to API.
# Called at the TOP of each heartbeat cycle, BEFORE heartbeat_raw().
report_worker_results() {
  [ -d "$WORKER_DIR" ] || return 0

  local FOUND_WORK=false
  for STATE_FILE in "$WORKER_DIR"/*.json; do
    [ -f "$STATE_FILE" ] || continue
    FOUND_WORK=true
    local CMD_ID=$(basename "$STATE_FILE" .json)
    local STATUS=$(jq -r '.status // "unknown"' "$STATE_FILE" 2>/dev/null)

    case "$STATUS" in
      completed|failed)
        # ── Report result to API ──
        local W_CODE=$(jq -r '.code // 500' "$STATE_FILE" 2>/dev/null)
        local W_RESULT=$(jq -c '.result // {}' "$STATE_FILE" 2>/dev/null)

        local REPORT_PAYLOAD
        if [ "$STATUS" = "completed" ]; then
          REPORT_PAYLOAD=$(jq -n --argjson result "$W_RESULT" \
            '{success: true, result: $result}' 2>/dev/null || echo '{"success":true}')
        else
          local ERR_MSG
          ERR_MSG=$(echo "$W_RESULT" | jq -r 'if type == "string" then . else (.error // "worker failed") end' 2>/dev/null || echo "worker failed")
          REPORT_PAYLOAD=$(jq -n --arg error "$ERR_MSG" \
            '{success: false, error: $error}' 2>/dev/null || echo '{"success":false,"error":"worker failed"}')
        fi

        signed_api_request -s -o /dev/null --connect-timeout 5 --max-time 10 \
          -X POST -d "$REPORT_PAYLOAD" \
          "$API_URL/api/servers/commands/$CMD_ID/complete" 2>/dev/null || true

        log "Worker result reported: $CMD_ID status=$STATUS code=$W_CODE"
        rm -f "$STATE_FILE" "$WORKER_DIR/$CMD_ID.pid"
        ;;

      running)
        # ── Liveness + timeout checks ──
        local PID_FILE="$WORKER_DIR/$CMD_ID.pid"
        local W_TYPE=$(jq -r '.type // "unknown"' "$STATE_FILE" 2>/dev/null)
        local W_START=$(jq -r '.startedAt // ""' "$STATE_FILE" 2>/dev/null)

        # Check if worker process is still alive
        if [ -f "$PID_FILE" ]; then
          local PID=$(cat "$PID_FILE" 2>/dev/null)
          if [ -n "$PID" ] && ! kill -0 "$PID" 2>/dev/null; then
            # Worker died without writing result — OOM killed or signal
            log "Worker DEAD: $CMD_ID pid=$PID type=$W_TYPE — process gone (likely OOM)"
            printf '{"status":"failed","code":137,"result":{"error":"worker process died unexpectedly (OOM or signal)"}}' \
              > "$STATE_FILE"
            # Will be reported on next cycle
            continue
          fi
        fi

        # Check timeout
        if [ -n "$W_START" ]; then
          local START_EPOCH=$(date -d "$W_START" +%s 2>/dev/null || echo 0)
          local NOW_EPOCH=$(date +%s)
          local ELAPSED=$(( NOW_EPOCH - START_EPOCH ))
          local MAX_SECONDS=$(worker_timeout "$W_TYPE")

          if [ "$ELAPSED" -gt "$MAX_SECONDS" ]; then
            log "Worker TIMEOUT: $CMD_ID type=$W_TYPE elapsed=${ELAPSED}s max=${MAX_SECONDS}s — killing"
            if [ -f "$PID_FILE" ]; then
              local PID=$(cat "$PID_FILE" 2>/dev/null)
              [ -n "$PID" ] && kill -KILL "$PID" 2>/dev/null || true
            fi
            printf '{"status":"failed","code":124,"result":{"error":"worker timed out after %ds (max %ds)"}}' \
              "$ELAPSED" "$MAX_SECONDS" > "$STATE_FILE"
            # Will be reported on next cycle
          fi
        fi
        ;;
    esac
  done
}

# Check if a worker is already running for a command type
# (prevents duplicate workers for the same command)
has_running_worker() {
  local CMD_TYPE="$1"
  [ -d "$WORKER_DIR" ] || return 1
  for STATE_FILE in "$WORKER_DIR"/*.json; do
    [ -f "$STATE_FILE" ] || continue
    local W_STATUS=$(jq -r '.status // ""' "$STATE_FILE" 2>/dev/null)
    local W_TYPE=$(jq -r '.type // ""' "$STATE_FILE" 2>/dev/null)
    if [ "$W_STATUS" = "running" ] && [ "$W_TYPE" = "$CMD_TYPE" ]; then
      return 0
    fi
  done
  return 1
}

# ============================================
# Command Queue Polling
# ============================================

# Generate internal JWT for file-api calls (same as agent-bridge/enforcer use)
generate_internal_jwt() {
  local JWT_SECRET
  JWT_SECRET=$(cat /etc/ellul/jwt-secret 2>/dev/null | tr -d '\n')
  [ -z "$JWT_SECRET" ] && return

  local HEADER=$(printf '{"alg":"HS256","typ":"JWT"}' | b64_encode_raw)
  local NOW=$(date +%s)
  local EXP=$((NOW + 300))
  local PAYLOAD=$(printf '{"purpose":"internal","iat":%d,"exp":%d}' "$NOW" "$EXP" | b64_encode_raw)

  local SIG=$(printf '%s.%s' "$HEADER" "$PAYLOAD" | openssl dgst -sha256 -hmac "$JWT_SECRET" -binary 2>/dev/null | b64_encode_raw)
  printf '%s.%s.%s' "$HEADER" "$PAYLOAD" "$SIG"
}

# Base64url encode (no padding, URL-safe)
b64_encode_raw() {
  openssl base64 -A 2>/dev/null | tr '+/' '-_' | tr -d '='
}

# Map command type to file-api endpoint and method
get_command_endpoint() {
  local CMD_TYPE="$1"
  case "$CMD_TYPE" in
    mount-volume)       echo "POST /api/mount-volume" ;;
    flush-volume)       echo "POST /api/flush-volume" ;;
    force-unmount)      echo "POST /api/force-unmount" ;;
    grow-volume)        echo "POST /api/grow-volume" ;;
    update-identity)    echo "DIRECT update-identity" ;;
    backup-identity)    echo "POST /api/backup-identity" ;;
    restore-identity)   echo "POST /api/restore-identity" ;;
    luks-close)         echo "DIRECT luks-close" ;;
    luks-format)        echo "DIRECT luks-format" ;;
    luks-rekey)         echo "DIRECT luks-rekey" ;;
    luks-header-backup) echo "DIRECT luks-header-backup" ;;
    maintenance-mode)   echo "POST /api/maintenance-mode" ;;
    wake-mount)         echo "DIRECT wake-mount" ;;
    read-public-key)    echo "DIRECT read-public-key" ;;
    stop-postgresql)    echo "DIRECT stop-postgresql" ;;
    ping)                  echo "GET /api/ping" ;;
    update-entitlements)   echo "DIRECT update-entitlements" ;;
    block-migrate-upload)      echo "DIRECT block-migrate-upload" ;;
    block-migrate-download)    echo "DIRECT block-migrate-download" ;;
    rotate-to-pqc)             echo "DIRECT rotate-to-pqc" ;;
    git-setup)                 echo "DIRECT git-setup" ;;
    re-attest)                 echo "DIRECT re-attest" ;;
    apply-pending-update)      echo "DIRECT apply-pending-update" ;;
    set-auto-update)           echo "DIRECT set-auto-update" ;;
    reconfigure-caddy-domain)  echo "DIRECT reconfigure-caddy-domain" ;;
    b2b-sandbox-destroy)       echo "DIRECT b2b-sandbox-destroy" ;;
    update-signing-keyring)    echo "DIRECT update-signing-keyring" ;;
    byos-migrate-restore)      echo "DIRECT byos-migrate-restore" ;;
    byos-migrate-export)       echo "DIRECT byos-migrate-export" ;;
    update-adapter-version)    echo "DIRECT update-adapter-version" ;;
    *)                     echo "" ;;
  esac
}

# ── SHARED HELPERS ──────────────────────────────────────────────────────
# Extracted from wake-mount to eliminate duplication.
# Each function is parameterized so callers only pass what differs.

# Acquire an execution lock with stale PID detection and trap-based cleanup.
# Usage: acquire_exec_lock "/run/lockfile.lock" "command-name"
# Returns 0 on success (lock acquired), 1 if another instance holds it.
# Sets _LOCK_PREV_TRAP for the caller to restore traps after release.
acquire_exec_lock() {
  local LOCK_FILE="$1"
  local CMD_NAME="$2"

  if [ -f "$LOCK_FILE" ]; then
    local LOCK_PID=$(cat "$LOCK_FILE" 2>/dev/null)
    if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
      log "$CMD_NAME: skipped — another instance running (pid=$LOCK_PID)"
      return 1
    else
      log "$CMD_NAME: removing stale lock (pid=$LOCK_PID no longer running)"
      rm -f "$LOCK_FILE"
    fi
  fi

  if ! ( set -o noclobber; echo $$ > "$LOCK_FILE" ) 2>/dev/null; then
    log "$CMD_NAME: skipped — lost lock race"
    return 1
  fi

  # Trap-based cleanup: remove lock on ANY exit (crash, OOM kill, signal)
  _LOCK_PREV_TRAP=$(trap -p EXIT | sed "s/^trap -- '//;s/' EXIT$//")
  trap "rm -f '$LOCK_FILE'; ${_LOCK_PREV_TRAP:-true}" EXIT
  trap "rm -f '$LOCK_FILE'; ${_LOCK_PREV_TRAP:-true}; exit 130" INT
  trap "rm -f '$LOCK_FILE'; ${_LOCK_PREV_TRAP:-true}; exit 143" TERM
  return 0
}

# Release an execution lock and restore previous traps.
release_exec_lock() {
  local LOCK_FILE="$1"
  rm -f "$LOCK_FILE"
  trap "${_LOCK_PREV_TRAP:-true}" EXIT
  trap - INT TERM
}

# Bind-mount vault directories to system paths via nsenter (global namespace).
# Usage: bind_mount_vault "/path/to/vault" "command-name"
# Prints mount counts to stdout as "ok:N fail:N"
#
# Before bind-mounting, merge root FS content into the vault for paths where
# the vault copy is empty but root FS has content.
# This prevents SSH keys, iptables rules, and other boot-time state from being
# hidden when the vault was initialized before that state was written.
bind_mount_vault() {
  local VAULT="$1"
  local CMD_NAME="$2"
  local _ok=0
  local _fail=0
  local _merged=0

  for _vpath in etc/ellul etc/caddy etc/iptables etc/ssh/authorized_keys \
                var/lib/ellul-shielded var/lib/postgresql \
                var/log/ellul var/log/caddy opt/ellul; do
    # Ensure vault subdirectory exists. Vaults from older provisioning may be
    # missing directories added later (e.g. var/lib/ellul-shielded). After
    # block migration the source vault is authoritative — create missing dirs
    # so bind mounts always succeed.
    [ ! -d "$VAULT/$_vpath" ] && mkdir -p "$VAULT/$_vpath" 2>/dev/null
    if [ -d "$VAULT/$_vpath" ]; then
      if [ -e "/$_vpath" ] && [ ! -d "/$_vpath" ]; then
        log "$CMD_NAME: WARN /$_vpath exists but is not a directory — skipping"
        _fail=$(( _fail + 1 ))
        continue
      fi
      mkdir -p "/$_vpath" 2>/dev/null

      # ── Seed-before-mount merge ──
      # If vault dir is empty but root FS has content, copy root FS into vault.
      # Handles: SSH keys written before vault init, markers written pre-vault, etc.
      if [ -d "/$_vpath" ] && ! mountpoint -q "/$_vpath" 2>/dev/null; then
        local _vault_count=$(ls -A "$VAULT/$_vpath" 2>/dev/null | wc -l)
        local _rootfs_count=$(ls -A "/$_vpath" 2>/dev/null | wc -l)
        if [ "$_vault_count" -eq 0 ] && [ "$_rootfs_count" -gt 0 ]; then
          cp -a "/$_vpath/." "$VAULT/$_vpath/" 2>/dev/null || true
          _merged=$(( _merged + 1 ))
          log "$CMD_NAME: merged root FS → vault for /$_vpath ($_rootfs_count items)"
        fi
      fi

      if mountpoint -q "/$_vpath" 2>/dev/null; then
        _ok=$(( _ok + 1 ))
      elif mount --bind "$VAULT/$_vpath" "/$_vpath" 2>/dev/null; then
        _ok=$(( _ok + 1 ))
      else
        log "$CMD_NAME: WARN bind mount failed for /$_vpath"
        _fail=$(( _fail + 1 ))
      fi
    fi
  done
  log "$CMD_NAME: vault bind mounts: $_ok active, $_fail failed, $_merged merged"
}

# Fix ownership and permissions on vault-backed paths.
# Usage: fix_vault_ownership "command-name" "svc-user"
fix_vault_ownership() {
  local CMD_NAME="$1"
  local _USER="$2"

  chown root:root /etc/ellul 2>/dev/null && chmod 755 /etc/ellul
  chown shield-runner:shield-ipc /etc/ellul/shield-data 2>/dev/null && chmod 2710 /etc/ellul/shield-data 2>/dev/null || true
  find /etc/ellul/shield-data -mindepth 1 ! -user shield-runner -exec chown shield-runner {} + 2>/dev/null || true
  chown root:shield /etc/ellul/secrets 2>/dev/null && chmod 2770 /etc/ellul/secrets 2>/dev/null || true
  chown root:shield-ipc /etc/ellul/jwt-secret 2>/dev/null && chmod 640 /etc/ellul/jwt-secret 2>/dev/null || true
  # Identity files on boot partition (never vault-bound)
  chown root:shield "$IDENTITY_DIR/node.key" 2>/dev/null && chmod 640 "$IDENTITY_DIR/node.key" 2>/dev/null || true
  chown root:shield "$IDENTITY_DIR/ai-proxy-token" 2>/dev/null && chmod 640 "$IDENTITY_DIR/ai-proxy-token" 2>/dev/null || true
  chown $_USER:$_USER /etc/ellul/agent-bridge 2>/dev/null || true
  chown -R caddy:caddy /etc/caddy 2>/dev/null && chmod 2770 /etc/caddy 2>/dev/null || true
  chown root:shield /var/lib/ellul-shielded 2>/dev/null && chmod 2770 /var/lib/ellul-shielded 2>/dev/null || true
  chown -R postgres:postgres /var/lib/postgresql 2>/dev/null && chmod 700 /var/lib/postgresql 2>/dev/null || true
  [ -d /var/log/ellul/apps ] && chown root:shield /var/log/ellul/apps 2>/dev/null && chmod 2770 /var/log/ellul/apps 2>/dev/null || true
  chown -R caddy:caddy /var/log/caddy 2>/dev/null || true
  chown -R root:root /opt/ellul 2>/dev/null && chmod 755 /opt/ellul 2>/dev/null || true

  # Home directory ownership (exclude vault + projects)
  chown $_USER:$_USER "$SVC_HOME" 2>/dev/null
  find "$SVC_HOME" -mindepth 1 -maxdepth 1 \
    ! -name '.ellul-vault' ! -name 'projects' \
    -exec chown -R $_USER:$_USER {} + 2>/dev/null
  if [ -d "$SVC_HOME/projects" ]; then
    # The projects dir holds one-or-more sbx-{7char} sandbox dirs. Shield
    # creates each sandbox dir as root:dev 0775 via shield-project-lock,
    # and countProjects() in sovereign-shield treats the root-owned inode
    # as the "slot in use" marker for entitlement enforcement.
    #
    # We ACTIVELY assert root:$_USER 0775 on every sbx-{7char} top-level
    # inode on every restore cycle. Two reasons:
    #   1. Prevention — don't chown them to $_USER (the bug that caused
    #      post-migration cap bypass via the pre-fix recursive chown).
    #   2. Self-heal — a sandbox that's drifted to $_USER (carried over
    #      from old code on a source volume, or any other path) gets
    #      repaired back to root, restoring entitlement counting.
    # Matches the shield-project-lock `lock` action's guarantees.
    #
    # Non-sandbox siblings (CLAUDE.md, shared/, any user-touched files
    # at the projects top level) still get the normal recursive chown.
    local _svc_gid
    _svc_gid=$(id -g "$_USER" 2>/dev/null || echo 1000)
    for _pentry in "$SVC_HOME/projects"/*; do
      [ -e "$_pentry" ] || continue
      # SECURITY: reject symlinks before touching anything. projects/ is
      # root:dev 1775 so the dev user (agent) can create entries here.
      # A symlink named sbx-{slug} pointing at /etc would turn our
      # chmod/chown into a path-traversal attack — chmod follows
      # symlinks to the target, and find's recursive chown would walk
      # the target subtree. shield-project-lock has the same guard.
      if [ -L "$_pentry" ]; then
        /usr/bin/logger -t fix_vault_ownership -p auth.crit \
          "REJECTED: symlink in projects dir: $_pentry" 2>/dev/null || true
        log "$CMD_NAME: rejected symlink $(basename "$_pentry") in projects"
        continue
      fi
      _pname=$(basename "$_pentry")
      if [ -d "$_pentry" ] && [[ "$_pname" =~ ^sbx-[a-z0-9]{7}$ ]]; then
        # Sandbox dir — positively lock to root:$_USER 0775, then chown
        # descendants to $_USER. --no-dereference on the chown is belt-
        # and-suspenders after the symlink check above.
        chown --no-dereference 0:"$_svc_gid" "$_pentry" 2>/dev/null || true
        chmod 0775 "$_pentry" 2>/dev/null || true
        # -xdev prevents accidental crossing into bind mounts (.shared
        # cross-project mounts are bind-mounted inside sbx-*); -P keeps
        # find from following any interior symlinks to escape the tree.
        find -P "$_pentry" -xdev -mindepth 1 \
          -exec chown -h $_USER:$_USER {} + 2>/dev/null || true
      else
        # Non-sandbox sibling (e.g. CLAUDE.md, shared/) — recursive chown OK.
        chown -R $_USER:$_USER "$_pentry" 2>/dev/null || true
      fi
    done
    chown root:$_USER "$SVC_HOME/projects" 2>/dev/null
    chmod 1775 "$SVC_HOME/projects" 2>/dev/null
  fi
  log "$CMD_NAME: ownership fixed"
}

# Persist vault bind mounts in fstab + reload systemd.
# Usage: persist_fstab_mounts "/path/to/vault" "device" "command-name"
persist_fstab_mounts() {
  local VAULT="$1"
  local DEVICE="$2"
  local CMD_NAME="$3"

  # Device mount — check mount point (not device path) to avoid duplicates.
  # For LUKS volumes, always use /dev/mapper/luks-home (not the raw device).
  if [ -n "$DEVICE" ] && ! grep -q " $SVC_HOME " /etc/fstab 2>/dev/null; then
    local _fstab_dev="$DEVICE"
    if [ -b /dev/mapper/luks-home ] || grep -q 'luks-home' /etc/crypttab 2>/dev/null; then
      _fstab_dev="/dev/mapper/luks-home"
    fi
    echo "$_fstab_dev $SVC_HOME ext4 defaults,nosuid,nodev,nofail 0 2" >> /etc/fstab
  fi

  # Bind mounts — depend on the home mount unit, NOT local-fs.target.
  # x-systemd.requires=local-fs.target creates a circular dependency:
  # bind mount → local-fs.target → bind mount. systemd breaks the cycle
  # by silently deleting the mount jobs, so bind mounts never activate.
  # Depending on home-dev.mount gives a linear chain:
  # LUKS open → home mount → bind mounts.
  local _home_unit="home-${PS_USER:-dev}.mount"
  for _vpath in etc/ellul etc/caddy etc/iptables etc/ssh/authorized_keys \
                var/lib/ellul-shielded var/lib/postgresql \
                var/log/ellul var/log/caddy opt/ellul; do
    local _src="$VAULT/$_vpath"
    local _dst="/$_vpath"
    if [ -d "$_src" ] && ! grep -q "$_src" /etc/fstab 2>/dev/null; then
      echo "$_src $_dst none bind,nofail,x-systemd.requires=$_home_unit 0 0" >> /etc/fstab
    fi
  done

  systemctl daemon-reload 2>/dev/null || true
  mount -a 2>/dev/null || true
  log "$CMD_NAME: fstab persisted"
}

# Start services idempotently with PostgreSQL readiness wait.
# Usage: start_services_idempotent "command-name" "context-label" ["force_restart"]
# When force_restart is set, restarts services even if already running.
# This is critical after vault bind mounts — services may hold stale file
# descriptors to root FS files that are now hidden by the vault overlay.
start_services_idempotent() {
  local CMD_NAME="$1"
  local CONTEXT="$2"
  local FORCE_RESTART="${3:-}"

  if [ "$FORCE_RESTART" = "force_restart" ] && systemctl is-active --quiet postgresql 2>/dev/null; then
    log "$CMD_NAME: force-stopping postgresql (vault config changed)"
    systemctl stop postgresql 2>/dev/null || true
    for _pg_unit in $(systemctl list-units --type=service --all --plain --no-legend 2>/dev/null | awk '/^postgresql@/{print $1}'); do
      systemctl stop "$_pg_unit" 2>/dev/null || true
    done
  fi

  # Ensure PG socket directory exists (/var/run is tmpfs, cleared on reboot).
  # Without this, PG starts but can't create its Unix socket → exits immediately.
  # Ubuntu's PG package normally handles this via the postgresql.service unit,
  # but after migration the unit ordering may differ.
  if [ ! -d /var/run/postgresql ]; then
    mkdir -p /var/run/postgresql
    chown postgres:postgres /var/run/postgresql 2>/dev/null || chown 999:999 /var/run/postgresql
    chmod 2775 /var/run/postgresql
  fi

  if ! systemctl is-active --quiet postgresql 2>/dev/null; then
    # Reset failed state: if PG crashed before vault was mounted (boot race),
    # systemd marks it "failed" and won't retry. reset-failed clears that.
    systemctl reset-failed postgresql 2>/dev/null || true
    systemctl reset-failed postgresql@16-main 2>/dev/null || true
    for _pg_unit in $(systemctl list-units --type=service --all --plain --no-legend 2>/dev/null | awk '/^postgresql@/{print $1}'); do
      systemctl reset-failed "$_pg_unit" 2>/dev/null || true
    done
    # Remove stale PID file from previous server (vault carries it across hibernate/wake).
    # PG refuses to start if postmaster.pid exists — it thinks another instance is running.
    # This is safe: we just stopped PG above, the PID belongs to a deleted cloud server.
    local _PG_DATA="/var/lib/postgresql/16/main"
    rm -f "$_PG_DATA/postmaster.pid" 2>/dev/null || true
    # Clear stale PG log entries from cloud-init's fresh cluster that crashed
    # when wake-mount replaced its data directory. pg-recovery's Layer 2 checks
    # tail -100 of the PG log for PANIC entries. Stale PANICs from the WRONG
    # cluster cause pg-recovery to run pg_resetwal on the VAULT's clean data,
    # destroying recent transactions (empty databases after wake).
    local _PG_LOG="/var/log/postgresql/postgresql-16-main.log"
    if [ -f "$_PG_LOG" ]; then
      echo "--- vault bind mount at $(date -u +%Y-%m-%dT%H:%M:%SZ) — log entries above are from cloud-init fresh cluster, not vault ---" >> "$_PG_LOG" 2>/dev/null || true
      # Truncate stale entries so pg-recovery doesn't see them
      : > "$_PG_LOG" 2>/dev/null || true
    fi
    # ── FIX STALE NextXID ──
    # On wake, the vault's pg_control may have a stale NextXID from vault creation.
    # User transactions (CREATE DATABASE, etc.) advanced NextXID in memory but the
    # checkpoint may not have written it to the vault's pg_control.
    # Any tuple with xmin >= NextXID is invisible to PG ("future transaction").
    # Fix: scan pg_database for the highest xmin, ensure NextXID is above it.
    local _PG_DATA="/var/lib/postgresql/16/main"
    if [ -d "$_PG_DATA" ] && [ -f "$_PG_DATA/global/pg_control" ]; then
      local _PG_BIN="/usr/lib/postgresql/16/bin"
      local _NEXT_XID=$(sudo -u postgres "$_PG_BIN/pg_controldata" "$_PG_DATA" 2>/dev/null | grep "NextXID" | awk -F: '{print $NF}' | tr -d ' ')
      # Find the highest xmin in pg_database by scanning the raw page
      local _MAX_XMIN=$(sudo -u postgres "$_PG_BIN/pg_controldata" "$_PG_DATA" 2>/dev/null | grep "NextXID" | awk -F: '{print $NF}' | tr -d ' ')
      # Better: use strings to find OIDs, but safest: just check if any xmin in the
      # catalog file exceeds NextXID by scanning with pg_filedump or hex.
      # Simplest safe approach: read NextXID, then read the max xmin from pg_database
      # page using a python one-liner on the raw page.
      local _HIGHEST_XMIN=""
      _HIGHEST_XMIN=$(python3 -c "
import struct, sys
try:
    with open('$_PG_DATA/global/1262', 'rb') as f:
        data = f.read(8192)
    # Page header: 24 bytes. pd_lower at offset 12 (2 bytes LE)
    pd_lower = struct.unpack_from('<H', data, 12)[0]
    n_items = (pd_lower - 24) // 4
    max_xmin = 0
    for i in range(n_items):
        lp = struct.unpack_from('<I', data, 24 + i*4)[0]
        lp_flags = (lp >> 15) & 3
        if lp_flags != 1: continue  # skip non-normal
        lp_off = lp & 0x7FFF
        if lp_off == 0: continue
        # HeapTupleHeaderData: t_xmin at offset 0 (4 bytes LE)
        xmin = struct.unpack_from('<I', data, lp_off)[0]
        if xmin > max_xmin and xmin < 4000000000:
            max_xmin = xmin
    print(max_xmin)
except:
    print(0)
" 2>/dev/null)
      if [ -n "$_HIGHEST_XMIN" ] && [ "$_HIGHEST_XMIN" -gt 0 ] && [ -n "$_NEXT_XID" ] && [ "$_NEXT_XID" -gt 0 ]; then
        if [ "$_HIGHEST_XMIN" -ge "$_NEXT_XID" ]; then
          local _SAFE_XID=$(( _HIGHEST_XMIN + 1000 ))
          log "$CMD_NAME: NextXID ($_NEXT_XID) < highest xmin ($_HIGHEST_XMIN) — advancing to $_SAFE_XID"
          sudo -u postgres "$_PG_BIN/pg_resetwal" -x "$_SAFE_XID" "$_PG_DATA" >/dev/null 2>&1 || true
        else
          log "$CMD_NAME: NextXID ($_NEXT_XID) OK (highest xmin: $_HIGHEST_XMIN)"
        fi
      fi
    fi

    log "$CMD_NAME: starting postgresql ($CONTEXT)"
    # Reset failed state — cloud-init or previous stop may leave the unit in "failed"
    # state, which prevents systemctl start from working.
    systemctl reset-failed postgresql 2>/dev/null || true
    for _pg_unit in $(systemctl list-units --type=service --all --plain --no-legend 2>/dev/null | awk '/^postgresql@/{print $1}'); do
      systemctl reset-failed "$_pg_unit" 2>/dev/null || true
    done
    systemctl start postgresql 2>/dev/null || true
    local _pg_ready=false
    for _pg_wait in $(seq 1 30); do
      if sudo -u postgres pg_isready -q 2>/dev/null; then _pg_ready=true; break; fi
      sleep 1
    done
    if [ "$_pg_ready" = "true" ]; then
      log "$CMD_NAME: postgresql ready"
    else
      log "$CMD_NAME: WARN postgresql not ready after 30s — dumping PG log:"
      tail -20 "$_PG_LOG" 2>/dev/null | while IFS= read -r line; do log "  PG: $line"; done
      log "$CMD_NAME: PG systemd status: $(systemctl is-active postgresql@16-main 2>&1)"
    fi
  else
    log "$CMD_NAME: postgresql already running — skipped (idempotent guard)"
  fi

  for _svc in caddy ellul-sovereign-shield ellul-file-api ellul-agent-bridge; do
    if [ "$FORCE_RESTART" = "force_restart" ] && systemctl is-active --quiet "$_svc" 2>/dev/null; then
      log "$CMD_NAME: force-restarting $_svc (vault config changed)"
      systemctl restart "$_svc" 2>/dev/null || true
    elif ! systemctl is-active --quiet "$_svc" 2>/dev/null; then
      log "$CMD_NAME: starting $_svc"
      systemctl start "$_svc" 2>/dev/null || true
    else
      log "$CMD_NAME: $_svc already running — skipped (idempotent guard)"
    fi
  done
  log "$CMD_NAME: all services started"
}

# ============================================
# Unified Server State Restoration
# ============================================
#
# Single code path for restoring server state after any lifecycle event
# that modifies the volume (wake, block-migrate-download, enforcer boot).
# Eliminates the class of bugs where one path sets up vault bind mounts
# and another doesn't.
#
# Every lifecycle event that opens/mounts a volume MUST call this function
# before starting services or expecting identity to work.
#
# What it does:
#   1. UID/GID map restoration (users/groups from the vault)
#   2. Stop services (prevent stale config reads)
#   3. Vault bind mounts (single source of truth for identity + config)
#   4. Ownership/permissions fix
#   5. Identity cache to tmpfs (survive vault replacement)
#   6. Iptables restore
#   7. Service start (with PG readiness)
#
# Usage: restore_server_state "caller-name"
restore_server_state() {
  local CMD_NAME="$1"
  local VAULT="$SVC_HOME/.ellul-vault"

  log "$CMD_NAME: restore_server_state: vault=$VAULT home_mounted=$(mountpoint -q "$SVC_HOME" 2>/dev/null && echo yes || echo no)"
  log "$CMD_NAME: restore_server_state: vault_dir=$([ -d "$VAULT" ] && echo yes || echo no) initialized=$([ -f "$VAULT/.initialized" ] && echo yes || echo no) etc_ellul=$([ -d "$VAULT/etc/ellul" ] && echo yes || echo no)"

  # If the vault doesn't exist but the home dir is mounted (LUKS open),
  # create and initialize it from root FS. This handles:
  # - Block migration where SOURCE vault was lost or empty
  # - First-boot race where wake-mount hasn't created the vault yet
  # - Any scenario where the LUKS volume is mounted but has no vault
  if mountpoint -q "$SVC_HOME" 2>/dev/null && { [ ! -f "$VAULT/.initialized" ] || [ ! -d "$VAULT/etc/ellul" ]; }; then
    log "$CMD_NAME: vault missing on mounted volume — creating from root FS"
    mkdir -p "$VAULT" && chmod 700 "$VAULT" && chown root:root "$VAULT"
    for _vpath in etc/ellul etc/caddy etc/iptables etc/ssh/authorized_keys \
                  var/lib/ellul-shielded var/lib/postgresql \
                  var/log/ellul var/log/caddy opt/ellul; do
      mkdir -p "$VAULT/$_vpath"
      if [ -d "/$_vpath" ] && [ "$(ls -A "/$_vpath" 2>/dev/null)" ]; then
        cp -a "/$_vpath/." "$VAULT/$_vpath/" 2>/dev/null || true
      fi
    done
    date -u +%Y-%m-%dT%H:%M:%SZ > "$VAULT/.initialized"
    chmod 400 "$VAULT/.initialized"
    # Save UID/GID map
    {
      getent group shield >/dev/null 2>&1 && echo "g:shield:$(getent group shield | cut -d: -f3)"
      getent group shield-ipc >/dev/null 2>&1 && echo "g:shield-ipc:$(getent group shield-ipc | cut -d: -f3)"
      getent group shield-runner >/dev/null 2>&1 && echo "g:shield-runner:$(getent group shield-runner | cut -d: -f3)"
      getent group caddy >/dev/null 2>&1 && echo "g:caddy:$(getent group caddy | cut -d: -f3)"
      id -u caddy >/dev/null 2>&1 && echo "u:caddy:$(id -u caddy)"
      getent group postgres >/dev/null 2>&1 && echo "g:postgres:$(getent group postgres | cut -d: -f3)"
      id -u postgres >/dev/null 2>&1 && echo "u:postgres:$(id -u postgres)"
      id -u shield-runner >/dev/null 2>&1 && echo "u:shield-runner:$(id -u shield-runner)"
      echo "u:$SVC_USER:$(id -u $SVC_USER)"
      echo "g:$SVC_USER:$(id -g $SVC_USER)"
    } > "$VAULT/.gid-map" 2>/dev/null
    chmod 600 "$VAULT/.gid-map"
    log "$CMD_NAME: vault created and initialized from root FS"
  fi

  if [ ! -f "$VAULT/.initialized" ] || [ ! -d "$VAULT/etc/ellul" ]; then
    log "$CMD_NAME: no initialized vault and volume not mounted — skipping restore"
    return 1
  fi

  log "$CMD_NAME: restoring server state (unified path)..."

  # 1. UID/GID map
  if [ -f "$VAULT/.gid-map" ]; then
    while IFS=: read -r _type _name _id; do
      case "$_type" in
        g) getent group "$_name" >/dev/null 2>&1 || groupadd --gid "$_id" "$_name" 2>/dev/null || groupadd --system --gid "$_id" "$_name" 2>/dev/null || true ;;
        u) id -u "$_name" >/dev/null 2>&1 || useradd --system --uid "$_id" --no-create-home --shell /usr/sbin/nologin "$_name" 2>/dev/null || true ;;
      esac
    done < "$VAULT/.gid-map"
  fi

  # 2. Stop services (they may be running with stale/empty config)
  systemctl stop ellul-agent-bridge ellul-file-api ellul-sovereign-shield caddy postgresql 2>/dev/null || true

  # 3. Vault bind mounts
  # Identity lives on /etc/ellul-bootstrap/ (never vault-bound), so vault
  # restore cannot overwrite it. No identity caching needed.
  bind_mount_vault "$VAULT" "$CMD_NAME"
  fix_vault_ownership "$CMD_NAME" "$SVC_USER"
  systemctl daemon-reload 2>/dev/null || true

  # 5. Restore iptables — prefer TARGET server's provisioned rules over vault's.
  # The vault carries the SOURCE server's iptables which may have different
  # rate limits, IP addresses, or provider-specific rules. The TARGET's rules
  # were written during cloud-init to /var/lib/ellul-iptables-fb/.
  if [ -f /var/lib/ellul-iptables-fb/rules.v4 ] && [ -s /var/lib/ellul-iptables-fb/rules.v4 ]; then
    cp /var/lib/ellul-iptables-fb/rules.v4 /etc/iptables/rules.v4 2>/dev/null || true
    [ -f /var/lib/ellul-iptables-fb/rules.v6 ] && cp /var/lib/ellul-iptables-fb/rules.v6 /etc/iptables/rules.v6 2>/dev/null || true
    log "$CMD_NAME: iptables restored from target provisioning (not vault)"
  fi
  [ -f /etc/iptables/rules.v4 ] && [ -s /etc/iptables/rules.v4 ] && \
    iptables-restore < /etc/iptables/rules.v4 2>/dev/null || true

  # 6. Start services (force restart — services may hold stale fds from pre-mount)
  start_services_idempotent "$CMD_NAME" "vault restored" "force_restart"
  log "$CMD_NAME: server state restored (unified path complete)"
}

# ── Entitlement Pull ───────────────
# Pulls the current signed entitlement JWS from the API and applies it
# if the remote seq has advanced past our local seq. The JWS itself is
# ML-DSA-65 signed with the long-lived platform key (entitlement-pubkey.pem),
# so the transport does not need E2EE — content authenticity is baked in.
#
# Why pull not push:
#   The old push path (enqueueAndWait update-entitlements) encrypted the
#   manifest with the DB's cached publicKey. During a migration rekey
#   window, that key lagged the target VPS's actual node.key, producing
#   "PQC E2EE decryption failed" and wedging the command queue. Pulling
#   a self-signed document has no such race — the platform signing key
#   does not rotate on migration.
#
# Conditional GET:
#   Sends `If-None-Match: seq=N` where N is the local seq. The API replies
#   304 when cache matches, so the common case is a single cheap HEAD-like
#   round-trip with no verification work.
#
# Called from: heartbeat() and heartbeat_raw() after poll_and_execute_commands.
fetch_entitlement_if_stale() {
  # Skip entirely while the vault is locked (sovereign awaiting_unlock).
  # Sovereign-shield is not running, /etc/ellul/entitlement.jws cannot
  # be applied, and the seq file lives inside the vault anyway.
  if ! mountpoint -q /etc/ellul 2>/dev/null; then
    return 0
  fi

  # Use command-signing.pub (JSON format) not entitlement-pubkey.pem (raw base64).
  # Both files carry the SAME platform ML-DSA-65 public key — the only difference
  # is the on-disk format. ellul-crypto verify expects JSON; sovereign-shield's
  # Node code loads the raw-base64 PEM. We go through ellul-crypto here so we
  # pick the file format it understands.
  local PUBKEY_FILE="$COMMAND_SIGNING_PUBKEY_FILE"
  if [ ! -f "$PUBKEY_FILE" ] || [ ! -x "$CRYPTO_BIN" ]; then
    return 0  # first-boot / no signing configured — non-fatal
  fi

  local SEQ_FILE="/etc/ellul/shield-data/.entitlement-seq"
  local LOCAL_SEQ=0
  [ -f "$SEQ_FILE" ] && LOCAL_SEQ=$(cat "$SEQ_FILE" 2>/dev/null | tr -d '\n' | head -c 16)
  [[ "$LOCAL_SEQ" =~ ^[0-9]+$ ]] || LOCAL_SEQ=0

  local SID
  SID=$(cat "$SERVER_ID_FILE" 2>/dev/null | tr -d '\n')
  [ -z "$SID" ] && return 0

  local RESP_FILE
  RESP_FILE=$(mktemp /tmp/ent-resp-XXXXXX)
  local HTTP_CODE
  HTTP_CODE=$(signed_api_request -s -o "$RESP_FILE" -w "%{http_code}" \
    --connect-timeout 5 --max-time 10 \
    -H "If-None-Match: seq=$LOCAL_SEQ" \
    "$API_URL/api/servers/$SID/entitlement/current" 2>/dev/null) || HTTP_CODE="000"

  # 304: cache matches, nothing to do (common case, ~every heartbeat).
  # 204: free tier / signing disabled — nothing to apply.
  # 401/403: auth failure — log once and bail; next heartbeat retries.
  # 200: fresh manifest — verify + apply below.
  if [ "$HTTP_CODE" = "304" ] || [ "$HTTP_CODE" = "204" ]; then
    rm -f "$RESP_FILE"
    return 0
  fi
  if [ "$HTTP_CODE" != "200" ]; then
    log "entitlement-pull: HTTP $HTTP_CODE — skipping"
    rm -f "$RESP_FILE"
    return 0
  fi

  local REMOTE_SEQ REMOTE_JWS
  REMOTE_SEQ=$(jq -r '.seq // empty' "$RESP_FILE" 2>/dev/null)
  REMOTE_JWS=$(jq -r '.jws // empty' "$RESP_FILE" 2>/dev/null)
  rm -f "$RESP_FILE"

  if [ -z "$REMOTE_SEQ" ] || [ -z "$REMOTE_JWS" ]; then
    log "entitlement-pull: malformed response"
    return 0
  fi
  # Replay protection: never accept an older or equal seq.
  if [ "$REMOTE_SEQ" -le "$LOCAL_SEQ" ]; then
    return 0
  fi

  # Validate JWS format: three base64url segments separated by dots
  # (matches the legacy update-entitlements handler's sanitization).
  if ! echo "$REMOTE_JWS" | grep -qxE '[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+'; then
    log "entitlement-pull: malformed JWS"
    return 0
  fi

  # Verify ML-DSA-65 signature (key ring aware — tries all keys in v3 ring)
  if ! verify_jws_ml_dsa65_ring "$REMOTE_JWS" "$PUBKEY_FILE"; then
    log "entitlement-pull: ML-DSA-65 verification FAILED (seq=$REMOTE_SEQ) — rejecting"
    return 1
  fi

  # Verify payload vps-binding matches our server-id (defense against
  # cross-server replay — same guarantee sovereign-shield enforces when
  # it loads the JWS, but we fail fast here to avoid a pointless restart).
  local JWS_BODY
  JWS_BODY=$(printf '%s' "$REMOTE_JWS" | cut -d. -f2)
  local JWS_BODY_STD="${JWS_BODY//-/+}"
  JWS_BODY_STD="${JWS_BODY_STD//_//}"
  case $(( ${#JWS_BODY_STD} % 4 )) in
    2) JWS_BODY_STD="${JWS_BODY_STD}==" ;;
    3) JWS_BODY_STD="${JWS_BODY_STD}=" ;;
  esac
  local JWS_VPS
  JWS_VPS=$(printf '%s' "$JWS_BODY_STD" | base64 -d 2>/dev/null | jq -r '.vps // empty' 2>/dev/null)

  if [ "$JWS_VPS" != "$SID" ]; then
    log "entitlement-pull: JWS vps-binding mismatch (got '$JWS_VPS', expected '$SID') — rejecting"
    return 1
  fi

  # Atomic write: .new → mv
  printf '%s\n' "$REMOTE_JWS" > /etc/ellul/entitlement.jws.new
  chmod 644 /etc/ellul/entitlement.jws.new
  chown root:root /etc/ellul/entitlement.jws.new
  mv -f /etc/ellul/entitlement.jws.new /etc/ellul/entitlement.jws

  echo -n "$REMOTE_SEQ" > "$SEQ_FILE.new"
  chmod 600 "$SEQ_FILE.new"
  mv -f "$SEQ_FILE.new" "$SEQ_FILE"

  # Restart sovereign-shield so it picks up the new manifest. The service
  # loads the pubkey at module init and caches verified payloads — a
  # restart ensures fresh state.
  systemctl restart ellul-sovereign-shield 2>/dev/null || true
  log "entitlement-pull: applied seq=$REMOTE_SEQ (was $LOCAL_SEQ), shield restarted"
}

# ── ML-DSA-65 Command Signature Verification ──────────────────────────
# Verifies signed command envelopes from the platform. If a command has
# _signed: true, we verify the ML-DSA-65 signature covers both the metadata
# AND the SHA-256 hash of the encrypted payload, preventing payload-swap attacks.
#
# Input:  Full command JSON (the .commands[$i] object from the API response)
# Output: Verified payload JSON on stdout (encryptedPayload extracted from envelope)
# Returns: 0 on success, 1 on verification failure
#
# If the command signing public key is not available, signed commands are
# rejected (fail closed). Unsigned commands pass through for backward compat.
verify_command_signature() {
  local CMD_JSON="$1"
  local CMD_ID="$2"

  local IS_SIGNED=$(echo "$CMD_JSON" | jq -r '.payload._signed // empty' 2>/dev/null)
  if [ "$IS_SIGNED" != "true" ]; then
    # Not a signed envelope — return payload as-is (backward compat)
    echo "$CMD_JSON" | jq -c '.payload' 2>/dev/null
    return 0
  fi

  # Fail closed: reject signed commands if we don't have the verification key
  if [ ! -f "$COMMAND_SIGNING_PUBKEY_FILE" ]; then
    log "Command $CMD_ID: _signed envelope but no command signing pubkey — rejecting (fail closed)"
    return 1
  fi

  if [ ! -x "$CRYPTO_BIN" ]; then
    log "Command $CMD_ID: _signed envelope but ellul-crypto not available — rejecting (fail closed)"
    return 1
  fi

  # Extract envelope fields
  local SIG_B64=$(echo "$CMD_JSON" | jq -r '.payload.signature // empty' 2>/dev/null)
  local ENVELOPE_PAYLOAD=$(echo "$CMD_JSON" | jq -c '.payload.encryptedPayload' 2>/dev/null)

  if [ -z "$SIG_B64" ] || [ "$ENVELOPE_PAYLOAD" = "null" ]; then
    log "Command $CMD_ID: _signed envelope missing signature or encryptedPayload — rejecting"
    return 1
  fi

  # Compute SHA-256 hash of the encrypted payload (must match API-side canonicalization)
  local PAYLOAD_HASH=$(printf '%s' "$ENVELOPE_PAYLOAD" | sha256sum | awk '{print $1}')

  # Build canonical signed data (sorted keys, must match API-side canonicalize())
  local CANONICAL=$(echo "$CMD_JSON" | jq -c --arg ph "$PAYLOAD_HASH" '{
    commandId: .payload.commandId,
    expiresAt: .payload.expiresAt,
    issuedAt: .payload.issuedAt,
    nonce: .payload.nonce,
    payloadHash: $ph,
    serverId: .payload.serverId,
    type: .payload.type
  }' 2>/dev/null)

  if [ -z "$CANONICAL" ] || [ "$CANONICAL" = "null" ]; then
    log "Command $CMD_ID: failed to build canonical data for verification — rejecting"
    return 1
  fi

  # Verify ML-DSA-65 signature (key ring aware — tries all keys in v3 ring)
  local VERIFY_DATA_FILE=$(mktemp /run/ellul-keyring-XXXXXX)
  printf '%s' "$CANONICAL" > "$VERIFY_DATA_FILE"

  if verify_mldsa65_ring "$SIG_B64" "$VERIFY_DATA_FILE" "$COMMAND_SIGNING_PUBKEY_FILE"; then
    rm -f "$VERIFY_DATA_FILE"
    echo "$ENVELOPE_PAYLOAD"
    return 0
  else
    log "Command $CMD_ID: ML-DSA-65 SIGNATURE VERIFICATION FAILED — rejecting (possible tampering)"
    rm -f "$VERIFY_DATA_FILE"
    return 1
  fi
}

# Poll for pending commands and execute them
# Returns 0 if commands were processed (caller should poll again immediately),
# 1 if no commands found (caller can sleep). This enables command-burst mode:
# after a DIRECT command like block-migrate-download completes, the enforcer immediately
# polls for follow-up commands (e.g., update-identity) instead of sleeping 30s.
poll_and_execute_commands() {
  local TOKEN=$(get_token)
  [ -z "$TOKEN" ] && return 1

  # BYOS check -- no platform control
  [ -f /etc/ellul/byos ] && return 1

  # Poll for commands (signed)
  local RESPONSE
  RESPONSE=$(signed_api_request -s --connect-timeout 5 --max-time 10 \
    "$API_URL/api/servers/commands")

  [ -z "$RESPONSE" ] && return 1

  local CMD_COUNT
  CMD_COUNT=$(echo "$RESPONSE" | jq '.commands | length' 2>/dev/null)
  [ -z "$CMD_COUNT" ] || [ "$CMD_COUNT" = "0" ] || [ "$CMD_COUNT" = "null" ] && return 1

  log "Command queue: $CMD_COUNT pending command(s)"

  local INTERNAL_JWT
  INTERNAL_JWT=$(generate_internal_jwt)
  # JWT is only needed for file-api routed commands (POST/GET to localhost:3002).
  # DIRECT commands (block-migrate, update-identity, read-public-key, etc.)
  # run inline and don't need JWT. Don't bail on the entire command loop
  # just because JWT generation failed — DIRECT commands must still execute.
  if [ -z "$INTERNAL_JWT" ]; then
    log "Command queue: JWT generation failed (sovereign-shield may be down) — DIRECT commands will still execute"
  fi

  # Process each command
  local i=0
  while [ $i -lt "$CMD_COUNT" ]; do
    local CMD_ID=$(echo "$RESPONSE" | jq -r ".commands[$i].id" 2>/dev/null)
    local CMD_TYPE=$(echo "$RESPONSE" | jq -r ".commands[$i].type" 2>/dev/null)
    local CMD_JSON=$(echo "$RESPONSE" | jq -c ".commands[$i]" 2>/dev/null)

    [ -z "$CMD_ID" ] || [ "$CMD_ID" = "null" ] && { i=$((i+1)); continue; }

    # ── ML-DSA-65 Command Signature Verification ──
    # If the command is wrapped in a _signed envelope, verify the signature
    # before proceeding. This covers metadata + payload hash, preventing
    # both metadata and payload tampering via DB compromise.
    local CMD_PAYLOAD
    if ! CMD_PAYLOAD=$(verify_command_signature "$CMD_JSON" "$CMD_ID"); then
      log "Command $CMD_ID: signature verification failed — skipping"
      signed_api_request -s -o /dev/null --connect-timeout 5 --max-time 10 \
        -X POST \
        -d '{"success":false,"error":"ML-DSA-65 command signature verification failed"}' \
        "$API_URL/api/servers/commands/$CMD_ID/complete" || true
      i=$((i+1)); continue
    fi

    # ── E2EE: Decrypt command payload locally using node.key ──
    # API encrypts with server's public key, we decrypt with private key.
    # API never sees plaintext after encryption — it's a blind relay.
    local IS_E2EE=$(echo "$CMD_PAYLOAD" | jq -r '._e2ee // empty' 2>/dev/null)
    if [ -n "$IS_E2EE" ] && [ "$IS_E2EE" = "true" ]; then
      local IS_PQC=$(echo "$CMD_PAYLOAD" | jq -r '._pqc // empty' 2>/dev/null)

      if [ -n "$IS_PQC" ] && [ "$IS_PQC" != "null" ] && [ "$IS_PQC" != "false" ]; then
        # PQC path: ML-KEM-1024 + AES-256-GCM via ellul-crypto
        log "Command $CMD_ID: decrypting PQC envelope (version $IS_PQC)"
        local NODE_KEY="$IDENTITY_DIR/node.key"
        if [ ! -f "$NODE_KEY" ]; then
          log "Command $CMD_ID: PQC decryption failed — node.key not found"
          signed_api_request -s -o /dev/null --connect-timeout 5 --max-time 10 \
            -X POST \
            -d '{"success":false,"error":"PQC decryption failed — node.key not found"}' \
            "$API_URL/api/servers/commands/$CMD_ID/complete" || true
          i=$((i+1)); continue
        fi

        local DECRYPTED
        local DECRYPT_ERR=$(mktemp /tmp/cmd-decrypt-err-XXXXXX)
        if DECRYPTED=$(echo "$CMD_PAYLOAD" | "$CRYPTO_BIN" decrypt --key "$NODE_KEY" --stdin 2>"$DECRYPT_ERR"); then
          log "Command $CMD_ID: PQC decryption successful"
          CMD_PAYLOAD="$DECRYPTED"
        else
          local DERR=$(cat "$DECRYPT_ERR" 2>/dev/null)
          log "Command $CMD_ID: PQC decryption failed — $DERR"
          rm -f "$DECRYPT_ERR"
          signed_api_request -s -o /dev/null --connect-timeout 5 --max-time 10 \
            -X POST \
            -d '{"success":false,"error":"PQC E2EE decryption failed"}' \
            "$API_URL/api/servers/commands/$CMD_ID/complete" || true
          i=$((i+1)); continue
        fi
        rm -f "$DECRYPT_ERR"
      else
        # Legacy RSA path
        local ENC_KEY=$(echo "$CMD_PAYLOAD" | jq -r '.encryptedKey // empty' 2>/dev/null)
        local ENC_IV=$(echo "$CMD_PAYLOAD" | jq -r '.iv // empty' 2>/dev/null)
        local ENC_DATA=$(echo "$CMD_PAYLOAD" | jq -r '.encryptedData // empty' 2>/dev/null)

        if [ -z "$ENC_KEY" ] || [ -z "$ENC_IV" ] || [ -z "$ENC_DATA" ]; then
          log "Command $CMD_ID: E2EE payload missing fields — skipping"
          i=$((i+1)); continue
        fi

        local DECRYPTED
        if DECRYPTED=$(/usr/local/bin/ellul-decrypt "$ENC_KEY" "$ENC_IV" "$ENC_DATA" 2>/dev/null); then
          CMD_PAYLOAD="$DECRYPTED"
        else
          log "Command $CMD_ID: E2EE decryption failed — skipping"
          signed_api_request -s -o /dev/null --connect-timeout 5 --max-time 10 \
            -X POST \
            -d '{"success":false,"error":"E2EE decryption failed — node.key may be missing or corrupted"}' \
            "$API_URL/api/servers/commands/$CMD_ID/complete" || true
          i=$((i+1)); continue
        fi
      fi
    fi

    local ENDPOINT_INFO=$(get_command_endpoint "$CMD_TYPE")
    [ -z "$ENDPOINT_INFO" ] && {
      log "Command queue: unknown type '$CMD_TYPE', skipping"
      i=$((i+1))
      continue
    }

    # Claim the command (signed)
    local CLAIM_CODE
    CLAIM_CODE=$(signed_api_request -s -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 10 \
      -X POST \
      "$API_URL/api/servers/commands/$CMD_ID/claim")

    if [ "$CLAIM_CODE" != "200" ]; then
      log "Command queue: failed to claim $CMD_ID (HTTP $CLAIM_CODE)"
      i=$((i+1))
      continue
    fi

    # Execute command
    local METHOD=$(echo "$ENDPOINT_INFO" | cut -d' ' -f1)
    local ENDPOINT_PATH=$(echo "$ENDPOINT_INFO" | cut -d' ' -f2)
    local EXEC_RESULT
    local EXEC_CODE

    if [ "$METHOD" = "DIRECT" ]; then
      # Direct commands execute locally (enforcer runs as root)
      case "$ENDPOINT_PATH" in
        apply-pending-update)
          # Operator-initiated apply of a pending manifest (Manual mode).
          # Triggered by the user clicking "Update" in the dashboard,
          # which POSTs /api/servers/:id/update → enqueues this signed
          # command. The command itself carries no payload beyond its
          # signed envelope — all state lives in /etc/ellul/shield-data/
          # .agent-pending-manifest.json, written during the previous
          # sync_agent_bundle when auto-update=false.
          #
          # Re-verifies the hash chain against current local state to
          # defend against a race where a newer manifest was published
          # between stage and apply.
          local APP_RESULT
          APP_RESULT=$(apply_pending_update 2>&1)
          local APP_RC=$?
          if [ $APP_RC -eq 0 ]; then
            EXEC_CODE="200"
            EXEC_RESULT=$(echo "$APP_RESULT" | jq -R -s -c 'split("\n") | .[0] | {success: true, status: .}')
            log "Command queue: apply-pending-update succeeded ($APP_RESULT)"
          else
            EXEC_CODE="500"
            EXEC_RESULT=$(echo "$APP_RESULT" | jq -R -s -c 'split("\n") | .[0] | {success: false, error: .}')
            log "Command queue: apply-pending-update FAILED ($APP_RESULT)"
          fi
          ;;

        update-adapter-version)
          local UAV_ADAPTER UAV_VERSION UAV_RESULT
          UAV_ADAPTER=$(echo "$CMD_PAYLOAD" | jq -r '.adapter // empty' 2>/dev/null)
          UAV_VERSION=$(echo "$CMD_PAYLOAD" | jq -r '.version // empty' 2>/dev/null)
          if [ -n "$UAV_ADAPTER" ] && [ -n "$UAV_VERSION" ]; then
            UAV_RESULT=$(update_single_adapter "$UAV_ADAPTER" "$UAV_VERSION" 2>&1)
            if [ $? -eq 0 ]; then
              EXEC_CODE="200"
              EXEC_RESULT='{"success":true}'
              log "Command queue: update-adapter-version $UAV_ADAPTER@$UAV_VERSION succeeded"
            else
              EXEC_CODE="500"
              EXEC_RESULT=$(echo "$UAV_RESULT" | jq -R -s -c '{success: false, error: .}')
              log "Command queue: update-adapter-version $UAV_ADAPTER@$UAV_VERSION FAILED ($UAV_RESULT)"
            fi
          else
            EXEC_CODE="400"
            EXEC_RESULT='{"success":false,"error":"missing adapter or version"}'
          fi
          ;;

        b2b-sandbox-destroy)
          # Full per-sandbox resource reclaim. Fires when the API records a
          # sandbox as terminated or when the archive cron ages one out.
          # Prior to this handler the destroy request landed in the command
          # queue and expired unread, leaving: the workspace dir, the
          # ellul-preview@<slug>-* systemd units, the zeroclaw daemon,
          # assorted opencode serves, and the persistent namespace. On a
          # small VPS five of those add up to full swap + load avg 30+.
          #
          # Running as root lets us bypass the agent-bridge HTTP boundary —
          # agent-bridge's gatewayPool entry for this project becomes stale
          # but harmless (next health check discovers the dead pid and the
          # reaper drops the entry; see zeroclaw-client.service.ts).
          local BSD_PROJECT BSD_USER BSD_PROJECTS_DIR BSD_TARGET
          BSD_PROJECT=$(echo "$CMD_PAYLOAD" | jq -r '.slug // .project // empty' 2>/dev/null)
          # Project slugs are provisioned as sbx-<8+ lowercase alphanum>. Reject
          # anything else so this handler cannot be coerced into rm'ing an
          # attacker-supplied path.
          if [[ ! "$BSD_PROJECT" =~ ^sbx-[a-z0-9]{6,32}$ ]]; then
            EXEC_CODE="400"
            EXEC_RESULT='{"success":false,"error":"invalid project slug"}'
            log "Command queue: b2b-sandbox-destroy rejected — invalid slug '$BSD_PROJECT'"
          else
            BSD_USER="${SVC_USER:-dev}"
            BSD_PROJECTS_DIR="/home/$BSD_USER/projects"
            BSD_TARGET="$BSD_PROJECTS_DIR/$BSD_PROJECT"

            # 1. Stop every preview unit that belongs to this sandbox. Multiple
            #    apps per sandbox means wildcard match on the instance name.
            #    list-units includes `state=loaded` so we catch both running
            #    and auto-restart units.
            for _u in $(systemctl list-units 'ellul-preview@*' --all --no-legend --plain 2>/dev/null | awk '{print $1}' | grep "^ellul-preview@${BSD_PROJECT}-" || true); do
              systemctl stop "$_u" 2>/dev/null || true
              systemctl reset-failed "$_u" 2>/dev/null || true
            done

            # 2. Teardown the persistent namespace (veth, overlays, PID ns).
            #    Script is idempotent; exits 0 if namespace already gone.
            if [ -x /usr/local/bin/ellul-agent-namespace ]; then
              /usr/local/bin/ellul-agent-namespace teardown "$BSD_PROJECT" 2>/dev/null || true
            fi

            # 3. Kill stragglers — opencode serve, zeroclaw daemon, dev servers,
            #    anything still CWDed inside the sandbox tree. Two passes so
            #    graceful exits land before we SIGKILL the rest.
            _kill_in_sandbox() {
              local _sig="$1"
              local _pid _cwd
              for _pid in $(ps -u "$BSD_USER" -o pid= 2>/dev/null); do
                _cwd=$(readlink -f "/proc/$_pid/cwd" 2>/dev/null || true)
                case "$_cwd" in
                  "$BSD_TARGET"|"$BSD_TARGET"/*) kill -"$_sig" "$_pid" 2>/dev/null || true ;;
                esac
              done
            }
            _kill_in_sandbox TERM
            sleep 2
            _kill_in_sandbox KILL

            # 4. Remove the workspace. --one-file-system prevents the rm from
            #    walking into any overlay mount that didn't get torn down.
            if [ -d "$BSD_TARGET" ]; then
              rm -rf --one-file-system "$BSD_TARGET" 2>/dev/null || true
            fi

            if [ -d "$BSD_TARGET" ]; then
              EXEC_CODE="500"
              EXEC_RESULT=$(jq -nc --arg p "$BSD_PROJECT" '{success: false, project: $p, error: "workspace still present after rm"}')
              log "Command queue: b2b-sandbox-destroy FAILED to remove $BSD_TARGET"
            else
              EXEC_CODE="200"
              EXEC_RESULT=$(jq -nc --arg p "$BSD_PROJECT" '{success: true, project: $p}')
              log "Command queue: b2b-sandbox-destroy cleaned $BSD_PROJECT"
            fi
          fi
          ;;

        set-auto-update)
          # Toggle the VPS's .agent-auto-update flag. Accepts payload
          # {"autoUpdate": true|false}. Writes the flag atomically and
          # returns. The sync loop picks up the new value on the next
          # heartbeat — no service restart needed.
          local SAU_VALUE
          SAU_VALUE=$(echo "$CMD_PAYLOAD" | jq -r '.autoUpdate // empty' 2>/dev/null)
          case "$SAU_VALUE" in
            true|false)
              printf '%s' "$SAU_VALUE" > "$AGENT_AUTO_UPDATE_FILE.new" 2>/dev/null
              if [ -f "$AGENT_AUTO_UPDATE_FILE.new" ]; then
                chmod 0600 "$AGENT_AUTO_UPDATE_FILE.new"
                chown root:root "$AGENT_AUTO_UPDATE_FILE.new"
                mv -Tf "$AGENT_AUTO_UPDATE_FILE.new" "$AGENT_AUTO_UPDATE_FILE"
                log "Command queue: set-auto-update → $SAU_VALUE"
                EXEC_CODE="200"
                EXEC_RESULT=$(jq -nc --arg v "$SAU_VALUE" '{success: true, autoUpdate: ($v == "true")}')

                # Fire an immediate agent-report so the dashboard sees
                # the new flag state without waiting for the next sync
                # cycle. Read the current manifest version from disk so
                # the report doesn't clobber appliedVersion with 0 —
                # set-auto-update doesn't change the applied manifest.
                local SAU_APPLIED=0
                [ -f "$AGENT_MANIFEST_VERSION_FILE" ] && \
                  SAU_APPLIED=$(tr -d '\n' < "$AGENT_MANIFEST_VERSION_FILE" | head -c 16)
                [[ "$SAU_APPLIED" =~ ^[0-9]+$ ]] || SAU_APPLIED=0
                post_agent_report "$SAU_APPLIED" "success" 2>/dev/null || true
              else
                EXEC_CODE="500"
                EXEC_RESULT='{"success":false,"error":"failed to write auto-update flag"}'
                log "Command queue: set-auto-update FAILED — could not write flag file"
              fi
              ;;
            *)
              EXEC_CODE="400"
              EXEC_RESULT='{"success":false,"error":"payload.autoUpdate must be true or false"}'
              log "Command queue: set-auto-update rejected — invalid payload"
              ;;
          esac
          ;;

        reconfigure-caddy-domain)
          # Push custom-domain config change: write /etc/ellul/custom-domain
          # (or remove it), regenerate the Caddyfile via ellul-caddy-gen,
          # validate, and reload Caddy via admin socket. Also appends the
          # custom domain to /etc/ellul/allowed-origins so sovereign-shield
          # accepts WebAuthn ceremonies from it.
          #
          # Payload: {"customDomain": "acme.com"} or {"customDomain": null}
          local RCD_DOMAIN
          RCD_DOMAIN=$(echo "$CMD_PAYLOAD" | jq -r '.customDomain // empty' 2>/dev/null)

          # Validate hostname if non-empty — same allowed-character set used
          # during provisioning. Rejects shell metacharacters and IP literals.
          if [ -n "$RCD_DOMAIN" ]; then
            if ! echo "$RCD_DOMAIN" | grep -qxE '[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?'; then
              EXEC_CODE="400"
              EXEC_RESULT='{"success":false,"error":"invalid customDomain"}'
              log "Command queue: reconfigure-caddy-domain rejected — bad hostname"
            fi
          fi

          if [ -z "$EXEC_CODE" ]; then
            # 1. Write or remove the custom-domain file (caddy-gen reads it).
            if [ -n "$RCD_DOMAIN" ]; then
              printf '%s\n' "$RCD_DOMAIN" > /etc/ellul/custom-domain
              chmod 644 /etc/ellul/custom-domain
              chown root:root /etc/ellul/custom-domain
            else
              rm -f /etc/ellul/custom-domain
            fi

            # 2. No mutation of /etc/ellul/allowed-origins — sovereign-shield
            #    reads /etc/ellul/custom-domain at request time and merges it
            #    into the origin allowlist automatically. Atomic by design.

            # 3. Regenerate Caddyfile via ellul-caddy-gen CLI (reads the
            #    updated /etc/ellul/custom-domain file).
            local MAIN_DOMAIN_VAL CODE_DOMAIN_VAL DEV_DOMAIN_VAL MODEL_VAL
            MAIN_DOMAIN_VAL=$(cat /etc/ellul/domain 2>/dev/null)
            DEV_DOMAIN_VAL=$(cat /etc/ellul/dev-domain 2>/dev/null)
            # Derive code-domain from main-domain (pattern: -srv → -code, -dc → -dcode)
            CODE_DOMAIN_VAL=$(echo "$MAIN_DOMAIN_VAL" | sed -E 's/-srv\./-code./; s/-dc\./-dcode./')
            # Deployment model: distinct from firewall-mode (ironclad trust
            # level). Read from deployment-model file with backward-compat
            # fallback to firewall-mode for older fleets where boot-config
            # hadn't yet split the two writers. Default proxied so the .app
            # wildcard block (and the dev-preview import inside it) is always
            # present unless explicitly direct.
            MODEL_VAL=$(cat /etc/ellul/deployment-model 2>/dev/null || cat /etc/ellul/firewall-mode 2>/dev/null || echo "proxied")
            case "$MODEL_VAL" in
              proxied|cloudflare|gateway) MODEL_VAL="proxied" ;;
              direct) MODEL_VAL="direct" ;;
              *) MODEL_VAL="proxied" ;;
            esac

            local RCD_TMP=/etc/caddy/Caddyfile.rcd.tmp
            if /usr/local/bin/ellul-caddy-gen \
                --model "$MODEL_VAL" \
                --main-domain "$MAIN_DOMAIN_VAL" \
                --code-domain "$CODE_DOMAIN_VAL" \
                --dev-domain "$DEV_DOMAIN_VAL" \
                > "$RCD_TMP" 2>/dev/null; then
              # Validate before applying
              if caddy validate --config "$RCD_TMP" --adapter caddyfile >/dev/null 2>&1; then
                mv -Tf "$RCD_TMP" /etc/caddy/Caddyfile
                # 664 so shield-runner (SupplementaryGroups=caddy) can
                # regenerate this file on startup. Pair chown with the
                # mode change so the ownership model is consistent even
                # if an earlier writer set root:root.
                chown caddy:caddy /etc/caddy/Caddyfile 2>/dev/null || true
                chmod 664 /etc/caddy/Caddyfile
                # Reload via admin socket (zero-downtime)
                curl -sS --unix-socket /run/caddy/admin.sock \
                  -X POST http://localhost/load \
                  -H "Content-Type: text/caddyfile" \
                  --data-binary @/etc/caddy/Caddyfile >/dev/null 2>&1 \
                  || systemctl reload caddy 2>/dev/null || true

                # Restart sovereign-shield so it re-reads allowed-origins.
                systemctl restart ellul-sovereign-shield 2>/dev/null || true

                # Restart file-api so the next dev.caddy write picks up the new
                # /etc/ellul/custom-domain value (used for frame-ancestors CSP
                # on the preview route so the customer's UI can iframe previews).
                systemctl restart ellul-file-api 2>/dev/null || true

                EXEC_CODE="200"
                EXEC_RESULT=$(jq -nc --arg d "${RCD_DOMAIN:-}" '{success: true, customDomain: $d}')
                log "Command queue: reconfigure-caddy-domain applied (domain=${RCD_DOMAIN:-<removed>})"
              else
                rm -f "$RCD_TMP"
                EXEC_CODE="500"
                EXEC_RESULT='{"success":false,"error":"Caddyfile validation failed"}'
                log "Command queue: reconfigure-caddy-domain FAILED — Caddyfile validation failed"
              fi
            else
              rm -f "$RCD_TMP"
              EXEC_CODE="500"
              EXEC_RESULT='{"success":false,"error":"caddy-gen failed"}'
              log "Command queue: reconfigure-caddy-domain FAILED — caddy-gen error"
            fi
          fi
          ;;

        update-entitlements)
          # Write signed entitlement manifest (JWS) to /etc/ellul/
          # Agent cannot modify: root:root 644. Sovereign-shield verifies ECDSA signature.
          local JWS_DATA=$(echo "$CMD_PAYLOAD" | jq -r '.jws // empty' 2>/dev/null)
          # Validate JWS format: three base64url segments separated by dots (no shell metacharacters)
          if [ -n "$JWS_DATA" ] && echo "$JWS_DATA" | grep -qxE '[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+'; then
            printf '%s\n' "$JWS_DATA" > /etc/ellul/entitlement.jws
            chmod 644 /etc/ellul/entitlement.jws
            chown root:root /etc/ellul/entitlement.jws

            # Self-heal: write pubkey if included and missing on disk
            local PUBKEY_DATA=$(echo "$CMD_PAYLOAD" | jq -r '.pubkey // empty' 2>/dev/null)
            if [ -n "$PUBKEY_DATA" ] && [ ! -f /etc/ellul/entitlement-pubkey.pem ]; then
              printf '%s\n' "$PUBKEY_DATA" > /etc/ellul/entitlement-pubkey.pem
              chmod 644 /etc/ellul/entitlement-pubkey.pem
              chown root:root /etc/ellul/entitlement-pubkey.pem
              log "Command queue: entitlement pubkey written (self-heal)"
            fi

            # Restart sovereign-shield so it picks up the new manifest.
            # The entitlement service loads the public key at module init and
            # caches verified payloads — a restart ensures fresh state.
            systemctl restart ellul-sovereign-shield 2>/dev/null || true
            EXEC_CODE="200"
            EXEC_RESULT='{"ok":true}'
            log "Command queue: entitlement manifest updated, sovereign-shield restarted"
          else
            EXEC_CODE="400"
            EXEC_RESULT='{"error":"missing jws in payload"}'
          fi
          ;;

        update-identity)
          # ── Update server identity after migration ──
          # MUST be DIRECT (not routed to file-api) because the identity update
          # restarts the enforcer. If routed via file-api, the enforcer process
          # that's waiting for the curl response gets killed by the restart,
          # and the completion report never happens → API times out.
          #
          # As a DIRECT command: enforcer runs the script, reports completion
          # to the API, THEN the script's enforcer restart takes effect on
          # the next loop iteration (or via the deferred restart below).
          #
          # IDENTITY SWAP: The script changes server-id on the boot partition.
          # The completion report (signed_api_request) reads server-id from disk
          # for the signature. After the swap, the new server-id won't match
          # the temp server record → API rejects with 403. Fix: temporarily
          # restore the old server-id for the completion report, then write
          # the new one back before the deferred restart.
          local ID_SERVER_ID=$(echo "$CMD_PAYLOAD" | jq -r '.serverId // empty' 2>/dev/null)
          local ID_DOMAIN=$(echo "$CMD_PAYLOAD" | jq -r '.domain // empty' 2>/dev/null)
          local ID_USER_ID=$(echo "$CMD_PAYLOAD" | jq -r '.userId // empty' 2>/dev/null)
          local ID_BILLING_TIER=$(echo "$CMD_PAYLOAD" | jq -r '.billingTier // empty' 2>/dev/null)
          local ID_DEPLOYMENT_MODEL=$(echo "$CMD_PAYLOAD" | jq -r '.deploymentModel // empty' 2>/dev/null)
          local ID_SECURITY_TIER=$(echo "$CMD_PAYLOAD" | jq -r '.securityTier // empty' 2>/dev/null)
          # Optional. When set, the identity script writes the value into
          # /etc/ellul/shield-data/user-locale (intent file). The next
          # heartbeat tick's apply_pending_locale propagates to
          # /etc/ellul/user-locale + /etc/environment. Closes the
          # cold-wake gap where a JP user claiming a pool server saw
          # EN MOTD until they opened the chat iframe.
          local ID_USER_LOCALE=$(echo "$CMD_PAYLOAD" | jq -r '.userLocale // empty' 2>/dev/null)

          if [ -z "$ID_SERVER_ID" ]; then
            EXEC_CODE="400"
            EXEC_RESULT='{"error":"missing serverId in payload"}'
          else
            # Cache pre-swap server-id so the completion report can authenticate
            local _PRE_SWAP_SID
            _PRE_SWAP_SID=$(cat "$SERVER_ID_FILE" 2>/dev/null | tr -d '\n')

            local ID_CMD="/usr/local/bin/ellul-update-identity --server-id=$ID_SERVER_ID"
            [ -n "$ID_DOMAIN" ] && ID_CMD="$ID_CMD --domain=$ID_DOMAIN"
            [ -n "$ID_USER_ID" ] && ID_CMD="$ID_CMD --user-id=$ID_USER_ID"
            [ -n "$ID_BILLING_TIER" ] && ID_CMD="$ID_CMD --billing-tier=$ID_BILLING_TIER"
            [ -n "$ID_DEPLOYMENT_MODEL" ] && ID_CMD="$ID_CMD --deployment-model=$ID_DEPLOYMENT_MODEL"
            [ -n "$ID_SECURITY_TIER" ] && ID_CMD="$ID_CMD --security-tier=$ID_SECURITY_TIER"
            [ -n "$ID_USER_LOCALE" ] && ID_CMD="$ID_CMD --user-locale=$ID_USER_LOCALE"

            # SKIP_ENFORCER_RESTART: the update-identity script normally restarts
            # the enforcer, but WE ARE the enforcer. If it restarts us, the
            # completion report (POST /commands/:id/complete) never fires and the
            # API times out. Instead, skip the restart in the script and schedule
            # a deferred self-restart after we report completion.
            log "update-identity: running $ID_CMD"
            local ID_OUTPUT
            # stderr → enforcer log (script logs), stdout → ID_OUTPUT (JSON result)
            ID_OUTPUT=$(SKIP_ENFORCER_RESTART=1 eval "$ID_CMD" 2>>"$LOG_FILE") || true
            local ID_SUCCESS=$(echo "$ID_OUTPUT" | jq -r '.success // false' 2>/dev/null)

            if [ "$ID_SUCCESS" = "true" ]; then
              EXEC_CODE="200"
              EXEC_RESULT="$ID_OUTPUT"
              log "update-identity: success — enforcer restart deferred until after completion report"
              # Regenerate FIM baseline after authorized system changes
              if [ -x /usr/local/bin/ellul-file-integrity ]; then
                /usr/local/bin/ellul-file-integrity regen >/dev/null 2>&1 || true
                log "update-identity: FIM baseline regenerated"
              fi

              # Restore pre-swap server-id so the completion report's signature
              # matches the temp server record. The deferred restart below will
              # pick up the new identity from the file written by the script.
              if [ -n "$_PRE_SWAP_SID" ] && [ "$_PRE_SWAP_SID" != "$ID_SERVER_ID" ]; then
                echo -n "$_PRE_SWAP_SID" > "$SERVER_ID_FILE"
                # Store new ID for restore after completion report
                _IDENTITY_SWAP_NEW_SID="$ID_SERVER_ID"
                log "update-identity: server-id temporarily restored for completion report"
              fi

              # Signal the enforcer's boot sequence to force-restart all services.
              # Services cache domain/server-id at startup (e.g. sovereign-shield
              # caches domain for WebAuthn RP ID). The deferred restart runs the
              # full boot sequence — this marker triggers start_services_idempotent
              # with force_restart so every service picks up the new identity.
              touch /run/ellul-identity-changed

              # Flag deferred restart — picked up after the completion report curl
              _DEFERRED_ENFORCER_RESTART=1
            else
              EXEC_CODE="500"
              EXEC_RESULT="$ID_OUTPUT"
              log "update-identity: failed — $ID_OUTPUT"
            fi
          fi
          ;;

        wake-mount)
          # ── Mount volume + restore vault after wake ──
          # Runs as root (DIRECT). The volume is already attached by the API.
          # This mounts it, sets up vault bind mounts, fixes ownership, persists
          # fstab, restores iptables, and restarts services.

          # ── EXACTLY-ONCE LOCK ──
          local WM_LOCK="/run/ellul-wake-mount.lock"
          if ! acquire_exec_lock "$WM_LOCK" "wake-mount"; then
            EXEC_CODE="200"
            EXEC_RESULT='{"ok":true,"skipped":"lock_contention"}'
            break
          fi

          local WM_DEVICE=$(echo "$CMD_PAYLOAD" | jq -r '.volumeDevice // empty' 2>/dev/null)
          local WM_LUKS_PASSPHRASE=""

          # ── Decrypt wrapped LUKS passphrase if present (ML-KEM encrypted) ──
          # The API encrypts the LUKS passphrase with our ML-KEM public key so it's
          # never stored in plaintext in the command queue DB row.
          # Falls back to plaintext luksPassphrase for backward compat.
          local WM_WRAPPED=$(echo "$CMD_PAYLOAD" | jq -c '.wrappedLuksPassphrase // empty' 2>/dev/null)
          if [ -n "$WM_WRAPPED" ] && [ "$WM_WRAPPED" != "empty" ] && [ "$WM_WRAPPED" != '""' ] && [ "$WM_WRAPPED" != "null" ]; then
            local WM_PRIVKEY="$IDENTITY_DIR/node.key"
            if [ -f "$WM_PRIVKEY" ] && [ -x "$CRYPTO_BIN" ]; then
              WM_LUKS_PASSPHRASE=$(echo "$WM_WRAPPED" | "$CRYPTO_BIN" decrypt --key "$WM_PRIVKEY" --stdin 2>/dev/null) || true
              if [ -n "$WM_LUKS_PASSPHRASE" ]; then
                log "wake-mount: LUKS passphrase decrypted via ML-KEM"
              else
                log "wake-mount: ML-KEM decrypt failed for wrapped passphrase — trying plaintext fallback"
              fi
            else
              log "wake-mount: node.key or ellul-crypto not available for ML-KEM decrypt — trying plaintext fallback"
            fi
          fi

          # Fallback: read plaintext passphrase (pre-PQC servers or decrypt failure)
          if [ -z "$WM_LUKS_PASSPHRASE" ]; then
            WM_LUKS_PASSPHRASE=$(echo "$CMD_PAYLOAD" | jq -r '.luksPassphrase // empty' 2>/dev/null)
          fi

          if [ -z "$WM_DEVICE" ]; then
            EXEC_CODE="400"
            EXEC_RESULT='{"error":"missing volumeDevice"}'
          else
            # Wait for device to appear (cloud attach is async).
            # Force kernel to rescan block devices — dramatically speeds up detection
            # on DigitalOcean and Hetzner where udev events are delayed.
            log "wake-mount: waiting for device $WM_DEVICE..."
            udevadm trigger --subsystem-match=block 2>/dev/null || true
            udevadm settle --timeout=10 2>/dev/null || true

            local WM_WAIT=0
            while [ ! -e "$WM_DEVICE" ] && [ $WM_WAIT -lt 60 ]; do
              # Alternate between fast checks and udev rescans
              if [ $((WM_WAIT % 5)) -eq 0 ] && [ $WM_WAIT -gt 0 ]; then
                udevadm trigger --subsystem-match=block 2>/dev/null || true
                udevadm settle --timeout=5 2>/dev/null || true
              fi
              sleep 0.5
              WM_WAIT=$((WM_WAIT + 1))
            done
            [ -e "$WM_DEVICE" ] && log "wake-mount: device appeared after ~$((WM_WAIT / 2))s"

            local WM_LUKS_OPENED=false

            if [ ! -e "$WM_DEVICE" ]; then
              EXEC_CODE="500"
              EXEC_RESULT="{\"error\":\"device $WM_DEVICE not found after 30s\"}"
            elif mountpoint -q "$SVC_HOME" 2>/dev/null; then
              # Volume already mounted (by enforcer auto-mount or fstab on reboot).
              # Still need to check vault — auto-mount doesn't set up bind mounts.
              log "wake-mount: volume already mounted, checking vault..."
              local WM_OK=true
              # Detect if already-mounted volume is LUKS (for result reporting)
              local WM_ALREADY_SRC=$(findmnt -n -o SOURCE "$SVC_HOME" 2>/dev/null || echo "")
              [[ "$WM_ALREADY_SRC" == /dev/mapper/luks-* ]] && WM_LUKS_OPENED=true
            else
              local WM_OK=true

              # Phase 1: Mount volume
              local WM_FSTYPE=$(blkid -o value -s TYPE "$WM_DEVICE" 2>/dev/null || echo "")
              local WM_FIRST_BOOT=false

              # ── Delegate to ellul-mount-volume (single source of truth for LUKS) ──
              # If LUKS detected but no passphrase from API, try local keyfile (enhanced mode).
              # If no keyfile either, bail for PRF unlock (sovereign mode).
              if [ "$WM_FSTYPE" = "crypto_LUKS" ] && [ -z "$WM_LUKS_PASSPHRASE" ]; then
                local _LOCAL_KEYFILE="/etc/ellul/.luks-platform-keyfile"
                if [ -f "$_LOCAL_KEYFILE" ]; then
                  WM_LUKS_PASSPHRASE=$(cat "$_LOCAL_KEYFILE" 2>/dev/null)
                  log "wake-mount: LUKS volume — using local platform keyfile"
                else
                  log "wake-mount: LUKS volume detected — no passphrase, awaiting unlock"
                  EXEC_CODE="200"
                  EXEC_RESULT='{"ok":true,"luksDetected":true,"awaitingUnlock":true}'
                  WM_OK=false
                fi
              fi

              if [ "$WM_OK" = "true" ]; then
                # Write passphrase to well-known tmpfs path (same path mount-volume reads)
                local LUKS_KEY_PATH="/dev/shm/.luks-platform-key"
                if [ -n "$WM_LUKS_PASSPHRASE" ]; then
                  printf '%s' "$WM_LUKS_PASSPHRASE" > "$LUKS_KEY_PATH"
                  chmod 600 "$LUKS_KEY_PATH"
                fi
                # Store keyfile on root FS for future automatic reboots (enhanced mode only).
                # Sovereign mode: the PRF key is ephemeral — user must tap passkey on every
                # boot. Writing it to disk would defeat the sovereign guarantee.
                local _SEC_MODE=""
                [ -f /etc/ellul-bootstrap/volume-security-mode ] && _SEC_MODE=$(cat /etc/ellul-bootstrap/volume-security-mode 2>/dev/null)
                if [ "$_SEC_MODE" != "sovereign" ] && [ -n "$WM_LUKS_PASSPHRASE" ]; then
                  local _WM_KEYFILE="/etc/ellul/.luks-platform-keyfile"
                  printf '%s' "$WM_LUKS_PASSPHRASE" > "$_WM_KEYFILE"
                  chown root:root "$_WM_KEYFILE"
                  chmod 400 "$_WM_KEYFILE"
                  log "wake-mount: platform keyfile stored for future boots (enhanced mode)"
                elif [ "$_SEC_MODE" = "sovereign" ]; then
                  log "wake-mount: sovereign mode — PRF key NOT persisted (ephemeral)"
                fi

                # Zeroize from memory immediately
                WM_LUKS_PASSPHRASE=""
                unset WM_LUKS_PASSPHRASE

                # Call the mount script in the global mount namespace.
                # The script handles: LUKS format (first boot), LUKS open (wake),
                # plain ext4 (legacy), skeleton backup/restore, fstab persistence.
                # Identity lives on /etc/ellul-bootstrap/ (boot partition), so vault
                # restore in the mount script is safe — it can't overwrite identity.
                local WM_MOUNT_RESULT
                WM_MOUNT_RESULT=$(/usr/local/bin/ellul-mount-volume mount "$WM_DEVICE" 2>>/var/log/ellul-enforcer.log) || true

                # Ensure key file cleaned up regardless
                rm -f "$LUKS_KEY_PATH" 2>/dev/null || true

                # Parse result
                local WM_MOUNT_SUCCESS=$(echo "$WM_MOUNT_RESULT" | jq -r '.success // .ok // empty' 2>/dev/null)
                local WM_MOUNT_LUKS=$(echo "$WM_MOUNT_RESULT" | jq -r '.luksOpened // false' 2>/dev/null)
                local WM_MOUNT_FIRST=$(echo "$WM_MOUNT_RESULT" | jq -r '.firstBoot // false' 2>/dev/null)
                local WM_MOUNT_ERROR=$(echo "$WM_MOUNT_RESULT" | jq -r '.error // empty' 2>/dev/null)
                local WM_MOUNT_LUKS_DETECTED=$(echo "$WM_MOUNT_RESULT" | jq -r '.luksDetected // false' 2>/dev/null)

                if [ "$WM_MOUNT_LUKS_DETECTED" = "true" ]; then
                  # mount-volume detected LUKS but couldn't open (key file was missing/empty)
                  log "wake-mount: LUKS volume detected by mount script — awaiting unlock"
                  EXEC_CODE="200"
                  EXEC_RESULT='{"ok":true,"luksDetected":true,"awaitingUnlock":true}'
                  WM_OK=false
                elif [ "$WM_MOUNT_SUCCESS" != "true" ]; then
                  log "wake-mount: mount script failed: $WM_MOUNT_ERROR"
                  EXEC_CODE="500"
                  EXEC_RESULT="{\"error\":\"mount script failed: $WM_MOUNT_ERROR\"}"
                  WM_OK=false
                else
                  WM_LUKS_OPENED=$WM_MOUNT_LUKS
                  local WM_FIRST_BOOT=$WM_MOUNT_FIRST
                  log "wake-mount: volume mounted at $SVC_HOME (luks=$WM_LUKS_OPENED, firstBoot=$WM_FIRST_BOOT)"
                fi
              fi
            fi

            # Phase 2: Vault bind mounts — runs for BOTH already-mounted and freshly-mounted.
            # When fstab mounts the volume at boot, bind mounts are NOT set up automatically.
            # This was previously inside the else branch, causing wake to skip vault restore.
            if [ "$WM_OK" = "true" ]; then
              local WM_VAULT="$SVC_HOME/.ellul-vault"
              if [ -f "$WM_VAULT/.initialized" ]; then
                log "wake-mount: restoring vault bind mounts..."

                # Restore UID/GID map
                if [ -f "$WM_VAULT/.gid-map" ]; then
                  while IFS=: read -r _type _name _id; do
                    case "$_type" in
                      g) getent group "$_name" >/dev/null 2>&1 || groupadd --gid "$_id" "$_name" 2>/dev/null || groupadd --system --gid "$_id" "$_name" 2>/dev/null || true ;;
                      u) id -u "$_name" >/dev/null 2>&1 || useradd --system --uid "$_id" --no-create-home --shell /usr/sbin/nologin "$_name" 2>/dev/null || true ;;
                    esac
                  done < "$WM_VAULT/.gid-map"
                  log "wake-mount: UID/GID map restored"
                fi

                # Stop services before bind-mounting over their config dirs
                systemctl stop ellul-agent-bridge 2>/dev/null || true
                systemctl stop ellul-file-api 2>/dev/null || true
                systemctl stop ellul-sovereign-shield 2>/dev/null || true
                systemctl stop caddy 2>/dev/null || true
                systemctl stop postgresql 2>/dev/null || true

                # Identity lives on /etc/ellul-bootstrap/ (never vault-bound).
                # Vault restore cannot overwrite identity — no caching needed.
                bind_mount_vault "$WM_VAULT" "wake-mount"

                # Diagnostic: log vault PG state after bind mount
                log "wake-mount: vault PG data dir exists: $([ -d /var/lib/postgresql/16/main ] && echo yes || echo NO)"
                log "wake-mount: vault PG_VERSION: $(cat /var/lib/postgresql/16/main/PG_VERSION 2>/dev/null || echo MISSING)"
                log "wake-mount: vault pg_control state: $(sudo -u postgres /usr/lib/postgresql/16/bin/pg_controldata /var/lib/postgresql/16/main 2>/dev/null | grep 'Database cluster state:' | sed 's/.*: *//' || echo UNKNOWN)"
                log "wake-mount: vault PG base dirs: $(ls /var/lib/postgresql/16/main/base/ 2>/dev/null | wc -w) databases"
                log "wake-mount: vault PG data size: $(du -sh /var/lib/postgresql/16/main/ 2>/dev/null | awk '{print $1}' || echo UNKNOWN)"

                fix_vault_ownership "wake-mount" "$SVC_USER"
                persist_fstab_mounts "$WM_VAULT" "" "wake-mount"

                # Restore iptables: prefer TARGET server's provisioning rules over vault's.
                # The vault's rules are from the OLD server (different IP/region/provider).
                # Cloud-init writes fresh rules to /var/lib/ellul-iptables-fb during provisioning.
                if [ -f /var/lib/ellul-iptables-fb/rules.v4 ] && [ -s /var/lib/ellul-iptables-fb/rules.v4 ]; then
                  cp /var/lib/ellul-iptables-fb/rules.v4 /etc/iptables/rules.v4 2>/dev/null || true
                  [ -f /var/lib/ellul-iptables-fb/rules.v6 ] && cp /var/lib/ellul-iptables-fb/rules.v6 /etc/iptables/rules.v6 2>/dev/null || true
                  log "wake-mount: iptables rules restored from target provisioning (not vault)"
                elif [ -f /etc/iptables/rules.v4 ] && [ -s /etc/iptables/rules.v4 ]; then
                  log "wake-mount: iptables rules from vault (no target fallback found)"
                fi
                iptables-restore < /etc/iptables/rules.v4 2>/dev/null || true
                [ -f /etc/iptables/rules.v6 ] && ip6tables-restore < /etc/iptables/rules.v6 2>/dev/null || true

                start_services_idempotent "wake-mount" "vault restored" "force_restart"

                # Sync boot volume markers: if LUKS was opened, ensure the bootstrap
                # partition has the encryption marker for next reboot's LUKS boot.
                # Pool servers have fresh root FS without this marker — write it now.
                if [ "$WM_LUKS_OPENED" = "true" ]; then
                  mkdir -p /etc/ellul-bootstrap 2>/dev/null
                  echo 1 > /etc/ellul-bootstrap/volume-was-encrypted 2>/dev/null
                  log "wake-mount: bootstrap encryption marker synced to boot volume"
                fi

                # For sovereign mode: create a bootstrap session so the user doesn't
                # need a second passkey tap after unlock. The PRF unlock already proves
                # passkey ownership — no need to re-authenticate.
                local WM_EXCHANGE_CODE=""
                local _SEC_MODE2=""
                [ -f /etc/ellul-bootstrap/volume-security-mode ] && _SEC_MODE2=$(cat /etc/ellul-bootstrap/volume-security-mode 2>/dev/null)
                if [ "$_SEC_MODE2" = "sovereign" ]; then
                  local _SHIELD_TOKEN=$(cat /run/shield/internal-enforcer.token 2>/dev/null || true)
                  if [ -n "$_SHIELD_TOKEN" ]; then
                    # Write the recent-unlock marker shield uses to gate
                    # bootstrap-session. File mtime is checked <=60s; shield
                    # consumes (unlinks) it after a single successful mint.
                    mkdir -p /run/shield 2>/dev/null
                    touch /run/shield/recent-prf-unlock 2>/dev/null || true
                    chmod 600 /run/shield/recent-prf-unlock 2>/dev/null || true
                    chown shield-runner:shield-ipc /run/shield/recent-prf-unlock 2>/dev/null || true

                    local _BS_RESULT
                    _BS_RESULT=$(curl -sf -X POST "http://127.0.0.1:3005/api/internal/bootstrap-session" \
                      -H "Authorization: Bearer $_SHIELD_TOKEN" \
                      -H "Content-Type: application/json" 2>/dev/null) || true
                    WM_EXCHANGE_CODE=$(echo "$_BS_RESULT" | jq -r '.exchangeCode // empty' 2>/dev/null)
                    [ -n "$WM_EXCHANGE_CODE" ] && log "wake-mount: bootstrap session created for auto-login"
                  fi
                fi

                EXEC_CODE="200"
                EXEC_RESULT="{\"ok\":true,\"vaultRestored\":true,\"luksOpened\":${WM_LUKS_OPENED},\"exchangeCode\":\"${WM_EXCHANGE_CODE}\"}"
                log "wake-mount: complete — full vault state restored (luks=$WM_LUKS_OPENED)"
                # Regenerate FIM baseline after vault restore changes system files
                if [ -x /usr/local/bin/ellul-file-integrity ]; then
                  /usr/local/bin/ellul-file-integrity regen >/dev/null 2>&1 || true
                fi
              elif [ "$WM_OK" = "true" ]; then
                # ── FIRST PROVISION: Create vault on fresh volume ──
                # Same as cloud-init generateVolumeMountSection first-boot path
                log "wake-mount: first provision — creating vault on volume"

                # Stop services before seeding vault (PG needs clean shutdown for consistent copy)
                systemctl stop ellul-agent-bridge 2>/dev/null || true
                systemctl stop ellul-file-api 2>/dev/null || true
                systemctl stop ellul-sovereign-shield 2>/dev/null || true
                systemctl stop caddy 2>/dev/null || true
                if systemctl is-active --quiet postgresql 2>/dev/null; then
                  runuser -l postgres -c "psql -c 'CHECKPOINT;'" 2>/dev/null || true
                  systemctl stop postgresql 2>/dev/null || true
                  for _pgwait in 1 2 3 4 5; do
                    pgrep -x postgres >/dev/null 2>&1 || break
                    sleep 1
                  done
                fi

                # Create vault directory structure
                mkdir -p "$WM_VAULT"
                chown root:root "$WM_VAULT"
                chmod 700 "$WM_VAULT"
                mkdir -p "$WM_VAULT/etc/ellul"
                mkdir -p "$WM_VAULT/etc/caddy"
                mkdir -p "$WM_VAULT/etc/iptables"
                mkdir -p "$WM_VAULT/etc/ssh/authorized_keys"
                chown root:shield "$WM_VAULT/etc/ssh/authorized_keys"
                chmod 770 "$WM_VAULT/etc/ssh/authorized_keys"
                mkdir -p "$WM_VAULT/var/lib/ellul-shielded"
                mkdir -p "$WM_VAULT/var/lib/postgresql"
                mkdir -p "$WM_VAULT/var/log/ellul"
                mkdir -p "$WM_VAULT/var/log/caddy"
                mkdir -p "$WM_VAULT/opt/ellul"

                # Mark vault as initialized IMMEDIATELY after creating dirs.
                # This MUST happen before seeding (cp -a) because on RAM-constrained
                # hosts, copying postgresql/opt data can take minutes due to swap
                # thrashing, exceeding the enqueueAndWait timeout. If timeout expires
                # without .initialized, the next wake wipes the vault and all user
                # data is lost. A partial seed is recoverable. A wiped vault is not.
                date -u +%Y-%m-%dT%H:%M:%SZ > "$WM_VAULT/.initialized"
                chmod 400 "$WM_VAULT/.initialized"

                # Seed vault from root FS (copy current state into vault before bind-mount)
                for _vpath in etc/ellul etc/caddy etc/iptables etc/ssh/authorized_keys \
                              var/lib/ellul-shielded var/lib/postgresql \
                              var/log/ellul var/log/caddy opt/ellul; do
                  if [ -d "/$_vpath" ] && [ "$(ls -A "/$_vpath" 2>/dev/null)" ]; then
                    cp -a "/$_vpath/." "$WM_VAULT/$_vpath/" 2>/dev/null || true
                  fi
                done
                log "wake-mount: vault seeded from root FS"

                bind_mount_vault "$WM_VAULT" "wake-mount"
                fix_vault_ownership "wake-mount" "$SVC_USER"
                persist_fstab_mounts "$WM_VAULT" "$WM_DEVICE" "wake-mount"

                # Save iptables to vault
                iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
                ip6tables-save > /etc/iptables/rules.v6 2>/dev/null || true

                # Save UID/GID map
                {
                  echo "g:shield:$(getent group shield | cut -d: -f3)"
                  echo "g:shield-ipc:$(getent group shield-ipc | cut -d: -f3)"
                  echo "g:shield-runner:$(getent group shield-runner | cut -d: -f3)"
                  getent group caddy >/dev/null && echo "g:caddy:$(getent group caddy | cut -d: -f3)"
                  id -u caddy >/dev/null 2>&1 && echo "u:caddy:$(id -u caddy)"
                  getent group postgres >/dev/null && echo "g:postgres:$(getent group postgres | cut -d: -f3)"
                  id -u postgres >/dev/null 2>&1 && echo "u:postgres:$(id -u postgres)"
                  id -u shield-runner >/dev/null 2>&1 && echo "u:shield-runner:$(id -u shield-runner)"
                  echo "u:$SVC_USER:$(id -u $SVC_USER)"
                  echo "g:$SVC_USER:$(id -g $SVC_USER)"
                } > "$WM_VAULT/.gid-map"
                chmod 600 "$WM_VAULT/.gid-map"

                # Sync boot volume markers for LUKS boot on next reboot
                if [ "$WM_LUKS_OPENED" = "true" ]; then
                  mkdir -p /etc/ellul-bootstrap 2>/dev/null
                  echo 1 > /etc/ellul-bootstrap/volume-was-encrypted 2>/dev/null
                  log "wake-mount: bootstrap encryption marker synced to boot volume"
                fi

                start_services_idempotent "wake-mount" "first provision"

                # ── Shred root FS secret remnants ──
                # Secrets were written to root FS during cloud-init (before vault existed).
                # Now safely in the vault on the encrypted volume. The root FS copies are
                # stale remnants readable in rescue mode on the unencrypted boot disk.
                # Mount root device at a temp path to reach under the bind mount.
                local _ROOT_DEV
                _ROOT_DEV=$(findmnt -n -o SOURCE / 2>/dev/null || echo "")
                if [ -n "$_ROOT_DEV" ] && [ "$WM_LUKS_OPENED" = "true" ]; then
                  local _SHRED_MNT="/tmp/.rootfs-shred-$$"
                  mkdir -p "$_SHRED_MNT"
                  if mount "$_ROOT_DEV" "$_SHRED_MNT" 2>/dev/null; then
                    local _shred_count=0
                    # Shred STALE identity remnants from /etc/ellul/ (root FS).
                    # Do NOT shred /etc/ellul-bootstrap/ — that's the LIVE identity.
                    for _sf in \
                      "$_SHRED_MNT/etc/ellul/node.key" \
                      "$_SHRED_MNT/etc/ellul/heartbeat.key" \
                      "$_SHRED_MNT/etc/ellul/heartbeat.key.json" \
                      "$_SHRED_MNT/etc/ellul/migration-sign.key" \
                      "$_SHRED_MNT/etc/ellul/jwt-secret" \
                      "$_SHRED_MNT/etc/ellul/ai-proxy-token" \
                      "$_SHRED_MNT/etc/ellul/shield-data/auth-secrets.json" \
                      "$_SHRED_MNT/etc/ellul/shield-data/.sovereign-setup-token"; do
                      if [ -f "$_sf" ]; then
                        shred -fz -n 1 "$_sf" 2>/dev/null && rm -f "$_sf" 2>/dev/null && _shred_count=$((_shred_count + 1))
                      fi
                    done
                    umount "$_SHRED_MNT" 2>/dev/null || true
                    rm -rf "$_SHRED_MNT"
                    log "wake-mount: shredded $_shred_count root FS secret remnants (vault is authoritative)"
                  else
                    rm -rf "$_SHRED_MNT"
                    log "wake-mount: WARNING — could not mount root device for secret shredding (non-fatal)"
                  fi
                fi

                EXEC_CODE="200"
                EXEC_RESULT="{\"ok\":true,\"vaultCreated\":true,\"luksOpened\":${WM_LUKS_OPENED}}"
                log "wake-mount: vault created + bind-mounted + services started (luks=$WM_LUKS_OPENED)"
              fi
            fi
          fi

          release_exec_lock "$WM_LOCK"
          ;;

        luks-format)
          # ── LUKS2 format + open on first boot ──
          # Expects: volumeDevice, luksPassphrase (or wrappedLuksPassphrase) in payload.
          # Optional: recoveryPassphrase — added as LUKS slot 1 for platform recovery / auto-wake.
          local LF_DEVICE=$(echo "$CMD_PAYLOAD" | jq -r '.volumeDevice // empty' 2>/dev/null)
          local LF_PASSPHRASE=""

          # Decrypt wrapped passphrase if present (ML-KEM encrypted)
          local LF_WRAPPED=$(echo "$CMD_PAYLOAD" | jq -c '.wrappedLuksPassphrase // empty' 2>/dev/null)
          if [ -n "$LF_WRAPPED" ] && [ "$LF_WRAPPED" != "empty" ] && [ "$LF_WRAPPED" != '""' ] && [ "$LF_WRAPPED" != "null" ]; then
            local LF_PRIVKEY="$IDENTITY_DIR/node.key"
            if [ -f "$LF_PRIVKEY" ] && [ -x "$CRYPTO_BIN" ]; then
              LF_PASSPHRASE=$(echo "$LF_WRAPPED" | "$CRYPTO_BIN" decrypt --key "$LF_PRIVKEY" --stdin 2>/dev/null) || true
              [ -n "$LF_PASSPHRASE" ] && log "luks-format: LUKS passphrase decrypted via ML-KEM"
            fi
          fi
          # Fallback: plaintext passphrase
          [ -z "$LF_PASSPHRASE" ] && LF_PASSPHRASE=$(echo "$CMD_PAYLOAD" | jq -r '.luksPassphrase // empty' 2>/dev/null)

          local LF_RECOVERY=$(echo "$CMD_PAYLOAD" | jq -r '.recoveryPassphrase // empty' 2>/dev/null)

          if [ -z "$LF_DEVICE" ] || [ -z "$LF_PASSPHRASE" ]; then
            EXEC_CODE="400"
            EXEC_RESULT='{"error":"missing volumeDevice or luksPassphrase"}'
          else
            local LF_HOME="${PS_HOME:-/home/${PS_USER:-dev}}"
            local LF_USER="${PS_USER:-dev}"
            local LF_VAULT="$LF_HOME/.ellul-vault"
            local LF_SNAPSHOT="/tmp/.ellul-home-snapshot-$$"

            # ── Phase 1: Snapshot home directory to tmpfs ──
            # The volume holds the user's home AND the vault. LUKS format wipes
            # everything, so we snapshot the entire home dir first. The vault
            # will be re-seeded from root FS, but home dir files (.bashrc, .node,
            # projects/, etc.) only exist on the volume.
            log "luks-format: snapshotting home directory..."
            mkdir -p "$LF_SNAPSHOT"
            # Copy everything EXCEPT the vault (it'll be re-seeded from root FS)
            rsync -a --exclude='.ellul-vault' --exclude='lost+found' \
              "$LF_HOME/" "$LF_SNAPSHOT/" 2>/dev/null || \
              cp -a "$LF_HOME/." "$LF_SNAPSHOT/" 2>/dev/null || true
            # Remove vault from snapshot if rsync wasn't available
            rm -rf "$LF_SNAPSHOT/.ellul-vault" 2>/dev/null

            # ── Phase 1b: Snapshot ALL live vault-backed paths ──
            # Bind mounts redirect writes to the vault on the volume. Root FS
            # copies are STALE from provisioning time. Snapshot every bind-mounted
            # path while mounts are still active — this captures the LIVE data
            # (PostgreSQL, passkeys, secrets, SSH keys, Caddy config, etc.).
            # After LUKS format + vault re-creation, these are overlaid onto the
            # new vault, ensuring zero data loss.
            #
            # CRITICAL: Stop ALL services that write to vault-backed paths BEFORE
            # the snapshot. cp -a of live databases (PG data dir, SQLite WAL)
            # creates inconsistent state. Stopping services ensures clean
            # shutdown markers so restored copies start without recovery.
            # Shield writes session/auth data to local-auth.db (SQLite WAL).
            # PG writes to its data dir. Both must be quiescent before copy.
            touch /run/ellul-luks-format.lock
            systemctl stop ellul-agent-bridge ellul-file-api ellul-watchdog \
              ellul-term-proxy ellul-preview ellul-perf-monitor 2>/dev/null || true
            systemctl stop ellul-sovereign-shield 2>/dev/null || true
            systemctl stop caddy 2>/dev/null || true
            if systemctl is-active --quiet postgresql 2>/dev/null; then
              runuser -l postgres -c "psql -c 'CHECKPOINT;'" 2>/dev/null || true
              systemctl stop postgresql 2>/dev/null || true
              for _pgwait in 1 2 3 4 5; do
                pgrep -x postgres >/dev/null 2>&1 || break
                sleep 1
              done
            fi
            log "luks-format: all services stopped before vault snapshot"

            local LF_VAULT_SNAP="/tmp/.ellul-vault-snapshot-$$"
            mkdir -p "$LF_VAULT_SNAP"
            for _live_path in etc/ellul etc/caddy etc/iptables etc/ssh/authorized_keys \
                              var/lib/ellul-shielded var/lib/postgresql \
                              var/log/ellul var/log/caddy opt/ellul; do
              if [ -d "/$_live_path" ] && [ "$(ls -A "/$_live_path" 2>/dev/null)" ]; then
                mkdir -p "$LF_VAULT_SNAP/$_live_path"
                cp -a "/$_live_path/." "$LF_VAULT_SNAP/$_live_path/" 2>/dev/null || true
              fi
            done
            log "luks-format: vault live state snapshotted ($(du -sh "$LF_VAULT_SNAP" 2>/dev/null | awk '{print $1}'))"
            log "luks-format: snapshot complete ($(du -sh "$LF_SNAPSHOT" 2>/dev/null | awk '{print $1}'))"

            # ── Phase 2: Kill user processes + prepare unmount ──
            # Services already stopped in Phase 1b (before vault snapshot).
            # Kill PM2 and ALL user processes — they hold open FDs on /home/dev
            log "luks-format: killing all user processes for $LF_USER..."
            runuser -l "$LF_USER" -c "pm2 kill" 2>/dev/null || true
            pkill -9 -u "$LF_USER" 2>/dev/null || true
            sleep 2
            pkill -9 -u "$LF_USER" 2>/dev/null || true

            # Disable ALL fstab entries (device + vault bind mounts) + mask mount units.
            # systemd auto-generates .mount units from fstab and will re-mount
            # the device if we unmount without disabling the source first.
            # Comment out EVERYTHING related to the volume — device entries AND
            # vault bind mounts (they source from the volume).
            log "luks-format: disabling fstab + systemd mount units..."
            sed -i 's|^/dev/sdb |#LUKS-TEMP# /dev/sdb |' /etc/fstab 2>/dev/null || true
            sed -i 's|^/dev/disk/by-id/scsi-0HC_Volume|#LUKS-TEMP# /dev/disk/by-id/scsi-0HC_Volume|' /etc/fstab 2>/dev/null || true
            sed -i 's|^/dev/mapper/luks-home |#LUKS-TEMP# /dev/mapper/luks-home |' /etc/fstab 2>/dev/null || true
            sed -i 's|^/home/.*/\.ellul-vault/|#LUKS-TEMP# &|' /etc/fstab 2>/dev/null || true

            # Stop and mask ALL vault-related mount units
            local _HOME_MOUNT="home-${SVC_USER}.mount"
            systemctl stop "$_HOME_MOUNT" 2>/dev/null || true
            systemctl mask "$_HOME_MOUNT" 2>/dev/null || true
            for _mp in etc-ellul etc-caddy etc-iptables etc-ssh-authorized_keys \
                       var-lib-ellul\\x2dshielded var-lib-postgresql \
                       var-log-ellul var-log-caddy opt-ellul; do
              systemctl stop "${_mp}.mount" 2>/dev/null || true
              systemctl mask "${_mp}.mount" 2>/dev/null || true
            done
            systemctl daemon-reload 2>/dev/null || true
            sleep 1

            # ── Phase 3: Unmount vault bind mounts + volume ──
            local LF_REAL_DEV=$(readlink -f "$LF_DEVICE" 2>/dev/null || echo "$LF_DEVICE")

            # If volume is already LUKS (previous attempt succeeded but post-format failed),
            # close the dm-crypt mapping first. dm-crypt holds the raw device exclusively.
            if [ -b /dev/mapper/luks-home ]; then
              log "luks-format: existing LUKS mapping found — unmounting and closing"
              # Unmount mapper device mounts (these won't match the raw device grep below)
              while IFS= read -r _mpt; do
                [ -z "$_mpt" ] && continue
                fuser -km "$_mpt" 2>/dev/null || true
                umount -f "$_mpt" 2>/dev/null || umount -l "$_mpt" 2>/dev/null || true
              done < <(tac /proc/mounts | grep 'mapper/luks-home' | awk '{print $2}')
              cryptsetup luksClose luks-home 2>/dev/null || true
              sleep 1
              [ -b /dev/mapper/luks-home ] && log "luks-format: WARN — luksClose failed, will retry after unmount"
            fi

            # Unmount ALL mounts sourced from the volume device (bind mounts + main)
            log "luks-format: unmounting all mounts from $LF_REAL_DEV..."
            local _iter=0
            while [ $_iter -lt 5 ]; do
              local _any_unmounted=false
              while IFS= read -r _mpt; do
                [ -z "$_mpt" ] && continue
                fuser -km "$_mpt" 2>/dev/null || true
                umount -f "$_mpt" 2>/dev/null || umount -l "$_mpt" 2>/dev/null || true
                _any_unmounted=true
              done < <(tac /proc/mounts | awk -v dev="$LF_REAL_DEV" '$1 == dev {print $2}')
              # Also try by symlink name
              while IFS= read -r _mpt; do
                [ -z "$_mpt" ] && continue
                fuser -km "$_mpt" 2>/dev/null || true
                umount -f "$_mpt" 2>/dev/null || umount -l "$_mpt" 2>/dev/null || true
                _any_unmounted=true
              done < <(tac /proc/mounts | grep "scsi-0HC_Volume" | awk '{print $2}')
              [ "$_any_unmounted" = "false" ] && break
              sleep 1
              _iter=$((_iter + 1))
            done

            # Close LUKS if still open (retry after all mounts cleared)
            if [ -b /dev/mapper/luks-home ]; then
              log "luks-format: closing LUKS mapping after unmount"
              cryptsetup luksClose luks-home 2>/dev/null || true
            fi

            # Log remaining mounts
            local _remaining=$(grep "$(basename $LF_REAL_DEV)" /proc/mounts 2>/dev/null | awk '{print $2}' | tr '\n' ' ')
            [ -n "$_remaining" ] && log "luks-format: mounts still present: $_remaining" || log "luks-format: all mounts cleared"

            # Flush kernel buffers and settle device state
            sync
            blockdev --flushbufs "$LF_REAL_DEV" 2>/dev/null || true
            wipefs -a "$LF_REAL_DEV" 2>/dev/null || true
            udevadm settle --timeout=10 2>/dev/null || true
            sleep 2

            # ── Phase 4: LUKS format with retry ──
            # No O_EXCL pre-check — cryptsetup handles device access itself.
            # After lazy unmount the kernel may hold a transient reference that
            # fails O_EXCL but doesn't prevent cryptsetup from operating.
            # Retry loop handles the case where the kernel hasn't released yet.
            log "luks-format: formatting $LF_DEVICE as LUKS2..."
            local LF_FMT_OK=false
            local LF_FMT_ATTEMPT=0
            while [ $LF_FMT_ATTEMPT -lt 12 ]; do
              local LF_FMT_ERR=$(mktemp /tmp/luks-fmt-err-XXXXXX)
              if printf '%s' "$LF_PASSPHRASE" | cryptsetup luksFormat \
                --type luks2 --cipher aes-xts-plain64 --key-size 512 \
                --hash sha256 --pbkdf argon2id --pbkdf-memory 262144 --pbkdf-parallel 2 \
                --key-file=- --batch-mode "$LF_DEVICE" 2>"$LF_FMT_ERR"; then
                rm -f "$LF_FMT_ERR"
                LF_FMT_OK=true
                break
              fi
              local _fmt_err=$(cat "$LF_FMT_ERR" 2>/dev/null)
              rm -f "$LF_FMT_ERR"
              # Only retry on EBUSY (device busy) — other errors are fatal
              if echo "$_fmt_err" | grep -qi "busy\|in use\|Device or resource busy"; then
                LF_FMT_ATTEMPT=$((LF_FMT_ATTEMPT + 1))
                log "luks-format: device busy, retry $LF_FMT_ATTEMPT/12 (waiting 5s)..."
                sleep 5
              else
                log "luks-format: FAILED (non-busy error): $_fmt_err"
                break
              fi
            done

            if [ "$LF_FMT_OK" != "true" ]; then
              log "luks-format: FAILED after $LF_FMT_ATTEMPT retries"
              # Restore fstab and unmask ALL mount units on failure
              sed -i 's|^#LUKS-TEMP# ||' /etc/fstab 2>/dev/null || true
              systemctl unmask "home-${SVC_USER}.mount" 2>/dev/null || true
              for _mp in etc-ellul etc-caddy etc-iptables etc-ssh-authorized_keys \
                         var-lib-ellul\\x2dshielded var-lib-postgresql \
                         var-log-ellul var-log-caddy opt-ellul; do
                systemctl unmask "${_mp}.mount" 2>/dev/null || true
              done
              systemctl daemon-reload 2>/dev/null || true
              rm -f /run/ellul-luks-format.lock
              EXEC_CODE="500"
              EXEC_RESULT='{"success":false,"error":"cryptsetup luksFormat failed after retries"}'
              rm -rf "$LF_SNAPSHOT" "$LF_VAULT_SNAP" 2>/dev/null
              LF_PASSPHRASE=""; unset LF_PASSPHRASE
            else
              log "luks-format: LUKS2 format successful (attempt $((LF_FMT_ATTEMPT + 1)))"

              # ── CRITICAL: Update fstab + marker IMMEDIATELY after LUKS format ──
              # If any later step fails (mount, vault, services), the server must
              # still boot correctly on reboot. These writes are idempotent.
              # The failure path must NOT revert these — the volume IS encrypted now.
              sed -i "s|^/dev/sdb $SVC_HOME |/dev/mapper/luks-home $SVC_HOME |" /etc/fstab 2>/dev/null || true
              sed -i "s|^/dev/disk/by-id/scsi-0HC_Volume[^ ]* $SVC_HOME |/dev/mapper/luks-home $SVC_HOME |" /etc/fstab 2>/dev/null || true
              echo 1 > /etc/ellul/volume-was-encrypted 2>/dev/null
              # Dual-write to boot volume (never vault-bound) for LUKS boot script.
              mkdir -p /etc/ellul-bootstrap 2>/dev/null
              echo 1 > /etc/ellul-bootstrap/volume-was-encrypted 2>/dev/null
              log "luks-format: fstab updated to /dev/mapper/luks-home + encryption marker set"

              # ── Phase 5: Add recovery key (slot 1) + store keyfile ──
              if [ -n "$LF_RECOVERY" ]; then
                log "luks-format: adding recovery key as slot 1..."
                local LF_TMPKEY="/dev/shm/.luks-primary-$$"
                printf '%s' "$LF_PASSPHRASE" > "$LF_TMPKEY"; chmod 600 "$LF_TMPKEY"
                printf '%s' "$LF_RECOVERY" | cryptsetup luksAddKey \
                  --pbkdf pbkdf2 --pbkdf-force-iterations 1000 \
                  --key-file="$LF_TMPKEY" "$LF_DEVICE" - 2>&1 && \
                  log "luks-format: recovery key added" || \
                  log "luks-format: WARNING — recovery key add failed (non-fatal)"
                shred -fz -n 1 "$LF_TMPKEY" 2>/dev/null; rm -f "$LF_TMPKEY"

                # Store platform passphrase as root-only keyfile on ROOT filesystem
                # (not vault — vault is ON the encrypted volume). This enables
                # automatic LUKS opening on reboot via crypttab (enhanced mode).
                local LF_KEYFILE="/etc/ellul/.luks-platform-keyfile"
                printf '%s' "$LF_RECOVERY" > "$LF_KEYFILE"
                chown root:root "$LF_KEYFILE"
                chmod 400 "$LF_KEYFILE"
                log "luks-format: platform keyfile stored at $LF_KEYFILE"

                # LUKS auto-open on boot is handled by ellul-luks-boot.service
                # (not crypttab — Hetzner volumes aren't ready at systemd-cryptsetup time)

                LF_RECOVERY=""; unset LF_RECOVERY
              fi

              # ── Phase 5.5: Backup LUKS header on root FS ──
              # Immediately after format, before any keyslot operations.
              # Stored on ROOT FS (not vault — vault is on the encrypted volume).
              local LF_HEADER_DIR="/etc/ellul/luks-headers"
              mkdir -p "$LF_HEADER_DIR" && chmod 700 "$LF_HEADER_DIR"
              if cryptsetup luksHeaderBackup "$LF_DEVICE" \
                --header-backup-file "$LF_HEADER_DIR/header-initial.img" 2>&1; then
                chmod 600 "$LF_HEADER_DIR/header-initial.img"
                log "luks-format: initial LUKS header backed up to $LF_HEADER_DIR"
              else
                log "luks-format: WARNING — header backup failed (non-fatal)"
              fi

              # ── Phase 6: Open + format filesystem + mount ──
              log "luks-format: opening LUKS volume..."
              local LF_OPEN_ERR=$(mktemp /tmp/luks-open-err-XXXXXX)
              if ! printf '%s' "$LF_PASSPHRASE" | cryptsetup luksOpen \
                --key-file=- "$LF_DEVICE" luks-home 2>"$LF_OPEN_ERR"; then
                log "luks-format: luksOpen FAILED: $(cat "$LF_OPEN_ERR" 2>/dev/null)"
                rm -f "$LF_OPEN_ERR"; rm -rf "$LF_SNAPSHOT" "$LF_VAULT_SNAP" 2>/dev/null
                LF_PASSPHRASE=""; unset LF_PASSPHRASE
                EXEC_CODE="500"
                EXEC_RESULT='{"success":false,"error":"cryptsetup luksOpen failed"}'
              else
                rm -f "$LF_OPEN_ERR"
                LF_PASSPHRASE=""; unset LF_PASSPHRASE
                log "luks-format: LUKS volume opened"

                log "luks-format: creating ext4 filesystem..."
                if ! mkfs.ext4 -L ellul-home /dev/mapper/luks-home 2>&1; then
                  rm -rf "$LF_SNAPSHOT" "$LF_VAULT_SNAP" 2>/dev/null
                  EXEC_CODE="500"
                  EXEC_RESULT='{"success":false,"error":"mkfs.ext4 failed"}'
                else
                  mkdir -p "$LF_HOME" 2>/dev/null
                  log "luks-format: mounting at $LF_HOME..."
                  # Mount in BOTH namespaces:
                  # - PID 1's namespace: bind_mount_vault uses nsenter and needs the mount visible there
                  # - Enforcer's namespace: cp/rsync/vault-seed run locally and need the mount here
                  mkdir -p "$LF_HOME" 2>/dev/null
                  mount -o nosuid,nodev /dev/mapper/luks-home "$LF_HOME" 2>/dev/null || true
                  if ! mountpoint -q "$LF_HOME" 2>/dev/null; then
                    log "luks-format: FATAL — $LF_HOME not mounted in either namespace"
                    rm -rf "$LF_SNAPSHOT" "$LF_VAULT_SNAP" 2>/dev/null
                    EXEC_CODE="500"
                    EXEC_RESULT='{"success":false,"error":"mount failed"}'
                  else

                    # ── Phase 7: Restore home directory from snapshot ──
                    log "luks-format: restoring home directory from snapshot..."
                    cp -a "$LF_SNAPSHOT/." "$LF_HOME/" 2>/dev/null || true
                    rm -rf "$LF_SNAPSHOT"
                    chown "$LF_USER:$LF_USER" "$LF_HOME"
                    log "luks-format: home directory restored"

                    # ── Phase 8: Recreate vault (same as wake-mount first provision) ──
                    log "luks-format: creating vault..."
                    mkdir -p "$LF_VAULT"
                    chown root:root "$LF_VAULT"; chmod 700 "$LF_VAULT"
                    for _vdir in etc/ellul etc/caddy etc/iptables etc/ssh/authorized_keys \
                                 var/lib/ellul-shielded var/lib/postgresql \
                                 var/log/ellul var/log/caddy opt/ellul; do
                      mkdir -p "$LF_VAULT/$_vdir"
                    done
                    chown root:shield "$LF_VAULT/etc/ssh/authorized_keys"
                    chmod 770 "$LF_VAULT/etc/ssh/authorized_keys"
                    date -u +%Y-%m-%dT%H:%M:%SZ > "$LF_VAULT/.initialized"
                    chmod 400 "$LF_VAULT/.initialized"

                    # Restore vault from live snapshot (Phase 1b).
                    # The snapshot has the LIVE data from bind-mounted paths —
                    # PostgreSQL, passkeys, secrets, SSH keys, Caddy config, etc.
                    # Root FS seed is only a fallback for paths the snapshot missed
                    # (e.g., first encryption before any vault existed).
                    if [ -d "$LF_VAULT_SNAP" ]; then
                      for _vpath in etc/ellul etc/caddy etc/iptables etc/ssh/authorized_keys \
                                    var/lib/ellul-shielded var/lib/postgresql \
                                    var/log/ellul var/log/caddy opt/ellul; do
                        if [ -d "$LF_VAULT_SNAP/$_vpath" ]; then
                          cp -a "$LF_VAULT_SNAP/$_vpath/." "$LF_VAULT/$_vpath/" 2>/dev/null || true
                        elif [ -d "/$_vpath" ] && [ "$(ls -A "/$_vpath" 2>/dev/null)" ]; then
                          # Fallback: root FS copy (only if snapshot didn't have it)
                          cp -a "/$_vpath/." "$LF_VAULT/$_vpath/" 2>/dev/null || true
                        fi
                      done
                      rm -rf "$LF_VAULT_SNAP"
                      log "luks-format: vault restored from live snapshot (PostgreSQL, secrets, passkeys, SSH keys, Caddy config)"
                    else
                      # No snapshot (shouldn't happen) — fall back to root FS seed
                      for _vpath in etc/ellul etc/caddy etc/iptables etc/ssh/authorized_keys \
                                    var/lib/ellul-shielded var/lib/postgresql \
                                    var/log/ellul var/log/caddy opt/ellul; do
                        if [ -d "/$_vpath" ] && [ "$(ls -A "/$_vpath" 2>/dev/null)" ]; then
                          cp -a "/$_vpath/." "$LF_VAULT/$_vpath/" 2>/dev/null || true
                        fi
                      done
                      log "luks-format: WARNING — no vault snapshot, seeded from root FS (data may be stale)"
                    fi

                    # Restore fstab + unmask ALL mount units BEFORE bind mounts
                    sed -i '/^#LUKS-TEMP#/d' /etc/fstab 2>/dev/null || true
                    systemctl unmask "home-${SVC_USER}.mount" 2>/dev/null || true
                    for _mp in etc-ellul etc-caddy etc-iptables etc-ssh-authorized_keys \
                               var-lib-ellul\\x2dshielded var-lib-postgresql \
                               var-log-ellul var-log-caddy opt-ellul; do
                      systemctl unmask "${_mp}.mount" 2>/dev/null || true
                    done
                    systemctl daemon-reload 2>/dev/null || true

                    # Bind mounts + ownership + fstab
                    # Use mapper device (/dev/mapper/luks-home) for fstab, not raw device
                    bind_mount_vault "$LF_VAULT" "luks-format"

                    # Verify bind mounts succeeded — atomic: all-or-nothing
                    local _bind_ok=true
                    for _verify_path in etc/ellul etc/caddy opt/ellul; do
                      if ! mountpoint -q "/$_verify_path" 2>/dev/null; then
                        log "luks-format: CRITICAL — bind mount /$_verify_path not active after bind_mount_vault"
                        _bind_ok=false
                      fi
                    done
                    if [ "$_bind_ok" != "true" ]; then
                      log "luks-format: FATAL — bind mounts failed, aborting (data preserved on LUKS volume)"
                      rm -f /run/ellul-luks-format.lock
                      EXEC_CODE="500"
                      EXEC_RESULT='{"success":false,"error":"post-encryption bind mounts failed — reboot to recover","needsReboot":true}'
                    else

                    fix_vault_ownership "luks-format" "$LF_USER"
                    persist_fstab_mounts "$LF_VAULT" "/dev/mapper/luks-home" "luks-format"

                    # Save iptables + UID/GID map to vault
                    iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
                    ip6tables-save > /etc/iptables/rules.v6 2>/dev/null || true
                    {
                      echo "g:shield:$(getent group shield | cut -d: -f3)"
                      echo "g:shield-ipc:$(getent group shield-ipc | cut -d: -f3)"
                      echo "g:shield-runner:$(getent group shield-runner | cut -d: -f3)"
                      getent group caddy >/dev/null && echo "g:caddy:$(getent group caddy | cut -d: -f3)"
                      id -u caddy >/dev/null 2>&1 && echo "u:caddy:$(id -u caddy)"
                      getent group postgres >/dev/null && echo "g:postgres:$(getent group postgres | cut -d: -f3)"
                      id -u postgres >/dev/null 2>&1 && echo "u:postgres:$(id -u postgres)"
                      id -u shield-runner >/dev/null 2>&1 && echo "u:shield-runner:$(id -u shield-runner)"
                      echo "u:$LF_USER:$(id -u $LF_USER)"
                      echo "g:$LF_USER:$(id -g $LF_USER)"
                    } > "$LF_VAULT/.gid-map"
                    chmod 600 "$LF_VAULT/.gid-map"

                    # (encryption marker already written in Phase 4)

                    # Start services
                    # Remove lock file before restarting services
                    rm -f /run/ellul-luks-format.lock
                    start_services_idempotent "luks-format" "post-encryption"

                    log "luks-format: complete — LUKS2 formatted, home restored, vault recreated, services started"
                    EXEC_CODE="200"
                    EXEC_RESULT='{"success":true,"luksFormatted":true}'
                    fi # bind mount verification
                  fi
                fi
              fi
            fi
          fi
          # Always clean up lock file
          rm -f /run/ellul-luks-format.lock
          ;;

        luks-rekey)
          # ── Rotate or remove LUKS2 passphrase ──
          # Actions:
          #   "rotate" (default): Expects volumeDevice, oldPassphrase, newPassphrase
          #   "remove-platform-key": Expects volumeDevice, removeSlotKey — transitions to sovereign mode
          local LR_DEVICE=$(echo "$CMD_PAYLOAD" | jq -r '.volumeDevice // empty' 2>/dev/null)
          local LR_ACTION=$(echo "$CMD_PAYLOAD" | jq -r '.action // "rotate"' 2>/dev/null)

          if [ "$LR_ACTION" = "remove-platform-key" ]; then
            # ── Remove platform key from LUKS (Enhanced → Sovereign) ──
            local LR_SLOT_KEY=$(echo "$CMD_PAYLOAD" | jq -r '.removeSlotKey // empty' 2>/dev/null)

            if [ -z "$LR_DEVICE" ] || [ -z "$LR_SLOT_KEY" ]; then
              EXEC_CODE="400"
              EXEC_RESULT='{"error":"missing volumeDevice or removeSlotKey"}'
            else
              log "luks-rekey: removing platform key from $LR_DEVICE (sovereign transition)..."

              # Header backup before keyslot removal
              local LR_BACKUP_DIR="$SVC_HOME/.ellul-vault/luks-headers"
              mkdir -p "$LR_BACKUP_DIR" 2>/dev/null
              chmod 700 "$LR_BACKUP_DIR" 2>/dev/null
              local LR_BACKUP_FILE="$LR_BACKUP_DIR/header-$(date +%Y%m%d-%H%M%S)-pre-sovereign.img"
              if cryptsetup luksHeaderBackup "$LR_DEVICE" --header-backup-file "$LR_BACKUP_FILE" 2>&1; then
                chmod 600 "$LR_BACKUP_FILE"
                ls -t "$LR_BACKUP_DIR"/header-*.img 2>/dev/null | tail -n +6 | xargs -r rm -f
                log "luks-rekey: header backed up before sovereign transition"
              else
                log "luks-rekey: WARNING — header backup failed, proceeding"
              fi

              # Remove the platform key from LUKS
              printf '%s' "$LR_SLOT_KEY" > /dev/shm/.luks-remove-key
              chmod 600 /dev/shm/.luks-remove-key

              if cryptsetup luksRemoveKey --key-file=/dev/shm/.luks-remove-key "$LR_DEVICE" 2>&1; then
                rm -f /dev/shm/.luks-remove-key

                # Destroy the platform keyfile from ALL locations.
                # The keyfile exists in up to 3 places:
                #   1. Vault copy (accessed via bind mount at /etc/ellul/)
                #   2. Root FS copy (hidden under bind mount, written before mount)
                #   3. Vault direct path ($SVC_HOME/.ellul-vault/etc/ellul/)
                # On reboot, luks-boot reads from root FS (before bind mounts) — if
                # the root FS copy survives, it auto-opens LUKS and sovereign is defeated.
                local LR_KEYFILE="/etc/ellul/.luks-platform-keyfile"
                local LR_VAULT_KEYFILE="$SVC_HOME/.ellul-vault/etc/ellul/.luks-platform-keyfile"
                # 1. Shred via bind mount (vault copy)
                shred -fz -n 3 "$LR_KEYFILE" 2>/dev/null || rm -f "$LR_KEYFILE" 2>/dev/null || true
                # 2. Shred vault direct path (same file, but explicit)
                shred -fz -n 3 "$LR_VAULT_KEYFILE" 2>/dev/null || rm -f "$LR_VAULT_KEYFILE" 2>/dev/null || true
                # 3. Shred root FS copy hidden under bind mount.
                #    Temporarily unmount, shred, re-mount.
                if mountpoint -q /etc/ellul 2>/dev/null; then
                  umount /etc/ellul 2>/dev/null || true
                  shred -fz -n 3 /etc/ellul/.luks-platform-keyfile 2>/dev/null || rm -f /etc/ellul/.luks-platform-keyfile 2>/dev/null || true
                  mount --bind "$SVC_HOME/.ellul-vault/etc/ellul" /etc/ellul 2>/dev/null || true
                  log "luks-rekey: root FS keyfile shredded (under bind mount)"
                fi
                log "luks-rekey: platform keyfile destroyed from all locations"

                # Write sovereign marker to bootstrap partition (root FS, never bind-mounted).
                # luks-boot and enforcer boot check this FIRST — if sovereign, they skip the
                # keyfile entirely. Defense-in-depth: even if a keyfile copy survives somehow,
                # the marker prevents auto-open.
                mkdir -p /etc/ellul-bootstrap 2>/dev/null
                echo "sovereign" > /etc/ellul-bootstrap/volume-security-mode 2>/dev/null
                chmod 444 /etc/ellul-bootstrap/volume-security-mode 2>/dev/null
                log "luks-rekey: sovereign marker written to bootstrap partition"

                # Shred the pre-sovereign header backups — they contain slot 0's
                # PBKDF parameters, which, combined with the now-destroyed
                # platform passphrase, would allow offline re-opening of the
                # volume if an operator had exfiltrated the backup earlier.
                # After a successful sovereign transition, the pre-sovereign
                # header has no legitimate restore path (we never go back), so
                # destroying it tightens the invariant.
                for LR_OLD_HDR in "$LR_BACKUP_DIR"/header-*-pre-sovereign.img; do
                  [ -f "$LR_OLD_HDR" ] || continue
                  shred -fz -n 3 "$LR_OLD_HDR" 2>/dev/null || rm -f "$LR_OLD_HDR" 2>/dev/null || true
                done
                log "luks-rekey: pre-sovereign header backups shredded"

                LR_SLOT_KEY=""; unset LR_SLOT_KEY
                log "luks-rekey: platform key removed — sovereign mode active"
                EXEC_CODE="200"
                EXEC_RESULT='{"ok":true,"success":true,"platformKeyRemoved":true}'
              else
                rm -f /dev/shm/.luks-remove-key
                LR_SLOT_KEY=""; unset LR_SLOT_KEY
                log "luks-rekey: FAILED — cryptsetup luksRemoveKey error"
                EXEC_CODE="500"
                EXEC_RESULT='{"ok":false,"success":false,"error":"cryptsetup luksRemoveKey failed"}'
              fi
            fi
          else
            # ── Rotate passphrase (existing behavior) ──
            local LR_OLD=$(echo "$CMD_PAYLOAD" | jq -r '.oldPassphrase // empty' 2>/dev/null)
            local LR_NEW=$(echo "$CMD_PAYLOAD" | jq -r '.newPassphrase // empty' 2>/dev/null)

          if [ -z "$LR_DEVICE" ] || [ -z "$LR_OLD" ] || [ -z "$LR_NEW" ]; then
            EXEC_CODE="400"
            EXEC_RESULT='{"error":"missing volumeDevice, oldPassphrase, or newPassphrase"}'
          else
            log "luks-rekey: rotating LUKS passphrase on $LR_DEVICE..."

            # ── Header backup before key rotation (defense-in-depth) ──
            # API should have already sent luks-header-backup, but we protect locally.
            # Failed luksChangeKey can corrupt the LUKS header — backup first.
            local LR_BACKUP_DIR="$SVC_HOME/.ellul-vault/luks-headers"
            mkdir -p "$LR_BACKUP_DIR" 2>/dev/null
            chmod 700 "$LR_BACKUP_DIR" 2>/dev/null
            local LR_BACKUP_FILE="$LR_BACKUP_DIR/header-$(date +%Y%m%d-%H%M%S)-pre-rekey.img"
            if cryptsetup luksHeaderBackup "$LR_DEVICE" --header-backup-file "$LR_BACKUP_FILE" 2>&1; then
              chmod 600 "$LR_BACKUP_FILE"
              # Rotate: keep max 5 backups
              ls -t "$LR_BACKUP_DIR"/header-*.img 2>/dev/null | tail -n +6 | xargs -r rm -f
              log "luks-rekey: header backed up to $LR_BACKUP_FILE"
            else
              log "luks-rekey: WARNING — header backup failed, proceeding anyway (API backup should exist)"
            fi

            printf '%s' "$LR_NEW" > /dev/shm/.luks-new-key
            chmod 600 /dev/shm/.luks-new-key

            if printf '%s' "$LR_OLD" | \
              cryptsetup luksChangeKey --key-file=- --new-keyfile=/dev/shm/.luks-new-key "$LR_DEVICE" 2>&1; then

              # Update platform keyfile so next reboot uses the new passphrase
              local LR_KEYFILE="/etc/ellul/.luks-platform-keyfile"
              if [ -f "$LR_KEYFILE" ]; then
                printf '%s' "$LR_NEW" > "$LR_KEYFILE"
                chown root:root "$LR_KEYFILE"
                chmod 400 "$LR_KEYFILE"
                log "luks-rekey: platform keyfile updated"
              fi

              rm -f /dev/shm/.luks-new-key
              LR_OLD=""; LR_NEW=""
              unset LR_OLD LR_NEW

              log "luks-rekey: passphrase rotated"
              EXEC_CODE="200"
              EXEC_RESULT='{"ok":true,"rekeyed":true}'
            else
              rm -f /dev/shm/.luks-new-key
              LR_OLD=""; LR_NEW=""
              unset LR_OLD LR_NEW

              log "luks-rekey: FAILED — cryptsetup luksChangeKey returned error"
              EXEC_CODE="500"
              EXEC_RESULT='{"ok":false,"error":"cryptsetup luksChangeKey failed"}'
            fi
          fi
          fi
          ;;

        luks-close)
          # ── Pre-hibernate: stop services, unmount volume, close LUKS ──
          # Runs as root (DIRECT). Previously delegated to file-api, but file-api
          # runs inside the mount namespace and fuser -kvm kills the calling process.
          # The enforcer runs from /usr/local/bin/ with no open fds on /home —
          # it can safely kill processes, unmount, and close LUKS.
          log "luks-close: stopping all services..."

          # Stop all services that use the volume
          systemctl stop ellul-agent-bridge ellul-file-api ellul-watchdog \
            ellul-term-proxy ellul-preview ellul-perf-monitor 2>/dev/null || true
          systemctl stop ellul-sovereign-shield 2>/dev/null || true
          systemctl stop caddy 2>/dev/null || true
          if systemctl is-active --quiet postgresql 2>/dev/null; then
            runuser -l postgres -c "psql -c 'CHECKPOINT;'" 2>/dev/null || true
            systemctl stop postgresql 2>/dev/null || true
          fi
          # Stop all ttyd instances
          for _ttyd_unit in $(systemctl list-units 'ttyd@*' --state=active --no-legend 2>/dev/null | awk '{print $1}'); do
            systemctl stop "$_ttyd_unit" 2>/dev/null || true
          done

          # Kill remaining user processes on the home directory
          pkill -9 -u "$SVC_USER" 2>/dev/null || true
          sleep 1

          # Sync and unmount
          sync
          for _iter in 1 2 3; do
            if ! mountpoint -q "$SVC_HOME" 2>/dev/null; then break; fi
            # Unmount bind mounts first (reverse order)
            for _mp in /opt/ellul /var/log/caddy /var/log/ellul \
                       /var/lib/postgresql /var/lib/ellul-shielded \
                       /etc/iptables /etc/caddy /etc/ellul; do
              mountpoint -q "$_mp" 2>/dev/null && umount "$_mp" 2>/dev/null || true
            done
            # Then unmount the home directory
            umount "$SVC_HOME" 2>/dev/null || umount -l "$SVC_HOME" 2>/dev/null || true
            sleep 1
          done

          # Close LUKS container (wipes decryption key from kernel RAM)
          if [ -b /dev/mapper/luks-home ]; then
            cryptsetup luksClose luks-home 2>/dev/null || true
            log "luks-close: LUKS container closed"
          else
            log "luks-close: no LUKS mapping (plain volume or already closed)"
          fi

          log "luks-close: complete"
          EXEC_CODE="200"
          EXEC_RESULT='{"success":true}'
          ;;

        luks-header-backup)
          # ── Backup LUKS2 header to vault ──
          # Called before mode changes, key rotation, or on-demand.
          # Header backup enables recovery from corruption during keyslot operations.
          # Keeps max 5 backups (rotates oldest).
          local LHB_DEVICE=$(echo "$CMD_PAYLOAD" | jq -r '.volumeDevice // empty' 2>/dev/null)
          local LHB_REASON=$(echo "$CMD_PAYLOAD" | jq -r '.reason // "manual"' 2>/dev/null)

          if [ -z "$LHB_DEVICE" ]; then
            EXEC_CODE="400"
            EXEC_RESULT='{"error":"missing volumeDevice"}'
          else
            local LHB_BACKUP_DIR="$SVC_HOME/.ellul-vault/luks-headers"
            mkdir -p "$LHB_BACKUP_DIR"
            chmod 700 "$LHB_BACKUP_DIR"
            local LHB_BACKUP_FILE="$LHB_BACKUP_DIR/header-$(date +%Y%m%d-%H%M%S)-${LHB_REASON}.img"

            if cryptsetup luksHeaderBackup "$LHB_DEVICE" --header-backup-file "$LHB_BACKUP_FILE" 2>&1; then
              chmod 600 "$LHB_BACKUP_FILE"
              # Rotate: keep max 5 backups
              ls -t "$LHB_BACKUP_DIR"/header-*.img 2>/dev/null | tail -n +6 | xargs -r rm -f

              local LHB_COUNT
              LHB_COUNT=$(ls -1 "$LHB_BACKUP_DIR"/header-*.img 2>/dev/null | wc -l)
              log "luks-header-backup: backed up $LHB_DEVICE to $LHB_BACKUP_FILE (reason=$LHB_REASON, total=$LHB_COUNT)"
              EXEC_CODE="200"
              EXEC_RESULT=$(jq -n \
                --arg file "$LHB_BACKUP_FILE" \
                --arg reason "$LHB_REASON" \
                --argjson count "$LHB_COUNT" \
                '{ok:true, backupFile:$file, reason:$reason, totalBackups:$count}')
            else
              log "luks-header-backup: FAILED to backup $LHB_DEVICE"
              EXEC_CODE="500"
              EXEC_RESULT='{"error":"cryptsetup luksHeaderBackup failed"}'
            fi
          fi
          ;;

        stop-postgresql)
          # ── Stop PostgreSQL cleanly before hibernate ──
          # Runs as root (DIRECT, self-updating via daemon-update).
          # Ensures all PG buffers (including pg_database catalog) are flushed to disk.
          # Without this, CREATE DATABASE writes data files (fsynced) but the catalog
          # entry stays in shared_buffers — lost on volume detach.
          if systemctl is-active --quiet postgresql 2>/dev/null; then
            sudo -u postgres psql -c "CHECKPOINT;" >/dev/null 2>&1 || true
            systemctl stop postgresql 2>/dev/null || true
            # Wait for PG to fully stop
            for _spw in $(seq 1 10); do
              systemctl is-active --quiet postgresql 2>/dev/null || break
              sleep 1
            done
            EXEC_CODE="200"
            EXEC_RESULT='{"ok":true,"stopped":true}'
            log "stop-postgresql: cleanly stopped (checkpoint + shutdown)"
          else
            EXEC_CODE="200"
            EXEC_RESULT='{"ok":true,"stopped":false,"reason":"not_running"}'
            log "stop-postgresql: already stopped"
          fi
          ;;

        read-public-key)
          # ── Read ML-KEM-1024 public key + ML-DSA-65 signing key + ML-DSA-44 heartbeat key ──
          # Runs as root (DIRECT). Returns all public keys from disk.
          # Used by the API to update its stored keys after wake-mount replaces the
          # cloud-init-generated keys with the vault's keys.
          #
          # Generate migration signing key if it doesn't exist yet (boot partition).
          # Must happen HERE so the API has the key BEFORE block-migrate-upload runs.
          if [ ! -f "$IDENTITY_DIR/migration-sign.key" ] && [ -x "$CRYPTO_BIN" ]; then
            "$CRYPTO_BIN" keygen sign \
              --private-out "$IDENTITY_DIR/migration-sign.key" \
              --public-out "$IDENTITY_DIR/migration-sign.pub.json" 2>/dev/null
            chmod 600 "$IDENTITY_DIR/migration-sign.key" 2>/dev/null
            chmod 644 "$IDENTITY_DIR/migration-sign.pub.json" 2>/dev/null
            chown root:root "$IDENTITY_DIR/migration-sign.key" "$IDENTITY_DIR/migration-sign.pub.json" 2>/dev/null
            log "read-public-key: generated ML-DSA-65 migration signing keypair"
          fi
          if [ -f "$IDENTITY_DIR/node.pub.json" ]; then
            local RPK_PUB
            RPK_PUB=$(cat "$IDENTITY_DIR/node.pub.json" 2>/dev/null)
            if [ -n "$RPK_PUB" ]; then
              local MLDSA_PK=""
              if [ -f "$IDENTITY_DIR/migration-sign.pub.json" ]; then
                MLDSA_PK=$(jq -r '.mldsa_pk // empty' "$IDENTITY_DIR/migration-sign.pub.json" 2>/dev/null)
              fi
              # Include ML-DSA-44 heartbeat signing public key (for re-registration after wake)
              local RPK_HB=""
              if [ -f "$IDENTITY_DIR/heartbeat.pub.json" ]; then
                RPK_HB=$(cat "$IDENTITY_DIR/heartbeat.pub.json" 2>/dev/null)
              fi
              EXEC_CODE="200"
              EXEC_RESULT=$(jq -n \
                --arg pk "$RPK_PUB" \
                --arg mldsa "$MLDSA_PK" \
                --arg hb "$RPK_HB" \
                '{ok:true, publicKey:$pk, migrationSigningPublicKey:$mldsa, heartbeatPublicKey:$hb}')
            else
              EXEC_CODE="500"
              EXEC_RESULT='{"error":"failed to read ML-KEM public key from node.pub.json"}'
            fi
          else
            EXEC_CODE="404"
            EXEC_RESULT='{"error":"node.pub.json not found"}'
          fi
          ;;

        rotate-to-pqc)
          # ── PQC Key Rotation: Generate new ML-KEM keypair ──
          # Generates a fresh ML-KEM-1024 keypair using ellul-crypto,
          # writes to /etc/ellul/node.{key,pub.json}, and returns
          # the new public key so the API can update its DB record.
          # The next heartbeat will also report the new publicKeyVersion.
          local RTP_CRYPTO="/usr/local/bin/ellul-crypto"
          if [ ! -x "$RTP_CRYPTO" ]; then
            EXEC_CODE="500"
            EXEC_RESULT='{"error":"ellul-crypto binary not found"}'
          else
            # Back up existing keys before rotation
            if [ -f "$IDENTITY_DIR/node.key" ]; then
              cp "$IDENTITY_DIR/node.key" "$IDENTITY_DIR/node.key.bak.$(date +%s)" 2>/dev/null || true
            fi

            # Generate new ML-KEM-1024 keypair to boot partition
            if $RTP_CRYPTO keygen kem --out-dir "$IDENTITY_DIR" 2>/tmp/pqc-keygen-err.log; then
              # Fix permissions: private key readable by shield group only
              chown root:shield "$IDENTITY_DIR/node.key" 2>/dev/null && chmod 640 "$IDENTITY_DIR/node.key" 2>/dev/null || true
              chown root:root "$IDENTITY_DIR/node.pub.json" 2>/dev/null && chmod 644 "$IDENTITY_DIR/node.pub.json" 2>/dev/null || true

              local RTP_PUB
              RTP_PUB=$(cat "$IDENTITY_DIR/node.pub.json" 2>/dev/null)
              if [ -n "$RTP_PUB" ]; then
                EXEC_CODE="200"
                EXEC_RESULT=$(jq -n --arg pk "$RTP_PUB" '{"ok":true,"publicKey":$pk,"rotated":true}')
                log "rotate-to-pqc: new ML-KEM-1024 keypair generated"
              else
                EXEC_CODE="500"
                EXEC_RESULT='{"error":"keygen succeeded but node.pub.json is empty"}'
              fi
            else
              local RTP_ERR
              RTP_ERR=$(cat /tmp/pqc-keygen-err.log 2>/dev/null | head -5)
              EXEC_CODE="500"
              EXEC_RESULT=$(jq -n --arg e "$RTP_ERR" '{"error":"keygen failed","details":$e}')
              log "rotate-to-pqc: keygen failed: $RTP_ERR"
            fi
            rm -f /tmp/pqc-keygen-err.log
          fi
          ;;

        block-migrate-upload)
          # ── INLINE: Tears down LUKS + vault, reads raw blocks, uploads to R2 ──
          # Cannot use `timeout` — it only works on executables, not shell functions.
          # Bounded execution is enforced by timeouts on every internal command
          # (systemctl stop 60s, cryptsetup 10s, dmsetup 10s, curl 120s per chunk).
          # API-side stale claim detection (reconciliation.service.ts) provides the
          # outer safety net: if the upload exceeds expiresAt, it's marked failed
          # and re-enqueued.
          log "block-migrate-upload: starting (payload_len=${#CMD_PAYLOAD})"
          EXEC_RESULT=$(block_migrate_upload "$CMD_PAYLOAD")
          log "block-migrate-upload: finished (result_len=${#EXEC_RESULT} result_prefix=${EXEC_RESULT:0:200})"
          if echo "$EXEC_RESULT" | jq -e '.success == true' >/dev/null 2>&1; then
            EXEC_CODE="200"
          else
            EXEC_CODE="500"
            log "block-migrate-upload: FAILED — result: ${EXEC_RESULT:0:500}"
          fi
          ;;

        block-migrate-download)
          # ── INLINE: Same as upload — tears down LUKS on target, writes raw blocks ──
          # Cannot use `timeout` — it only works on executables, not shell functions.
          # Bounded execution is enforced by timeouts on every internal command
          # (systemctl stop 60s, luksClose 10s, dmsetup 10s, fuser 5s, umount 10s,
          # luksOpen 30s/60s, curl 120s per chunk, dd bounded by chunk size).
          # API-side stale claim detection provides the outer safety net.
          log "block-migrate-download: starting (payload_len=${#CMD_PAYLOAD})"
          EXEC_RESULT=$(block_migrate_download "$CMD_PAYLOAD")
          log "block-migrate-download: finished (result_len=${#EXEC_RESULT} result_prefix=${EXEC_RESULT:0:200})"
          if echo "$EXEC_RESULT" | jq -e '.success == true' >/dev/null 2>&1; then
            EXEC_CODE="200"
          else
            EXEC_CODE="500"
            log "block-migrate-download: FAILED — result: ${EXEC_RESULT:0:500}"
          fi
          ;;

        git-setup)
          # ── Git repo init + remote setup after API links a repo ──
          # Called via command queue after POST /api/git/servers/:id/link.
          # Delegates to sovereign-shield's /_internal/git-setup which runs
          # git-setup.sh (git init + remote add + optional pull).
          # Auth: per-service IPC token (enforcer reads from /run/shield/).
          local GS_APP=$(echo "$CMD_PAYLOAD" | jq -r '.appName // empty' 2>/dev/null)
          if [ -z "$GS_APP" ]; then
            EXEC_CODE="400"
            EXEC_RESULT='{"error":"missing appName in git-setup payload"}'
          else
            local GS_TOKEN
            GS_TOKEN=$(cat /run/shield/internal-enforcer.token 2>/dev/null)
            if [ -z "$GS_TOKEN" ]; then
              EXEC_CODE="500"
              EXEC_RESULT='{"error":"enforcer IPC token not available"}'
            else
              local GS_RESPONSE
              GS_RESPONSE=$(curl -s -w "\n%{http_code}" --connect-timeout 5 --max-time 60 \
                -X POST \
                -H "Authorization: Bearer $GS_TOKEN" \
                -H "x-service-name: enforcer" \
                -H "Content-Type: application/json" \
                -d "{\"sandboxId\":\"$GS_APP\"}" \
                "http://127.0.0.1:3005/_internal/git-setup" 2>/dev/null)
              EXEC_CODE=$(echo "$GS_RESPONSE" | tail -1)
              EXEC_RESULT=$(echo "$GS_RESPONSE" | sed '$d')
              log "git-setup: $GS_APP completed (HTTP $EXEC_CODE)"
            fi
          fi
          ;;

        re-attest)
          # ── Re-run hardening attestation checks ──
          # Triggered by API when commissioningState is "failed" or "pending".
          # Runs the same checks as provisioning hardening-attestation.sh,
          # signs the report, and posts to provision-progress.
          log "re-attest: running hardening attestation checks..."

          local RA_SSH="false"
          sshd -T 2>/dev/null | grep -qi "passwordauthentication no" && RA_SSH="true"

          local RA_SUDO="true"
          sudo -l -U "$SVC_USER" 2>/dev/null | grep -q "NOPASSWD: ALL" && RA_SUDO="false"

          local RA_FW="false"
          if command -v iptables >/dev/null 2>&1; then
            local RA_RULES=$(iptables -S 2>/dev/null | grep -v "^-P " | wc -l)
            [ "$RA_RULES" -gt 0 ] && RA_FW="true"
          fi

          local RA_SSHIMM="false"
          if lsattr /etc/ssh/sshd_config 2>/dev/null | grep -q "i"; then
            RA_SSHIMM="true"
          elif [ -f /etc/ssh/sshd_config.d/ellul.conf ]; then
            RA_SSHIMM="true"
          fi

          local RA_SUDOIMM="true"
          for ra_script in /usr/local/bin/ellul-agent-namespace /usr/local/bin/ellul-netns-helper; do
            if [ -f "$ra_script" ] && ! lsattr "$ra_script" 2>/dev/null | grep -q "i"; then
              RA_SUDOIMM="false"; break
            fi
          done

          local RA_WARDEN="false"
          if [ "$FIREWALL_MODE" = "full_ironclad" ]; then
            curl -sf http://127.0.0.1:8081/_health >/dev/null 2>&1 && RA_WARDEN="true"
          else
            RA_WARDEN="true"
          fi

          local RA_SHIELD="false"
          curl -sf http://127.0.0.1:3005/health >/dev/null 2>&1 && RA_SHIELD="true"

          local RA_SECCOMP="false"
          [ -x /usr/local/bin/ellul-seccomp-exec ] && RA_SECCOMP="true"

          local RA_KERNEL="false"
          local RA_PTRACE=$(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null)
          [ "$RA_PTRACE" = "1" ] || [ "$RA_PTRACE" = "2" ] || [ "$RA_PTRACE" = "3" ] && RA_KERNEL="true"

          local RA_TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
          local RA_SID=$(cat "$IDENTITY_DIR/server-id" 2>/dev/null || echo "unknown")
          local RA_VER=$(cat /etc/ellul/current-version 2>/dev/null || echo "unknown")

          local RA_REPORT
          RA_REPORT=$(cat <<RAEOF
{
  "serverId": "$RA_SID",
  "timestamp": "$RA_TS",
  "platformVersion": "$RA_VER",
  "checks": {
    "noPasswordSsh": $RA_SSH,
    "noBroadSudo": $RA_SUDO,
    "firewallActive": $RA_FW,
    "sshConfigImmutable": $RA_SSHIMM,
    "sudoScriptsImmutable": $RA_SUDOIMM,
    "wardenRunning": $RA_WARDEN,
    "shieldBoundLocalhost": $RA_SHIELD,
    "seccompInstalled": $RA_SECCOMP,
    "kernelHardeningApplied": $RA_KERNEL
  }
}
RAEOF
)

          # Sign with ML-DSA-44
          local RA_EPOCH=$(date +%s)
          local RA_SIGN_DATA="${RA_EPOCH}:${RA_SID}"
          local RA_SIG=""
          if [ -f "$IDENTITY_DIR/heartbeat.key.json" ] && command -v ellul-crypto >/dev/null 2>&1; then
            local RA_TMP=$(mktemp)
            printf '%s' "$RA_SIGN_DATA" > "$RA_TMP"
            RA_SIG=$(ellul-crypto sign \
              --key "$IDENTITY_DIR/heartbeat.key.json" \
              --input "$RA_TMP" \
              --algorithm mldsa44 2>/dev/null || echo "")
            rm -f "$RA_TMP"
          fi

          local RA_TOKEN=$(get_token)
          local RA_BODY
          RA_BODY=$(cat <<RABEOF
{
  "token": "$RA_TOKEN",
  "step": "hardening_attested",
  "version": "$RA_VER",
  "hardeningReport": $RA_REPORT,
  "hardeningSignature": "$RA_SIG",
  "signatureTimestamp": "$RA_EPOCH"
}
RABEOF
)

          local RA_RESULT
          RA_RESULT=$(curl -sf -X POST \
            -H "Authorization: Bearer $RA_TOKEN" \
            -H "Content-Type: application/json" \
            -d "$RA_BODY" \
            "${API_URL}/api/servers/provision-progress" 2>&1 || echo "CURL_FAILED")

          if echo "$RA_RESULT" | grep -q '"success":true'; then
            log "re-attest: PASSED — server is now workload-eligible"
            EXEC_CODE="200"
            EXEC_RESULT='{"ok":true,"status":"attested"}'
          else
            log "re-attest: FAILED — $RA_RESULT"
            EXEC_CODE="400"
            EXEC_RESULT=$(echo "$RA_RESULT" | jq -c '.' 2>/dev/null || echo '{"error":"attestation failed"}')
          fi
          ;;

        update-signing-keyring)
          local KR_JSON
          KR_JSON=$(echo "$CMD_PAYLOAD" | jq -r '.keyring // empty' 2>/dev/null)
          if [ -z "$KR_JSON" ]; then
            EXEC_CODE="400"
            EXEC_RESULT='{"error":"empty keyring"}'
          else
            local KR_VER
            KR_VER=$(echo "$KR_JSON" | jq -r '.version // empty' 2>/dev/null)
            if [ "$KR_VER" != "3" ]; then
              EXEC_CODE="400"
              EXEC_RESULT="{\"error\":\"expected version 3, got $KR_VER\"}"
            elif ! echo "$KR_JSON" | jq -e '.mldsa_pk' >/dev/null 2>&1; then
              EXEC_CODE="400"
              EXEC_RESULT='{"error":"keyring missing top-level mldsa_pk"}'
            elif ! echo "$KR_JSON" | jq -e '.keys | length > 0' >/dev/null 2>&1; then
              EXEC_CODE="400"
              EXEC_RESULT='{"error":"keyring has empty keys array"}'
            else
              local KR_TMP
              KR_TMP=$(mktemp /etc/ellul/.command-signing-XXXXXX)
              echo "$KR_JSON" > "$KR_TMP"
              chmod 644 "$KR_TMP"
              mv "$KR_TMP" /etc/ellul/command-signing.pub

              local KR_ACTIVE_PK
              KR_ACTIVE_PK=$(echo "$KR_JSON" | jq -r '.mldsa_pk // empty' 2>/dev/null)
              if [ -n "$KR_ACTIVE_PK" ]; then
                echo "$KR_ACTIVE_PK" > /etc/ellul/entitlement-pubkey.pem
                chmod 644 /etc/ellul/entitlement-pubkey.pem
              fi

              systemctl restart ellul-sovereign-shield 2>/dev/null || true
              EXEC_CODE="200"
              EXEC_RESULT='{"ok":true,"status":"v3 keyring installed"}'
              log "update-signing-keyring: installed v3 key ring, restarted sovereign-shield"
            fi
          fi
          ;;

        byos-migrate-restore)
          log "byos-migrate-restore: starting (payload_len=${#CMD_PAYLOAD})"
          local BMR_TOKEN
          BMR_TOKEN=$(cat /run/shield/internal-enforcer.token 2>/dev/null)
          if [ -z "$BMR_TOKEN" ]; then
            EXEC_CODE="500"
            EXEC_RESULT='{"error":"enforcer IPC token not available"}'
          else
            local BMR_RESPONSE
            BMR_RESPONSE=$(curl -s -w "\n%{http_code}" --connect-timeout 10 --max-time 1800 \
              -X POST \
              -H "Authorization: Bearer $BMR_TOKEN" \
              -H "x-service-name: enforcer" \
              -H "Content-Type: application/json" \
              -d "$CMD_PAYLOAD" \
              "http://127.0.0.1:3005/api/internal/migration/restore" 2>/dev/null)
            EXEC_CODE=$(echo "$BMR_RESPONSE" | tail -1)
            EXEC_RESULT=$(echo "$BMR_RESPONSE" | sed '$d')
            log "byos-migrate-restore: completed (HTTP $EXEC_CODE)"
          fi
          ;;

        byos-migrate-export)
          log "byos-migrate-export: starting (payload_len=${#CMD_PAYLOAD})"
          local BME_TOKEN
          BME_TOKEN=$(cat /run/shield/internal-enforcer.token 2>/dev/null)
          if [ -z "$BME_TOKEN" ]; then
            EXEC_CODE="500"
            EXEC_RESULT='{"error":"enforcer IPC token not available"}'
          else
            local BME_RESPONSE
            BME_RESPONSE=$(curl -s -w "\n%{http_code}" --connect-timeout 10 --max-time 1800 \
              -X POST \
              -H "Authorization: Bearer $BME_TOKEN" \
              -H "x-service-name: enforcer" \
              -H "Content-Type: application/json" \
              -d "$CMD_PAYLOAD" \
              "http://127.0.0.1:3005/api/internal/migration/export" 2>/dev/null)
            EXEC_CODE=$(echo "$BME_RESPONSE" | tail -1)
            EXEC_RESULT=$(echo "$BME_RESPONSE" | sed '$d')
            log "byos-migrate-export: completed (HTTP $EXEC_CODE)"
          fi
          ;;

        *)
          EXEC_CODE="400"
          EXEC_RESULT='{"error":"unknown direct command"}'
          ;;
      esac
    elif [ -z "$INTERNAL_JWT" ]; then
      # Routed command but no JWT — sovereign-shield/PG must be down.
      # Skip this command; it will be retried on the next heartbeat.
      EXEC_CODE="503"
      EXEC_RESULT='{"error":"JWT unavailable — sovereign-shield not ready"}'
      log "Command $CMD_ID: skipping routed command $CMD_TYPE (no JWT)"
    elif [ "$METHOD" = "POST" ]; then
      EXEC_RESULT=$(curl -s -w "\n%{http_code}" --connect-timeout 5 --max-time 300 \
        -X POST \
        -H "Authorization: Bearer $INTERNAL_JWT" \
        -H "Content-Type: application/json" \
        -d "$CMD_PAYLOAD" \
        "http://127.0.0.1:3002${ENDPOINT_PATH}" 2>/dev/null)
      EXEC_CODE=$(echo "$EXEC_RESULT" | tail -1)
      EXEC_RESULT=$(echo "$EXEC_RESULT" | sed '$d')
    else
      EXEC_RESULT=$(curl -s -w "\n%{http_code}" --connect-timeout 5 --max-time 30 \
        -H "Authorization: Bearer $INTERNAL_JWT" \
        "http://127.0.0.1:3002${ENDPOINT_PATH}" 2>/dev/null)
      EXEC_CODE=$(echo "$EXEC_RESULT" | tail -1)
      EXEC_RESULT=$(echo "$EXEC_RESULT" | sed '$d')
    fi

    local EXEC_BODY="$EXEC_RESULT"

    # Report result back to API
    local REPORT_PAYLOAD
    if [ "$EXEC_CODE" = "200" ]; then
      REPORT_PAYLOAD=$(jq -n --argjson result "$EXEC_BODY" '{success: true, result: $result}' 2>/dev/null || echo '{"success": true}')
    else
      local ERR_MSG=$(echo "$EXEC_BODY" | jq -r '.error // "Unknown error"' 2>/dev/null || echo "HTTP $EXEC_CODE")
      REPORT_PAYLOAD=$(jq -n --arg error "$ERR_MSG" '{success: false, error: $error}' 2>/dev/null || echo '{"success": false, "error": "execution failed"}')
    fi

    # Report completion with retry — a lost report leaves the command "claimed"
    # forever, hanging the entire migration state machine. Three attempts with
    # escalating timeouts. Log the HTTP status on every attempt.
    local _report_ok=false
    for _report_attempt in 1 2 3; do
      local _report_http
      _report_http=$(signed_api_request -s -o /dev/null -w "%{http_code}" \
        --connect-timeout 5 --max-time $((10 * _report_attempt)) \
        -X POST \
        -d "$REPORT_PAYLOAD" \
        "$API_URL/api/servers/commands/$CMD_ID/complete" 2>/dev/null) || _report_http="000"
      if [ "$_report_http" = "200" ]; then
        _report_ok=true
        break
      fi
      log "Command $CMD_ID completion report failed (attempt $_report_attempt/3, HTTP $_report_http)"
      [ "$_report_attempt" -lt 3 ] && sleep 2
    done
    if [ "$_report_ok" = "true" ]; then
      log "Command queue: $CMD_TYPE ($CMD_ID) -> HTTP $EXEC_CODE (reported)"
    else
      log "Command queue: $CMD_TYPE ($CMD_ID) -> HTTP $EXEC_CODE (REPORT FAILED — API will detect stale claim)"
    fi

    # Restore new server-id after completion report (identity swap).
    # The update-identity handler temporarily reverted the server-id so the
    # completion report could authenticate against the temp server record.
    # Now restore the new identity before the deferred restart picks it up.
    if [ -n "${_IDENTITY_SWAP_NEW_SID:-}" ]; then
      echo -n "$_IDENTITY_SWAP_NEW_SID" > "$SERVER_ID_FILE"
      log "update-identity: server-id restored to $( echo "$_IDENTITY_SWAP_NEW_SID" | head -c 8)..."
      _IDENTITY_SWAP_NEW_SID=""
    fi

    # Deferred enforcer restart: update-identity sets this flag because restarting
    # the enforcer BEFORE reporting completion would kill this process and lose
    # the completion report. Now that the report is sent, DO NOT restart yet —
    # continue processing remaining commands in this batch first. The restart
    # happens AFTER the command loop exits, ensuring all pending commands
    # (e.g., read-public-key queued right after update-identity) complete first.
    if [ "${_DEFERRED_ENFORCER_RESTART:-0}" = "1" ]; then
      log "update-identity: enforcer restart deferred — processing remaining commands first"
    fi

    i=$((i+1))
  done

  return 0  # commands were processed — caller should poll again immediately
}

# Ship recent log lines to the API log-drain endpoint (fire-and-forget)
LOG_SHIP_COUNTER=0
ship_logs() {
  local TOKEN=$(get_token)
  [ -z "$TOKEN" ] && return

  local BATCHES="[]"

  # Collect last 50 lines from enforcer log
  if [ -f /var/log/ellul-enforcer.log ]; then
    local ENFORCER_LINES=$(tail -50 /var/log/ellul-enforcer.log 2>/dev/null | jq -R -s '[split("\n") | .[] | select(. != "") | {ts: (now | todate), msg: .}]' 2>/dev/null || echo "[]")
    BATCHES=$(echo "$BATCHES" | jq --argjson lines "$ENFORCER_LINES" '. + [{source: "enforcer", lines: $lines}]' 2>/dev/null || echo "$BATCHES")
  fi

  # Collect last 50 lines from sovereign-shield log
  if [ -f /var/log/ellul-sovereign-shield.log ]; then
    local SHIELD_LINES=$(tail -50 /var/log/ellul-sovereign-shield.log 2>/dev/null | jq -R -s '[split("\n") | .[] | select(. != "") | {ts: (now | todate), msg: .}]' 2>/dev/null || echo "[]")
    BATCHES=$(echo "$BATCHES" | jq --argjson lines "$SHIELD_LINES" '. + [{source: "sovereign-shield", lines: $lines}]' 2>/dev/null || echo "$BATCHES")
  fi

  local PAYLOAD=$(jq -n --argjson batches "$BATCHES" '{batches: $batches}')
  signed_api_request -s -o /dev/null --connect-timeout 5 --max-time 10 \
    -X POST \
    -d "$PAYLOAD" \
    "$API_URL/api/servers/log-drain" || true
}
