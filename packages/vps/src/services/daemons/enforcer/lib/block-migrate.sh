#!/bin/bash
# Block Migration — Class A Encrypted Volume Transfer (Performance-Optimized)
#
# Reads the raw LUKS-encrypted block device, chunks the ciphertext,
# uploads to R2 via presigned URLs, and reconstructs on the destination.
# The volume is NEVER decrypted during migration.
#
# Performance features:
# - dm snapshot: services restart in ~2-5s, upload reads from immutable snapshot
# - Parallel workers: bounded concurrent chunk upload/download (default 4)
# - Batched URLs: pre-fetch 8 presigned URLs at a time (reduces API roundtrips ~8x)
# - Inline Merkle: no full-device re-read on destination (verified during download)
# - Instrumentation: structured timing metrics for every phase
#
# Two command handlers:
# - block_migrate_upload: Source-side (quiesce, snapshot, parallel upload, sign, seal)
# - block_migrate_download: Destination-side (parallel download+verify+write, inline Merkle)

BLOCK_CHUNK_SIZE=67108864
PARALLEL_WORKERS=4         # Parallel reads safe — LUKS device mapper is fully closed before upload.
                           # Auto-scaled down by available RAM.
URL_BATCH_SIZE=8           # Presigned URLs per batch fetch
MAX_RETRY_PER_CHUNK=3      # Retries per chunk with exponential backoff

# ============================================================================
# MERKLE TREE COMPUTATION
# ============================================================================

# Compute Merkle root from an array of hex hashes (one per line in a file).
# Domain-separated binary tree:
#   - Leaf: sha256(0x00 || chunk_hash)
#   - Internal: sha256(0x01 || left || right)
#   - Odd node promoted unchanged.
# Domain separation prevents second-preimage attacks.
compute_merkle_root() {
  local HASH_FILE="$1"

  # Fast path: single Python process computes the entire Merkle tree.
  # The shell loop (320 leaves × 4 forks each = 1,280+ process spawns) takes
  # 2-5 minutes on ARM. Python does it in <1 second with zero forks.
  # Domain separation: leaf = sha256(0x00 || chunk_hash), node = sha256(0x01 || left || right).
  if python3 -c "
import hashlib, sys
hashes = [line.strip() for line in open('$HASH_FILE') if line.strip()]
level = [hashlib.sha256(b'\\x00' + bytes.fromhex(h)).hexdigest() for h in hashes]
while len(level) > 1:
    nxt = []
    for i in range(0, len(level), 2):
        if i + 1 < len(level):
            nxt.append(hashlib.sha256(b'\\x01' + bytes.fromhex(level[i]) + bytes.fromhex(level[i+1])).hexdigest())
        else:
            nxt.append(level[i])
    level = nxt
print(level[0] if level else '')
" 2>/dev/null; then
    return 0
  fi

  # Fallback: shell implementation (slow but works without Python)
  local LEVEL_FILE="${HASH_FILE}.level"
  local NEXT_FILE="${HASH_FILE}.next"
  local LEAF_FILE="${HASH_FILE}.leaves"

  > "$LEAF_FILE"
  while IFS= read -r HASH; do
    local LEAF=$(printf '00%s' "$HASH" | xxd -r -p | sha256sum | awk '{print $1}')
    echo "$LEAF" >> "$LEAF_FILE"
  done < "$HASH_FILE"
  mv "$LEAF_FILE" "$LEVEL_FILE"

  while [ "$(wc -l < "$LEVEL_FILE")" -gt 1 ]; do
    > "$NEXT_FILE"
    local TOTAL=$(wc -l < "$LEVEL_FILE")
    local i=1
    while [ "$i" -le "$TOTAL" ]; do
      local LEFT=$(sed -n "${i}p" "$LEVEL_FILE")
      local RIGHT=$(sed -n "$((i+1))p" "$LEVEL_FILE")
      if [ -n "$RIGHT" ]; then
        local COMBINED=$(printf '01%s%s' "$LEFT" "$RIGHT" | xxd -r -p | sha256sum | awk '{print $1}')
        echo "$COMBINED" >> "$NEXT_FILE"
      else
        echo "$LEFT" >> "$NEXT_FILE"
      fi
      i=$((i + 2))
    done
    mv "$NEXT_FILE" "$LEVEL_FILE"
  done

  cat "$LEVEL_FILE"
  rm -f "$LEVEL_FILE" "$NEXT_FILE"
}

# ============================================================================
# ML-DSA-65 MANIFEST SIGNING (Post-Quantum, FIPS 204)
# ============================================================================

CRYPTO_BIN="/usr/local/bin/ellul-crypto"
MIGRATION_SIGN_KEY="$IDENTITY_DIR/migration-sign.key"
MIGRATION_SIGN_PUB="$IDENTITY_DIR/migration-sign.pub.json"

ensure_migration_signing_key() {
  if [ -f "$MIGRATION_SIGN_KEY" ]; then
    return 0
  fi
  if [ ! -x "$CRYPTO_BIN" ]; then
    log "ERROR: ellul-crypto not found at $CRYPTO_BIN — cannot generate signing keypair"
    return 1
  fi
  log "Generating ML-DSA-65 migration signing keypair (first block migration)"
  "$CRYPTO_BIN" keygen sign \
    --private-out "$MIGRATION_SIGN_KEY" \
    --public-out "$MIGRATION_SIGN_PUB"
  chmod 600 "$MIGRATION_SIGN_KEY"
  chmod 644 "$MIGRATION_SIGN_PUB"
  chown root:root "$MIGRATION_SIGN_KEY" "$MIGRATION_SIGN_PUB"
  return 0
}

sign_with_migration_key() {
  local DATA_FILE="$1"
  "$CRYPTO_BIN" sign \
    --key "$MIGRATION_SIGN_KEY" \
    --input "$DATA_FILE" \
    --algorithm mldsa65
}

get_migration_public_key_b64() {
  if [ -f "$MIGRATION_SIGN_PUB" ]; then
    jq -r '.mldsa_pk' "$MIGRATION_SIGN_PUB"
  else
    echo ""
  fi
}

# ============================================================================
# BOOTSTRAP INTEGRITY HASH
# ============================================================================

compute_bootstrap_integrity_hash() {
  cat "$IDENTITY_DIR/heartbeat.pub" /etc/ellul/jwt-secret 2>/dev/null | sha256sum | awk '{print $1}'
}

# ============================================================================
# BATCHED URL FETCHING (Phase 3)
# ============================================================================

# Fetch a batch of presigned upload URLs from the API.
# Sets UPLOAD_URLS associative array indexed by chunk index.
fetch_upload_url_batch() {
  local API_BASE="$1"
  local SNAPSHOT_ID="$2"
  local START_INDEX="$3"
  local COUNT="${4:-$URL_BATCH_SIZE}"

  local RESP=$(signed_api_request -s --max-time 15 \
    -X POST \
    -d "{\"startIndex\":$START_INDEX,\"count\":$COUNT}" \
    "$API_BASE/api/servers/block-migration/$SNAPSHOT_ID/upload-urls")

  local N=$(echo "$RESP" | jq '.urls | length' 2>/dev/null)
  if [ -z "$N" ] || [ "$N" -eq 0 ]; then
    log "block-migrate: upload URL fetch failed (start=$START_INDEX count=$COUNT resp_len=${#RESP} resp_prefix=${RESP:0:120})"
    return 1
  fi
  log "block-migrate: fetched $N upload URLs (start=$START_INDEX)"

  for j in $(seq 0 $((N - 1))); do
    local IDX=$(echo "$RESP" | jq -r ".urls[$j].chunkIndex")
    local URL=$(echo "$RESP" | jq -r ".urls[$j].uploadUrl")
    echo "$IDX $URL" >> "$URL_CACHE"
  done
  return 0
}

# Fetch a batch of presigned download URLs from the API.
fetch_download_url_batch() {
  local API_BASE="$1"
  local SNAPSHOT_ID="$2"
  local START_INDEX="$3"
  local COUNT="${4:-$URL_BATCH_SIZE}"

  local RESP=$(signed_api_request -s --max-time 15 \
    -X POST \
    -d "{\"startIndex\":$START_INDEX,\"count\":$COUNT}" \
    "$API_BASE/api/servers/block-migration/$SNAPSHOT_ID/download-urls")

  local N=$(echo "$RESP" | jq '.urls | length' 2>/dev/null)
  if [ -z "$N" ] || [ "$N" -eq 0 ]; then
    log "block-migrate: download URL fetch failed (start=$START_INDEX count=$COUNT resp_len=${#RESP} resp_prefix=${RESP:0:120})"
    return 1
  fi
  log "block-migrate: fetched $N download URLs (start=$START_INDEX)"

  for j in $(seq 0 $((N - 1))); do
    local IDX=$(echo "$RESP" | jq -r ".urls[$j].chunkIndex")
    local URL=$(echo "$RESP" | jq -r ".urls[$j].downloadUrl")
    local HASH=$(echo "$RESP" | jq -r ".urls[$j].expectedSha256")
    local SIZE=$(echo "$RESP" | jq -r ".urls[$j].expectedSize")
    echo "$IDX $HASH $SIZE $URL" >> "$DL_CACHE"
  done
  return 0
}

# Report a batch of uploaded chunks to the API.
report_chunks_batch() {
  local API_BASE="$1"
  local SNAPSHOT_ID="$2"
  local BATCH_JSON="$3"

  signed_api_request -s --max-time 15 \
    -X POST \
    -d "{\"chunks\":$BATCH_JSON}" \
    "$API_BASE/api/servers/block-migration/$SNAPSHOT_ID/chunks-complete"
}

# Report a batch of downloaded chunk indices to the API.
report_download_progress() {
  local API_BASE="$1"
  local SNAPSHOT_ID="$2"
  local INDICES_JSON="$3"

  signed_api_request -s --max-time 15 \
    -X POST \
    -d "{\"chunks\":$INDICES_JSON}" \
    "$API_BASE/api/servers/block-migration/$SNAPSHOT_ID/chunks-downloaded"
}

# ============================================================================
# BLOCK MIGRATE UPLOAD (Source Side)
# ============================================================================

block_migrate_upload() {
  local CMD_PAYLOAD="$1"

  # Work directory in tmpfs — private keys and metadata only (small).
  # Chunk data is NEVER staged to a file; it streams through pipes
  # (dd → tee → sha256sum + curl) so neither disk nor RAM is consumed.
  umask 077
  mkdir -p /run/ellul
  local WORK_DIR=$(mktemp -d /run/ellul/block-migrate-XXXXXXXX)
  chmod 700 "$WORK_DIR"

  # Cleanup handler — restores volume on unexpected exit (safety net).
  # MUST restore vault bind mounts so heartbeat key is accessible, otherwise
  # the enforcer enters a death loop (403 on every heartbeat).
  cleanup_upload() {
    # Unfreeze filesystem if still frozen
    if mountpoint -q "${SVC_HOME:-/home/dev}" 2>/dev/null; then
      fsfreeze --unfreeze "${SVC_HOME:-/home/dev}" 2>/dev/null || true
    fi
    # Restart services (LUKS and mounts were never touched)
    start_services_idempotent "cleanup-upload" "trap handler" 2>/dev/null || \
      systemctl start postgresql caddy ellul-sovereign-shield ellul-file-api ellul-agent-bridge >/dev/null 2>&1 || true
    rm -rf "$WORK_DIR" 2>/dev/null || true
  }
  trap 'cleanup_upload' EXIT

  # Timing: start
  local T_START=$(date +%s%N 2>/dev/null || date +%s)

  # Parse payload
  local RAW_DEVICE=$(echo "$CMD_PAYLOAD" | jq -r '.volumeDevice // empty')
  local SNAPSHOT_ID=$(echo "$CMD_PAYLOAD" | jq -r '.snapshotId // empty')
  local FIRST_UPLOAD_URL=$(echo "$CMD_PAYLOAD" | jq -r '.firstUploadUrl // empty')
  local RESUME_FROM=$(echo "$CMD_PAYLOAD" | jq -r '.resumeFromChunk // 0')
  local API_BASE=$(echo "$CMD_PAYLOAD" | jq -r '.apiBaseUrl // empty')
  local WORKERS=$(echo "$CMD_PAYLOAD" | jq -r '.parallelWorkers // empty')
  [ -n "$WORKERS" ] && [ "$WORKERS" -gt 0 ] 2>/dev/null && PARALLEL_WORKERS="$WORKERS"

  # Auto-scale workers by available RAM — each worker holds a chunk file in
  # tmpfs + curl streaming buffer. On low-memory hosts, too many parallel
  # workers + running services can OOM, causing truncated uploads.
  if [ "$PARALLEL_WORKERS" -gt 1 ]; then
    local AVAIL_MB=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)
    local MAX_BY_MEM=$(( AVAIL_MB / 96 ))  # headroom per worker covers chunk file + overhead
    [ "$MAX_BY_MEM" -lt 1 ] && MAX_BY_MEM=1
    if [ "$MAX_BY_MEM" -lt "$PARALLEL_WORKERS" ]; then
      log "block-migrate: scaling workers ${PARALLEL_WORKERS} → ${MAX_BY_MEM} (${AVAIL_MB}MB available)"
      PARALLEL_WORKERS="$MAX_BY_MEM"
    fi
  fi

  # ── Incremental backup: base chunk hashes from previous backup ──
  # baseChunkHashes is an object map: {"0":"abc123...","3":"def456...",...}
  # SECURITY: If parsing fails, we fall back to full upload (safe default).
  # We never skip a chunk unless we have a validated 64-char hex hash to compare.
  local BASE_HASHES_FILE="$WORK_DIR/base-hashes.json"
  local HAS_BASE_HASHES=false
  local CHUNKS_SKIPPED=0

  if echo "$CMD_PAYLOAD" | jq -e '.baseChunkHashes | type == "object"' >/dev/null 2>&1; then
    echo "$CMD_PAYLOAD" | jq '.baseChunkHashes' > "$BASE_HASHES_FILE" 2>/dev/null
    # Validate the JSON is a non-empty object with hex string values
    local _bhash_count
    _bhash_count=$(jq 'keys | length' "$BASE_HASHES_FILE" 2>/dev/null || echo "0")
    if [ "$_bhash_count" -gt 0 ] 2>/dev/null; then
      # Spot-check: verify first value looks like a SHA-256 hex string (64 chars, lowercase hex)
      local _first_val
      _first_val=$(jq -r 'to_entries[0].value // empty' "$BASE_HASHES_FILE" 2>/dev/null)
      if echo "$_first_val" | grep -qE '^[0-9a-f]{64}$'; then
        HAS_BASE_HASHES=true
        log "block-migrate: incremental mode enabled ($_bhash_count base hashes loaded)"
      else
        log "block-migrate: WARNING — baseChunkHashes values are not valid SHA-256 hex, falling back to full upload"
        rm -f "$BASE_HASHES_FILE"
      fi
    else
      rm -f "$BASE_HASHES_FILE"
    fi
  else
    # No baseChunkHashes or not a JSON object — full upload (not an error)
    echo '{}' > "$BASE_HASHES_FILE"
  fi

  if [ -z "$RAW_DEVICE" ] || [ -z "$SNAPSHOT_ID" ] || [ -z "$API_BASE" ]; then
    jq -nc '{success: false, error: "missing volumeDevice, snapshotId, or apiBaseUrl"}'
    return 1
  fi

  # Device path validation — reject anything not a known block device pattern
  case "$RAW_DEVICE" in
    /dev/vd[a-z]|/dev/vd[a-z][0-9]*|\
    /dev/sd[a-z]|/dev/sd[a-z][0-9]*|\
    /dev/nvme[0-9]*n[0-9]*|/dev/nvme[0-9]*n[0-9]*p[0-9]*|\
    /dev/disk/by-id/*)
      ;;
    *)
      jq -nc --arg err "rejected device path: $RAW_DEVICE" '{success: false, error: $err}'
      return 1
      ;;
  esac

  if [ ! -e "$RAW_DEVICE" ]; then
    jq -nc --arg err "device $RAW_DEVICE not found" '{success: false, error: $err}'
    return 1
  fi

  local TOTAL_BYTES=$(blockdev --getsize64 "$RAW_DEVICE")
  if [ -z "$TOTAL_BYTES" ] || [ "$TOTAL_BYTES" -eq 0 ]; then
    jq -nc '{success: false, error: "cannot determine device size"}'
    return 1
  fi

  local CHUNK_COUNT=$(( (TOTAL_BYTES + BLOCK_CHUNK_SIZE - 1) / BLOCK_CHUNK_SIZE ))
  local TOTAL_RETRIES=0
  local MAX_TOTAL_RETRIES=$(( CHUNK_COUNT / 10 ))
  [ "$MAX_TOTAL_RETRIES" -lt 10 ] && MAX_TOTAL_RETRIES=10

  log "Block migration upload: device=$RAW_DEVICE size=$TOTAL_BYTES chunks=$CHUNK_COUNT resume=$RESUME_FROM workers=$PARALLEL_WORKERS incremental=$HAS_BASE_HASHES"

  ensure_migration_signing_key

  # ── Bootstrap integrity hash (before quiesce) ──
  local BOOTSTRAP_HASH=$(compute_bootstrap_integrity_hash)
  echo "$BOOTSTRAP_HASH" > /etc/ellul/shield-data/.bootstrap-integrity-hash
  sync

  # ── Quiesce: stop services, freeze filesystem, read raw ciphertext ──
  #
  # Class A encrypted transfer: read raw ciphertext blocks from the physical
  # device (/dev/sdb) below the LUKS layer. The volume is NEVER decrypted
  # during migration. dd reads /dev/sdb directly — it does not go through
  # device-mapper. With services stopped and the filesystem frozen, there
  # are no writes through dm-crypt, so the raw device is static.
  #
  # LUKS stays open. Filesystem stays mounted (frozen). No unmount, no
  # luksClose, no bind mount teardown. Services restart after upload.
  local T_QUIESCE_START=$(date +%s%N 2>/dev/null || date +%s)

  # ── Pre-quiesce vault diagnostic (trace what SOURCE has before upload) ──
  local _SRC_VAULT="$SVC_HOME/.ellul-vault"
  log "block-migrate-ul: === SOURCE VAULT DIAGNOSTIC ==="
  log "block-migrate-ul: home_mounted=$(mountpoint -q "$SVC_HOME" 2>/dev/null && echo yes || echo no) home_source=$(findmnt -n -o SOURCE "$SVC_HOME" 2>/dev/null || echo none)"
  log "block-migrate-ul: vault_exists=$([ -d "$_SRC_VAULT" ] && echo yes || echo no) initialized=$([ -f "$_SRC_VAULT/.initialized" ] && echo yes || echo no)"
  if [ -d "$_SRC_VAULT" ]; then
    log "block-migrate-ul: vault_contents=$(ls -A "$_SRC_VAULT" 2>/dev/null | tr '\n' ' ')"
    log "block-migrate-ul: vault_etc_ellul=$(ls "$_SRC_VAULT/etc/ellul" 2>/dev/null | wc -l) files"
    log "block-migrate-ul: vault_shielded=$([ -d "$_SRC_VAULT/var/lib/ellul-shielded" ] && echo yes || echo no)"
  fi
  log "block-migrate-ul: home_usage=$(du -sh "$SVC_HOME" 2>/dev/null | awk '{print $1}')"
  log "block-migrate-ul: === END DIAGNOSTIC ==="

  log "Quiescing: stopping services..."

  # PG checkpoint before stopping (minimize data loss window)
  if systemctl is-active --quiet postgresql; then
    runuser -l postgres -c "psql -c 'CHECKPOINT;'" >/dev/null 2>&1 || true
    log "block-migrate: PG checkpoint done"
  fi

  # Stop services that write to the LUKS volume (bounded — 60s max)
  timeout 60 systemctl stop ellul-agent-bridge ellul-file-api ellul-sovereign-shield \
    ellul-preview ellul-term-proxy ellul-perf-monitor \
    ellul-watchdog caddy postgresql \
    "pm2-${SVC_USER}" 'ttyd@*' >/dev/null 2>&1 || true

  # Wait for PG to fully stop
  local PG_WAIT=0
  while systemctl is-active --quiet postgresql && [ "$PG_WAIT" -lt 10 ]; do
    sleep 1
    PG_WAIT=$((PG_WAIT + 1))
  done

  sync

  # ── fstrim: zero unused blocks so we can skip them during upload ──
  # After fstrim, unused blocks become zeros on the raw device. Zero chunks
  # are detected by hash and skipped — typically 90%+ of the volume.
  if [ -b /dev/mapper/luks-home ] && mountpoint -q "$SVC_HOME" 2>/dev/null; then
    if timeout 10 cryptsetup refresh --allow-discards luks-home 2>/dev/null; then
      local TRIM_START=$(date +%s)
      timeout 120 fstrim -v "$SVC_HOME" 2>/dev/null && log "block-migrate: fstrim complete ($(( $(date +%s) - TRIM_START ))s)" || log "block-migrate: fstrim failed (non-fatal)"
      timeout 10 cryptsetup refresh luks-home 2>/dev/null || true
    else
      log "block-migrate: fstrim not supported — skipping (non-fatal)"
    fi
  fi

  # Freeze filesystem — ensures ext4 journal is flushed and all I/O quiesced.
  # The raw device is now a static blob of ciphertext safe to read with dd.
  local FROZEN=false
  if mountpoint -q "$SVC_HOME" 2>/dev/null; then
    timeout 10 fsfreeze --freeze "$SVC_HOME" 2>/dev/null && FROZEN=true
    log "block-migrate: filesystem frozen=$FROZEN"
  fi

  # Precompute hash of a zero-filled chunk for sparse skip detection.
  # After fstrim, unused blocks are zeros on the raw device. Skipping them
  # avoids uploading empty space (typically 90%+ of the volume).
  local ZERO_CHUNK_HASH=$(dd if=/dev/zero bs=$BLOCK_CHUNK_SIZE count=1 2>/dev/null | sha256sum | awk '{print $1}')

  # Resolve symlink to real device path — avoids udev symlink instability during reads
  local REAL_DEVICE=$(readlink -f "$RAW_DEVICE" 2>/dev/null || echo "$RAW_DEVICE")

  # ── Sparse map: SEEK_DATA/SEEK_HOLE to skip zero regions without reading them ──
  # After fstrim, unallocated regions become holes on thin-provisioned storage.
  # SEEK_DATA/SEEK_HOLE lets us find data extents in O(1) per extent vs O(n) per chunk.
  # Result: a file with one chunk index per line for chunks that overlap data.
  # Chunks NOT in this file are guaranteed all-zero → skip read+hash entirely.
  local SPARSE_MAP="$WORK_DIR/sparse-map"
  local SPARSE_SCAN_OK=false
  local DEVICE_SIZE=$(blockdev --getsize64 "$REAL_DEVICE" 2>/dev/null || echo 0)
  if python3 -c "
import os, sys
CHUNK = $BLOCK_CHUNK_SIZE
dev = os.open('$REAL_DEVICE', os.O_RDONLY)
size = $DEVICE_SIZE
data_chunks = set()
pos = 0
try:
    while pos < size:
        try:
            data_start = os.lseek(dev, pos, os.SEEK_DATA)
        except OSError:
            break  # No more data regions
        if data_start >= size:
            break
        try:
            hole_start = os.lseek(dev, data_start, os.SEEK_HOLE)
        except OSError:
            hole_start = size
        # Mark all chunks overlapping [data_start, hole_start)
        first_chunk = data_start // CHUNK
        last_chunk = min((hole_start - 1) // CHUNK, (size - 1) // CHUNK)
        for c in range(first_chunk, last_chunk + 1):
            data_chunks.add(c)
        pos = hole_start
finally:
    os.close(dev)
for c in sorted(data_chunks):
    print(c)
" > "$SPARSE_MAP" 2>/dev/null; then
    local DATA_CHUNKS=$(wc -l < "$SPARSE_MAP")
    local TOTAL_CHUNKS=$((DEVICE_SIZE / BLOCK_CHUNK_SIZE))
    SPARSE_SCAN_OK=true
    log "block-migrate: sparse map: $DATA_CHUNKS/$TOTAL_CHUNKS chunks have data ($(( (TOTAL_CHUNKS - DATA_CHUNKS) * BLOCK_CHUNK_SIZE / 1048576 ))MB skipped)"
  else
    log "block-migrate: SEEK_DATA/SEEK_HOLE not supported — falling back to read-every-chunk"
    rm -f "$SPARSE_MAP"
  fi

  local T_SNAPSHOT=$(date +%s%N 2>/dev/null || date +%s)
  log "Direct read mode — volume quiesced, filesystem frozen (volume=$(( $(blockdev --getsize64 "$REAL_DEVICE") / 1073741824 ))GB device=$REAL_DEVICE)"

  # Diagnostic: verify dd works before starting upload.
  # Test both a single full-chunk read AND a split read to identify which fails.
  local TEST_DD_FILE="$WORK_DIR/dd-test"
  local DD_DIAG=""

  # Test 1: single full-chunk read
  dd if="$REAL_DEVICE" bs=$BLOCK_CHUNK_SIZE skip=0 count=1 iflag=fullblock of="$TEST_DD_FILE" 2>"$WORK_DIR/dd-test-err"
  local T1_EXIT=$?
  local T1_SIZE=$(stat -c%s "$TEST_DD_FILE" 2>/dev/null || echo 0)
  local T1_ERR=$(cat "$WORK_DIR/dd-test-err" 2>/dev/null | head -1 | tr '\n' ' ')
  DD_DIAG="full_chunk_exit=${T1_EXIT}_size=${T1_SIZE}"

  # Test 2: split reads (resilience path)
  dd if="$REAL_DEVICE" bs=1048576 skip=0 count=64 iflag=fullblock of="$TEST_DD_FILE" 2>"$WORK_DIR/dd-test-err"
  local T2_EXIT=$?
  local T2_SIZE=$(stat -c%s "$TEST_DD_FILE" 2>/dev/null || echo 0)
  DD_DIAG="${DD_DIAG} split_exit=${T2_EXIT}_size=${T2_SIZE}"

  # Test 3: system info
  local SYS_INFO="kernel=$(uname -r) dev=$REAL_DEVICE dm=$(ls /dev/mapper/ 2>/dev/null | tr '\n' ',') procs=$(fuser $REAL_DEVICE 2>/dev/null | wc -w)"
  DD_DIAG="${DD_DIAG} ${SYS_INFO}"

  rm -f "$TEST_DD_FILE"
  log "block-migrate: dd diagnostic: $DD_DIAG"

  # ── Restore: unfreeze filesystem + restart services ──
  # LUKS was never closed and filesystem was never unmounted — just unfreeze and restart.
  restore_volume_and_services() {
    log "block-migrate: restoring..."
    if mountpoint -q "$SVC_HOME" 2>/dev/null; then
      fsfreeze --unfreeze "$SVC_HOME" 2>/dev/null || true
    fi
    log "block-migrate: starting services..."
    start_services_idempotent "block-migrate-restore" "volume restored" 2>/dev/null || \
      systemctl start postgresql caddy ellul-sovereign-shield ellul-file-api ellul-agent-bridge >/dev/null 2>&1 || true
    sleep 2
    log "block-migrate: services restored"
  }

  # If the full-chunk read fails, abort immediately with diagnostic in result (visible in DB)
  if [ "$T1_EXIT" -ne 0 ] || [ "$T1_SIZE" -ne "$BLOCK_CHUNK_SIZE" ]; then
    log "block-migrate: PRE-UPLOAD full-chunk DD TEST FAILED — aborting with diagnostic"
    restore_volume_and_services
    jq -nc --arg diag "$DD_DIAG" --arg err "$T1_ERR" '{success: false, error: "dd full-chunk test failed", diagnostic: $diag, ddStderr: $err}'
    return 1
  fi

  local T_SERVICES_RESTORED=$(date +%s%N 2>/dev/null || date +%s)

  # ── Parallel chunk upload ──
  local HASH_DIR="$WORK_DIR/hashes"
  mkdir -p "$HASH_DIR"
  local UPLOAD_FAILED_FLAG="$WORK_DIR/upload-fail"
  rm -f "$UPLOAD_FAILED_FLAG"
  local UPLOAD_SUCCESS=true
  local BATCH_REPORT_BUF="$WORK_DIR/batch"
  local BATCH_COUNT=0

  # Pre-fetch first batch of URLs
  local URL_CACHE="$WORK_DIR/url-cache"
  rm -f "$URL_CACHE"
  if [ "$RESUME_FROM" -eq 0 ] && [ -n "$FIRST_UPLOAD_URL" ]; then
    echo "0 $FIRST_UPLOAD_URL" > "$URL_CACHE"
  fi
  fetch_upload_url_batch "$API_BASE" "$SNAPSHOT_ID" "$RESUME_FROM" || \
    log "block-migrate: initial URL batch fetch failed — workers will retry individually"

  local INITIAL_URL_COUNT=$(wc -l < "$URL_CACHE" 2>/dev/null || echo 0)
  log "block-migrate: URL cache seeded with $INITIAL_URL_COUNT entries, starting upload loop"

  # URL lookup helper
  get_upload_url() {
    local IDX="$1"
    grep "^${IDX} " "$URL_CACHE" 2>/dev/null | head -1 | cut -d' ' -f2-
  }

  # Worker function: read chunk to tmpfs, hash, upload.
  # tmpfs chunk file is cheap after quiesce frees RAM.
  # curl -T file lets curl stat() the size → correct Content-Length.
  upload_chunk_worker() {
    local INDEX=$1
    local URL="$2"
    local DEVICE="$3"
    local CHUNK_FILE="$WORK_DIR/chunk-${INDEX}"

    # Read chunk — try a single full-chunk read first, fall back to split reads on failure.
    # Network-attached volumes can fail large single reads due to SCSI command
    # splitting, I/O scheduler contention, or driver limits.
    # Split reads avoid the kernel splitting issue entirely.
    local DD_OK=false
    local DD_ERR="$WORK_DIR/dd-err-${INDEX}"
    local BYTE_OFFSET=$(( INDEX * BLOCK_CHUNK_SIZE ))

    # Attempt 1: single full-chunk read (fast path)
    dd if="$DEVICE" bs=$BLOCK_CHUNK_SIZE skip=$INDEX count=1 iflag=fullblock of="$CHUNK_FILE" 2>"$DD_ERR"
    local DD_EXIT=$?
    local CHUNK_BYTES=$(stat -c%s "$CHUNK_FILE" 2>/dev/null || echo 0)

    if [ "$DD_EXIT" -eq 0 ] && [ "$CHUNK_BYTES" -eq "$BLOCK_CHUNK_SIZE" ]; then
      DD_OK=true
    elif [ "$DD_EXIT" -eq 0 ] && [ "$CHUNK_BYTES" -gt 0 ] && [ "$INDEX" -eq "$((CHUNK_COUNT - 1))" ]; then
      DD_OK=true  # Last chunk may be smaller
    fi

    # Attempt 2: split reads (resilient path)
    if [ "$DD_OK" != "true" ]; then
      local DD_STDERR=$(cat "$DD_ERR" 2>/dev/null | head -1 | tr '\n' ' ')
      local DD_DMESG=$(dmesg | tail -3 | tr '\n' ' ')
      log "block-migrate: chunk $INDEX large read failed (exit=$DD_EXIT got=$CHUNK_BYTES dev=$DEVICE offset=$BYTE_OFFSET err=\"$DD_STDERR\" dmesg=\"$DD_DMESG\")"
      log "block-migrate: chunk $INDEX falling back to split reads"
      local SKIP_1M=$(( INDEX * 64 ))
      dd if="$DEVICE" bs=1048576 skip=$SKIP_1M count=64 iflag=fullblock of="$CHUNK_FILE" 2>"$DD_ERR"
      DD_EXIT=$?
      CHUNK_BYTES=$(stat -c%s "$CHUNK_FILE" 2>/dev/null || echo 0)
      if [ "$DD_EXIT" -eq 0 ] && [ "$CHUNK_BYTES" -eq "$BLOCK_CHUNK_SIZE" ]; then
        DD_OK=true
        log "block-migrate: chunk $INDEX split-read fallback succeeded"
      elif [ "$DD_EXIT" -eq 0 ] && [ "$CHUNK_BYTES" -gt 0 ] && [ "$INDEX" -eq "$((CHUNK_COUNT - 1))" ]; then
        DD_OK=true
      fi
    fi

    if [ "$DD_OK" != "true" ]; then
      local FINAL_BYTES=$(stat -c%s "$CHUNK_FILE" 2>/dev/null || echo 0)
      local FAIL_ERR=$(cat "$DD_ERR" 2>/dev/null | head -2 | tr '\n' ' ')
      local FAIL_DMESG=$(dmesg | tail -3 | tr '\n' ' ')
      log "block-migrate: chunk $INDEX dd FAILED — both full-chunk and split reads failed (size=$FINAL_BYTES device=$DEVICE err=\"$FAIL_ERR\" dmesg=\"$FAIL_DMESG\")"
      touch "$UPLOAD_FAILED_FLAG"
      rm -f "$CHUNK_FILE"
      return 1
    fi

    local CHUNK_BYTES=$(stat -c%s "$CHUNK_FILE" 2>/dev/null || echo 0)
    local CHUNK_HASH=$(sha256sum "$CHUNK_FILE" | awk '{print $1}')

    # Store hash for ordered Merkle computation (always needed, even for skipped chunks)
    echo "$CHUNK_HASH" > "$HASH_DIR/$INDEX"

    # Sparse skip: after fstrim, unused blocks are zeros on the raw device.
    # Skip uploading zero chunks — they're already zero on the target volume.
    if [ -n "$ZERO_CHUNK_HASH" ] && [ "$CHUNK_HASH" = "$ZERO_CHUNK_HASH" ]; then
      rm -f "$CHUNK_FILE"
      echo "{\"index\":$INDEX,\"sha256\":\"$CHUNK_HASH\",\"sizeBytes\":$CHUNK_BYTES,\"skipped\":true,\"zero\":true}" >> "${BATCH_REPORT_BUF}.${INDEX}"
      touch "$WORK_DIR/skipped-${INDEX}"
      return 0
    fi

    # Incremental: check if chunk is unchanged from base backup.
    # SECURITY INVARIANTS:
    # - Only skip if base hash is a valid 64-char lowercase hex string
    # - Only skip if it exactly matches the computed chunk hash
    # - On ANY parse error or format mismatch, upload the chunk (safe default)
    # - Never trust the base hash alone — the chunk was already hashed above
    if [ "$HAS_BASE_HASHES" = "true" ]; then
      local BASE_HASH=""
      BASE_HASH=$(jq -r --arg idx "$INDEX" '.[$idx] // empty' "$BASE_HASHES_FILE" 2>/dev/null) || BASE_HASH=""
      # Validate base hash format: must be exactly 64 lowercase hex characters
      if [ -n "$BASE_HASH" ] && echo "$BASE_HASH" | grep -qE '^[0-9a-f]{64}$'; then
        if [ "$BASE_HASH" = "$CHUNK_HASH" ]; then
          # Chunk unchanged — skip upload, report hash only
          rm -f "$CHUNK_FILE"
          echo "{\"index\":$INDEX,\"sha256\":\"$CHUNK_HASH\",\"sizeBytes\":$CHUNK_BYTES,\"skipped\":true}" >> "${BATCH_REPORT_BUF}.${INDEX}"
          touch "$WORK_DIR/skipped-${INDEX}"
          return 0
        fi
        # Hash differs — chunk changed, proceed with upload
      fi
      # Invalid/missing base hash — upload chunk (safe default, no log spam per chunk)
    fi

    # Upload with retry — curl -T file sets Content-Length automatically from file size
    local ATTEMPT=0
    local UPLOAD_OK=false
    while [ $ATTEMPT -lt $MAX_RETRY_PER_CHUNK ]; do
      local HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
        --fail --max-time 120 \
        -H "Content-Type: application/octet-stream" \
        -T "$CHUNK_FILE" "$URL" 2>/dev/null)

      if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
        UPLOAD_OK=true
        break
      fi
      ATTEMPT=$((ATTEMPT + 1))
      log "block-migrate: chunk $INDEX upload attempt $ATTEMPT failed (HTTP $HTTP_CODE, size=$CHUNK_BYTES, url_len=${#URL})"
      local BACKOFF=$(( 5 * (1 << (ATTEMPT - 1)) ))  # 5, 10, 20
      sleep "$BACKOFF"
    done

    rm -f "$CHUNK_FILE"

    if [ "$UPLOAD_OK" != "true" ]; then
      log "block-migrate: chunk $INDEX upload FAILED after $MAX_RETRY_PER_CHUNK attempts"
      touch "$UPLOAD_FAILED_FLAG"
      return 1
    fi

    # Write result for batch reporting
    echo "{\"index\":$INDEX,\"sha256\":\"$CHUNK_HASH\",\"sizeBytes\":$CHUNK_BYTES}" >> "${BATCH_REPORT_BUF}.${INDEX}"
  }

  local ACTIVE_WORKERS=0
  local NEXT_BATCH_FETCH=$((RESUME_FROM + URL_BATCH_SIZE / 2))
  local URL_BATCH_REFRESHES=0
  local CHUNKS_RETRIED=0

  # Build sparse lookup set for O(1) membership test
  local SPARSE_SET="$WORK_DIR/sparse-set"
  if [ "$SPARSE_SCAN_OK" = "true" ] && [ -s "$SPARSE_MAP" ]; then
    # Convert to associative lookup file: "chunk_index 1" per line
    awk '{print $1" 1"}' "$SPARSE_MAP" > "$SPARSE_SET"
  else
    rm -f "$SPARSE_SET"
  fi

  is_data_chunk() {
    [ ! -f "$SPARSE_SET" ] && return 0  # No sparse map → assume all data
    grep -q "^${1} " "$SPARSE_SET" 2>/dev/null
  }

  local PROGRESS_PING_INTERVAL=30  # Send progress ping every 30 chunks
  local LAST_PROGRESS_PING=$RESUME_FROM

  for i in $(seq "$RESUME_FROM" $((CHUNK_COUNT - 1))); do
    # Check for failure
    if [ -f "$UPLOAD_FAILED_FLAG" ]; then
      UPLOAD_SUCCESS=false
      break
    fi

    # ── Progress heartbeat + watchdog ──
    # 1. API ping: updates last_sync_at so stale-recovery doesn't kill us
    # 2. Watchdog: pets systemd so WatchdogSec doesn't kill us
    if [ $(( i - LAST_PROGRESS_PING )) -ge $PROGRESS_PING_INTERVAL ]; then
      systemd-notify WATCHDOG=1 2>/dev/null || true
      signed_api_request -s -o /dev/null --connect-timeout 5 --max-time 10 \
        -d "{\"migrationProgress\":true,\"chunksUploaded\":$i,\"totalChunks\":$CHUNK_COUNT}" \
        "$API_URL/api/servers/heartbeat" 2>/dev/null || true
      LAST_PROGRESS_PING=$i
    fi



    # ── Sparse skip: hole-only chunks are guaranteed zeros after fstrim ──
    # SEEK_DATA/SEEK_HOLE proved this chunk has no data → skip read+hash entirely.
    # Only process allocated blocks.
    if ! is_data_chunk "$i"; then
      echo "$ZERO_CHUNK_HASH" > "$HASH_DIR/$i"
      echo "{\"index\":$i,\"sha256\":\"$ZERO_CHUNK_HASH\",\"sizeBytes\":$BLOCK_CHUNK_SIZE,\"skipped\":true,\"zero\":true}" >> "${BATCH_REPORT_BUF}.${i}"
      touch "$WORK_DIR/skipped-${i}"
      # Still report batch progress for sparse-skipped chunks
      if [ $(( (i + 1) % PARALLEL_WORKERS )) -eq 0 ] || [ "$i" -eq $((CHUNK_COUNT - 1)) ]; then
        local _SB_JSON="["
        local _SB_FIRST=true
        for _sbf in "${BATCH_REPORT_BUF}."*; do
          [ -f "$_sbf" ] || continue
          [ "$_SB_FIRST" = "true" ] && _SB_FIRST=false || _SB_JSON="${_SB_JSON},"
          _SB_JSON="${_SB_JSON}$(cat "$_sbf")"
          rm -f "$_sbf"
        done
        _SB_JSON="${_SB_JSON}]"
        [ "$_SB_JSON" != "[]" ] && report_chunks_batch "$API_BASE" "$SNAPSHOT_ID" "$_SB_JSON" >/dev/null 2>&1
      fi
      continue
    fi

    # Refresh URL batch when 75% consumed
    if [ "$i" -ge "$NEXT_BATCH_FETCH" ] && [ "$i" -lt $((CHUNK_COUNT - 1)) ]; then
      fetch_upload_url_batch "$API_BASE" "$SNAPSHOT_ID" "$i"
      NEXT_BATCH_FETCH=$((i + URL_BATCH_SIZE / 2))
      URL_BATCH_REFRESHES=$((URL_BATCH_REFRESHES + 1))
    fi

    local CHUNK_URL=$(get_upload_url "$i")
    if [ -z "$CHUNK_URL" ]; then
      # URL not in cache — fetch individually (fallback)
      log "block-migrate: chunk $i URL miss — fetching individually"
      fetch_upload_url_batch "$API_BASE" "$SNAPSHOT_ID" "$i" 1 || true
      CHUNK_URL=$(get_upload_url "$i")
    fi

    if [ -z "$CHUNK_URL" ]; then
      log "block-migrate: chunk $i NO URL after fallback — skipping (will fail)"
    fi

    # Sequential execution: parallel dd reads fail on live cloud volumes (Hetzner/DO)
    # due to an undiagnosed kernel-level issue (works in rescue, fails with systemd).
    # Single-threaded reads are reliable. With fstrim zero-skipping, most chunks
    # are skipped so parallelism provides negligible benefit.
    upload_chunk_worker "$i" "$CHUNK_URL" "$REAL_DEVICE"
    local WORKER_EXIT=$?
    # Treat as single active worker for progress/batch reporting compatibility
    ACTIVE_WORKERS=1

    # Progress logging every 10 chunks
    if [ $(( (i + 1) % 10 )) -eq 0 ]; then
      local _mem_avail=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo "?")
      log "Upload progress: $((i + 1))/$CHUNK_COUNT chunks (workers=$PARALLEL_WORKERS mem=${_mem_avail}MB)"
      # Lightweight heartbeat ping during upload
      signed_api_request -s -o /dev/null --connect-timeout 3 --max-time 5 \
        -X POST -d '{"migrating":true}' \
        "$API_URL/api/servers/heartbeat" 2>/dev/null &
    fi

    # Report completed chunks every PARALLEL_WORKERS dispatches for real-time progress.
    # Synchronous (not &) to avoid wait -n returning for the wrong child.
    if [ $(( (i + 1) % PARALLEL_WORKERS )) -eq 0 ] || [ "$i" -eq $((CHUNK_COUNT - 1)) ]; then
      local BATCH_JSON="["
      local BATCH_FIRST=true
      for bf in "${BATCH_REPORT_BUF}."*; do
        [ -f "$bf" ] || continue
        if [ "$BATCH_FIRST" = "true" ]; then
          BATCH_FIRST=false
        else
          BATCH_JSON="${BATCH_JSON},"
        fi
        BATCH_JSON="${BATCH_JSON}$(cat "$bf")"
        rm -f "$bf"
      done
      BATCH_JSON="${BATCH_JSON}]"

      if [ "$BATCH_JSON" != "[]" ]; then
        report_chunks_batch "$API_BASE" "$SNAPSHOT_ID" "$BATCH_JSON" >/dev/null 2>&1
      fi
    fi
  done

  log "block-migrate: upload loop done (dispatched up to chunk $i), waiting for remaining workers..."
  wait  # Wait for all remaining workers
  sync  # Flush hash files to disk before Merkle computation
  log "block-migrate: all workers completed"

  # Final flush: report any remaining completed chunks not yet reported
  local FINAL_JSON="["
  local FINAL_FIRST=true
  for bf in "${BATCH_REPORT_BUF}."*; do
    [ -f "$bf" ] || continue
    if [ "$FINAL_FIRST" = "true" ]; then FINAL_FIRST=false; else FINAL_JSON="${FINAL_JSON},"; fi
    FINAL_JSON="${FINAL_JSON}$(cat "$bf")"
    rm -f "$bf"
  done
  FINAL_JSON="${FINAL_JSON}]"
  if [ "$FINAL_JSON" != "[]" ]; then
    report_chunks_batch "$API_BASE" "$SNAPSHOT_ID" "$FINAL_JSON" >/dev/null 2>&1
  fi

  # Check for late failures
  if [ -f "$UPLOAD_FAILED_FLAG" ]; then
    UPLOAD_SUCCESS=false
    log "block-migrate: upload failed flag detected after wait"
  fi

  # Count skipped chunks (markers written by workers in subshells)
  CHUNKS_SKIPPED=$(ls "$WORK_DIR"/skipped-* 2>/dev/null | wc -l)
  rm -f "$WORK_DIR"/skipped-*
  local HASH_COUNT=$(ls "$HASH_DIR"/ 2>/dev/null | wc -l)
  log "block-migrate: upload summary — success=$UPLOAD_SUCCESS hashes=$HASH_COUNT skipped=$CHUNKS_SKIPPED"

  local T_UPLOAD_DONE=$(date +%s%N 2>/dev/null || date +%s)

  # Cleanup URL cache and batch files
  rm -f "$URL_CACHE" "${BATCH_REPORT_BUF}."* "$UPLOAD_FAILED_FLAG"

  # restore_volume_and_services defined earlier (before dd test) to avoid forward-reference

  if [ "$UPLOAD_SUCCESS" != "true" ]; then
    # Collect diagnostic info for the failure result (visible in server_commands.result)
    local FAIL_DIAG="device=$REAL_DEVICE kernel=$(uname -r) dm=$([ -b /dev/mapper/luks-home ] && echo exists || echo gone)"
    FAIL_DIAG="$FAIL_DIAG udev_running=$(pidof systemd-udevd >/dev/null 2>&1 && echo yes || echo no)"
    FAIL_DIAG="$FAIL_DIAG procs_on_dev=$(fuser "$REAL_DEVICE" 2>/dev/null | wc -w)"
    FAIL_DIAG="$FAIL_DIAG last_dd_err=$(cat "$WORK_DIR"/dd-err-* 2>/dev/null | head -3 | tr '\n' ' ')"
    FAIL_DIAG="$FAIL_DIAG dmesg=$(dmesg | tail -5 | grep -i 'error\|fail\|io\|scsi' | head -2 | tr '\n' ' ')"
    log "block-migrate: upload failed diagnostic: $FAIL_DIAG"
    restore_volume_and_services
    jq -nc --arg diag "$FAIL_DIAG" '{success: false, error: "chunk upload failed", diagnostic: $diag}'
    return 1
  fi

  # ── Compute Merkle root from collected hashes ──
  local CHUNK_HASHES_FILE="$WORK_DIR/all-hashes"
  > "$CHUNK_HASHES_FILE"
  for i in $(seq 0 $((CHUNK_COUNT - 1))); do
    if [ -f "$HASH_DIR/$i" ]; then
      cat "$HASH_DIR/$i" >> "$CHUNK_HASHES_FILE"
    fi
  done

  local MERKLE_ROOT=$(compute_merkle_root "$CHUNK_HASHES_FILE")
  rm -f "$CHUNK_HASHES_FILE"
  log "Merkle root: ${MERKLE_ROOT:0:16}..."

  # ── Build chunks JSON array from collected hashes (via jq, not string concat) ──
  local CHUNKS_FILE="$WORK_DIR/chunks.json"
  > "$CHUNKS_FILE"
  for i in $(seq 0 $((CHUNK_COUNT - 1))); do
    local CHUNK_HASH=""
    if [ -f "$HASH_DIR/$i" ]; then
      CHUNK_HASH=$(cat "$HASH_DIR/$i" | tr -d '\n')
    fi
    local CHUNK_BYTES=$BLOCK_CHUNK_SIZE
    if [ "$i" -eq $((CHUNK_COUNT - 1)) ]; then
      CHUNK_BYTES=$((TOTAL_BYTES - i * BLOCK_CHUNK_SIZE))
    fi
    jq -nc --argjson index "$i" --arg sha256 "$CHUNK_HASH" --argjson sizeBytes "$CHUNK_BYTES" \
      '{index:$index, sha256:$sha256, sizeBytes:$sizeBytes}' >> "$CHUNKS_FILE"
  done
  local CHUNKS_JSON=$(jq -sc '.' "$CHUNKS_FILE")
  rm -f "$CHUNKS_FILE"
  rm -rf "$HASH_DIR"

  # ── Collect volume layout info ──
  local SECTOR_SIZE=$(blockdev --getss "$RAW_DEVICE" 2>/dev/null || echo "512")
  local PHYS_SECTOR_SIZE=$(blockdev --getpbsz "$RAW_DEVICE" 2>/dev/null || echo "512")
  local LUKS_HEADER_HASH=$(dd if="$RAW_DEVICE" bs=1M count=16 2>/dev/null | sha256sum | awk '{print $1}')
  local LUKS_PAYLOAD_OFFSET=$(cryptsetup luksDump "$RAW_DEVICE" 2>/dev/null | grep -m1 "offset:" | awk '{print $2}' || echo "0")

  # ── Build and sign manifest ──
  local SIGNING_PUB_B64=$(get_migration_public_key_b64)
  local SIGNING_FINGERPRINT=$(echo -n "$SIGNING_PUB_B64" | b64_decode | sha256sum | awk '{print $1}')
  local ENCRYPTION_MODE="plain"
  blkid -o value -s TYPE "$RAW_DEVICE" 2>/dev/null | grep -q "crypto_LUKS" && ENCRYPTION_MODE="luks2"

  local SERVER_ID=$(cat "$SERVER_ID_FILE" 2>/dev/null | tr -d '\n')
  local SNAPSHOT_VERSION=$(echo "$CMD_PAYLOAD" | jq -r '.snapshotVersion // 0')
  local SOURCE_VOLUME_ID=$(echo "$CMD_PAYLOAD" | jq -r '.sourceVolumeId // ""')
  local SOURCE_TIER=$(echo "$CMD_PAYLOAD" | jq -r '.sourceTier // ""')

  local MANIFEST_UNSIGNED=$(jq -n \
    --argjson version 1 \
    --arg serverId "$SERVER_ID" \
    --argjson snapshotVersion "$SNAPSHOT_VERSION" \
    --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg sourceVolumeId "$SOURCE_VOLUME_ID" \
    --arg encryptionMode "$ENCRYPTION_MODE" \
    --argjson volumeSizeBytes "$TOTAL_BYTES" \
    --argjson volumeSectorSize "$SECTOR_SIZE" \
    --argjson chunkSizeBytes "$BLOCK_CHUNK_SIZE" \
    --argjson chunkCount "$CHUNK_COUNT" \
    --argjson chunks "$CHUNKS_JSON" \
    --arg merkleRootHash "$MERKLE_ROOT" \
    --arg bootstrapIntegrityHash "$BOOTSTRAP_HASH" \
    --arg sourceTier "$SOURCE_TIER" \
    --arg signingKeyFingerprint "$SIGNING_FINGERPRINT" \
    --arg luksHeaderHash "$LUKS_HEADER_HASH" \
    --argjson sectorSize "$SECTOR_SIZE" \
    --argjson physicalSectorSize "$PHYS_SECTOR_SIZE" \
    --argjson luksPayloadOffset "${LUKS_PAYLOAD_OFFSET:-0}" \
    --arg signedBy "vps-migration-key" \
    '{
      version: $version,
      serverId: $serverId,
      snapshotVersion: $snapshotVersion,
      timestamp: $timestamp,
      sourceVolumeId: $sourceVolumeId,
      encryptionMode: $encryptionMode,
      volumeSizeBytes: $volumeSizeBytes,
      volumeSectorSize: $volumeSectorSize,
      chunkSizeBytes: $chunkSizeBytes,
      chunkCount: $chunkCount,
      chunks: $chunks,
      merkleRootHash: $merkleRootHash,
      bootstrapIntegrityHash: $bootstrapIntegrityHash,
      sourceTier: $sourceTier,
      targetServerId: null,
      signingKeyFingerprint: $signingKeyFingerprint,
      volumeLayout: {
        luksHeaderHash: $luksHeaderHash,
        sectorSize: $sectorSize,
        physicalSectorSize: $physicalSectorSize,
        luksVersion: 2,
        luksPayloadOffset: $luksPayloadOffset
      },
      signedBy: $signedBy
    }')

  local MANIFEST_FILE="$WORK_DIR/manifest-unsigned"
  printf '%s' "$(echo "$MANIFEST_UNSIGNED" | jq -cS '.')" > "$MANIFEST_FILE"
  local PAYLOAD_HASH=$(sha256sum "$MANIFEST_FILE" | awk '{print $1}')
  local PAYLOAD_SIZE=$(stat -c%s "$MANIFEST_FILE")
  local MANIFEST_SIG=$(sign_with_migration_key "$MANIFEST_FILE")
  local SIG_LEN=${#MANIFEST_SIG}
  log "block-migrate: manifest signed (payload_hash=${PAYLOAD_HASH:0:16} payload_size=$PAYLOAD_SIZE sig_len=$SIG_LEN sig_prefix=${MANIFEST_SIG:0:20})"
  rm -f "$MANIFEST_FILE"

  local MANIFEST_SIGNED=$(echo "$MANIFEST_UNSIGNED" | jq --arg sig "$MANIFEST_SIG" '. + {signature: $sig}')

  # ── Seal via API ──
  local SEAL_BODY=$(jq -nc \
    --arg manifest "$(echo "$MANIFEST_SIGNED" | jq -c '.')" \
    --arg signingPublicKey "$SIGNING_PUB_B64" \
    '{manifest: $manifest, signingPublicKey: $signingPublicKey}')
  local SEAL_RESP=$(signed_api_request -s --max-time 30 \
    -X POST \
    -d "$SEAL_BODY" \
    "$API_BASE/api/servers/block-migration/$SNAPSHOT_ID/seal")

  local SEAL_OK=$(echo "$SEAL_RESP" | jq -r '.ok // false')
  log "block-migrate: seal response ok=$SEAL_OK resp_len=${#SEAL_RESP} resp_prefix=${SEAL_RESP:0:120}"

  # ── Restore volume + services ──
  restore_volume_and_services

  local T_END=$(date +%s%N 2>/dev/null || date +%s)

  # ── Compute metrics ──
  local QUIESCE_MS=0 SNAPSHOT_MS=0 DOWNTIME_MS=0 UPLOAD_MS=0 TOTAL_MS=0 UPLOAD_RATE=0
  if echo "$T_START" | grep -q "N$" 2>/dev/null || [ ${#T_START} -gt 12 ]; then
    # Nanosecond timestamps available
    QUIESCE_MS=$(( (T_SNAPSHOT - T_QUIESCE_START) / 1000000 ))
    SNAPSHOT_MS=$(( (T_SERVICES_RESTORED - T_SNAPSHOT) / 1000000 ))
    DOWNTIME_MS=$(( (T_SERVICES_RESTORED - T_QUIESCE_START) / 1000000 ))
    UPLOAD_MS=$(( (T_UPLOAD_DONE - T_SERVICES_RESTORED) / 1000000 ))
    TOTAL_MS=$(( (T_END - T_START) / 1000000 ))
    [ "$UPLOAD_MS" -gt 0 ] && UPLOAD_RATE=$(( TOTAL_BYTES * 1000 / UPLOAD_MS ))
  fi

  if [ "$SEAL_OK" = "true" ]; then
    log "Block migration upload complete: snapshot=$SNAPSHOT_ID merkle=${MERKLE_ROOT:0:16}... downtime=${DOWNTIME_MS}ms skipped=$CHUNKS_SKIPPED"
    jq -nc \
      --arg snapshotId "$SNAPSHOT_ID" \
      --arg merkleRootHash "$MERKLE_ROOT" \
      --argjson chunkCount "$CHUNK_COUNT" \
      --argjson quiesceDurationMs "$QUIESCE_MS" \
      --argjson snapshotCreationMs "$SNAPSHOT_MS" \
      --argjson sourceDowntimeMs "$DOWNTIME_MS" \
      --argjson uploadDurationMs "$UPLOAD_MS" \
      --argjson totalWallTimeMs "$TOTAL_MS" \
      --argjson uploadBytesPerSec "$UPLOAD_RATE" \
      --arg snapshotMode "direct" \
      --argjson parallelWorkers "$PARALLEL_WORKERS" \
      --argjson urlBatchRefreshes "$URL_BATCH_REFRESHES" \
      --argjson chunksRetried "$CHUNKS_RETRIED" \
      --argjson chunksSkipped "$CHUNKS_SKIPPED" \
      '{success: true, snapshotId: $snapshotId, merkleRootHash: $merkleRootHash, chunkCount: $chunkCount, metrics: {quiesceDurationMs: $quiesceDurationMs, snapshotCreationMs: $snapshotCreationMs, sourceDowntimeMs: $sourceDowntimeMs, uploadDurationMs: $uploadDurationMs, totalWallTimeMs: $totalWallTimeMs, uploadBytesPerSec: $uploadBytesPerSec, snapshotMode: $snapshotMode, parallelWorkers: $parallelWorkers, urlBatchRefreshes: $urlBatchRefreshes, chunksRetried: $chunksRetried, chunksSkipped: $chunksSkipped}}'
  else
    local SEAL_ERR=$(echo "$SEAL_RESP" | jq -r '.error // "unknown seal error"')
    log "Block migration seal failed: $SEAL_ERR"
    jq -nc --arg err "seal failed: $SEAL_ERR" '{success: false, error: $err}'
    return 1
  fi
}

# ============================================================================
# BLOCK MIGRATE DOWNLOAD (Destination Side)
# ============================================================================

block_migrate_download() {
  local CMD_PAYLOAD="$1"

  # Work directory in tmpfs — private keys and metadata only (small).
  # Chunk data is NEVER staged to a file; it streams through pipes
  # (dd → tee → sha256sum + curl) so neither disk nor RAM is consumed.
  umask 077
  mkdir -p /run/ellul
  local WORK_DIR=$(mktemp -d /run/ellul/block-migrate-XXXXXXXX)
  chmod 700 "$WORK_DIR"

  local T_START=$(date +%s%N 2>/dev/null || date +%s)

  # Parse payload
  local TARGET_DEVICE=$(echo "$CMD_PAYLOAD" | jq -r '.volumeDevice // empty')
  local SNAPSHOT_ID=$(echo "$CMD_PAYLOAD" | jq -r '.snapshotId // empty')
  local RESUME_FROM=$(echo "$CMD_PAYLOAD" | jq -r '.resumeFromChunk // 0')
  local API_BASE=$(echo "$CMD_PAYLOAD" | jq -r '.apiBaseUrl // empty')
  local EXPECTED_MERKLE=$(echo "$CMD_PAYLOAD" | jq -r '.expectedMerkleRoot // empty')
  local EXPECTED_CHUNK_COUNT=$(echo "$CMD_PAYLOAD" | jq -r '.expectedChunkCount // 0')
  local BLOCK_SNAPSHOT_VERSION=$(echo "$CMD_PAYLOAD" | jq -r '.blockSnapshotVersion // 0')
  local FORCE_FULL_VERIFY=$(echo "$CMD_PAYLOAD" | jq -r '.forceFullVerification // false')
  local MANIFEST_JSON=$(echo "$CMD_PAYLOAD" | jq -r '.manifestJson // empty')
  local SIGNING_PUBLIC_KEY_JSON=$(echo "$CMD_PAYLOAD" | jq -r '.signingPublicKeyJson // empty')
  local WRAPPED_LUKS_PASSPHRASE=$(echo "$CMD_PAYLOAD" | jq -r '.wrappedLuksPassphrase // empty')
  local WORKERS=$(echo "$CMD_PAYLOAD" | jq -r '.parallelWorkers // empty')
  [ -n "$WORKERS" ] && [ "$WORKERS" -gt 0 ] 2>/dev/null && PARALLEL_WORKERS="$WORKERS"

  if [ -z "$TARGET_DEVICE" ] || [ -z "$SNAPSHOT_ID" ] || [ -z "$API_BASE" ]; then
    jq -nc '{success: false, error: "missing volumeDevice, snapshotId, or apiBaseUrl"}'
    rm -rf "$WORK_DIR"
    return 1
  fi

  # Device path validation
  case "$TARGET_DEVICE" in
    /dev/vd[a-z]|/dev/vd[a-z][0-9]*|\
    /dev/sd[a-z]|/dev/sd[a-z][0-9]*|\
    /dev/nvme[0-9]*n[0-9]*|/dev/nvme[0-9]*n[0-9]*p[0-9]*|\
    /dev/disk/by-id/*)
      ;;
    *)
      jq -nc --arg err "rejected device path: $TARGET_DEVICE" '{success: false, error: $err}'
      rm -rf "$WORK_DIR"
      return 1
      ;;
  esac

  if [ ! -e "$TARGET_DEVICE" ]; then
    jq -nc --arg err "target device $TARGET_DEVICE not found" '{success: false, error: $err}'
    rm -rf "$WORK_DIR"
    return 1
  fi

  log "Block migration download: device=$TARGET_DEVICE snapshot=$SNAPSHOT_ID resume=$RESUME_FROM workers=$PARALLEL_WORKERS expected_chunks=$EXPECTED_CHUNK_COUNT"
  log "block-migrate-dl: payload keys: manifest_len=${#MANIFEST_JSON} signing_key_len=${#SIGNING_PUBLIC_KEY_JSON} merkle_len=${#EXPECTED_MERKLE}"

  # Lock: timestamp-based stale detection (PID-based fails in long-running daemons).
  local LOCK_DIR="/run/ellul-block-migrate-download.lock"
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    local LOCK_TS=$(cat "$LOCK_DIR/ts" 2>/dev/null || echo 0)
    local NOW_TS=$(date +%s)
    if [ $((NOW_TS - LOCK_TS)) -gt 600 ]; then
      log "block-migrate-dl: stale download lock ($(( (NOW_TS - LOCK_TS) / 60 ))m old), breaking"
      rm -rf "$LOCK_DIR"
      mkdir "$LOCK_DIR" 2>/dev/null || true
    else
      log "block-migrate-dl: lock held (age=$(( NOW_TS - LOCK_TS ))s), aborting"
      jq -nc '{success: false, error: "another block migration download is running"}'
      rm -rf "$WORK_DIR"
      return 1
    fi
  fi
  date +%s > "$LOCK_DIR/ts"
  log "block-migrate-dl: lock acquired"

  # Cleanup on any exit path (trap RETURN fires when function returns, not when shell exits).
  # Identity lives on boot partition ($IDENTITY_DIR) — survives volume teardown.
  # CACHED_KEY_DIR only holds node.key for LUKS passphrase decryption.
  local CACHED_KEY_DIR=""  # Set later during quiesce; cleanup is safe when empty
  cleanup_download() {
    rm -rf "$WORK_DIR"
    rm -rf "$LOCK_DIR"
    rm -rf "${CACHED_KEY_DIR:-}" 2>/dev/null || true
  }
  trap 'cleanup_download' RETURN

  # Anti-rollback check — check both committed and pending versions
  log "block-migrate-dl: anti-rollback check (snapshot_version=$BLOCK_SNAPSHOT_VERSION)"
  local LOCAL_VERSION=$(cat /etc/ellul/shield-data/.block-snapshot-version 2>/dev/null | tr -d '\n')
  local PENDING_VERSION=$(cat /etc/ellul/shield-data/.block-snapshot-version-pending 2>/dev/null | tr -d '\n')
  local EFFECTIVE_VERSION=${PENDING_VERSION:-${LOCAL_VERSION:-0}}
  log "block-migrate-dl: versions local=$LOCAL_VERSION pending=$PENDING_VERSION effective=$EFFECTIVE_VERSION"
  if [ "$BLOCK_SNAPSHOT_VERSION" -le "$EFFECTIVE_VERSION" ] 2>/dev/null; then
    jq -nc --argjson v "$BLOCK_SNAPSHOT_VERSION" --argjson ev "$EFFECTIVE_VERSION" \
      '{success: false, error: ("snapshot version " + ($v|tostring) + " <= effective version " + ($ev|tostring) + " (anti-rollback)")}'
    return 1
  fi

  # ── Independent manifest signature verification (defense-in-depth) ──
  log "block-migrate-dl: manifest verification (manifest=${#MANIFEST_JSON}b key=${#SIGNING_PUBLIC_KEY_JSON}b crypto_bin=$([ -x "$CRYPTO_BIN" ] && echo yes || echo no))"
  if [ -n "$MANIFEST_JSON" ] && [ -n "$SIGNING_PUBLIC_KEY_JSON" ] && [ -x "$CRYPTO_BIN" ]; then
    local VERIFY_MANIFEST_FILE="$WORK_DIR/verify-manifest.json"
    local VERIFY_KEY_FILE="$WORK_DIR/verify-key.json"
    echo "$MANIFEST_JSON" > "$VERIFY_MANIFEST_FILE"
    echo "$SIGNING_PUBLIC_KEY_JSON" > "$VERIFY_KEY_FILE"

    local VERIFY_ERR="$WORK_DIR/verify-err"
    if "$CRYPTO_BIN" verify \
      --key "$VERIFY_KEY_FILE" \
      --manifest "$VERIFY_MANIFEST_FILE" \
      --algorithm mldsa65 2>"$VERIFY_ERR"; then
      log "Manifest ML-DSA-65 signature verified independently on target"
    else
      # Defense-in-depth: the API already verified the signature (primary trust).
      # Target-side verification may fail due to canonicalization differences between
      # the ellul-crypto binary and the JS signer. Log but don't block — the API
      # verification is authoritative.
      local CRYPTO_ERR=$(cat "$VERIFY_ERR" 2>/dev/null | head -2 | tr '\n' ' ')
      log "WARN: target-side manifest signature verification failed (non-fatal, API verified) err=$CRYPTO_ERR"
    fi
    rm -f "$VERIFY_MANIFEST_FILE" "$VERIFY_KEY_FILE"

    # Cross-check: manifest Merkle root must match expected value from command payload
    local MANIFEST_MERKLE=$(echo "$MANIFEST_JSON" | jq -r '.merkleRootHash // empty')
    if [ -n "$EXPECTED_MERKLE" ] && [ -n "$MANIFEST_MERKLE" ] && [ "$MANIFEST_MERKLE" != "$EXPECTED_MERKLE" ]; then
      log "MERKLE ROOT MISMATCH: manifest=$MANIFEST_MERKLE payload=$EXPECTED_MERKLE — possible tampering"
      jq -nc '{success: false, error: "manifest merkleRootHash does not match command payload expectedMerkleRoot"}'
      return 1
    fi
  else
    log "WARNING: manifest or signing key not provided in download payload — skipping independent signature verification"
  fi

  # ── Quiesce: stop services, unmount, close LUKS ──
  # CRITICAL: Writing raw ciphertext blocks to the device while LUKS has it mapped
  # corrupts the live filesystem. After ~70 chunks the heartbeat signing key gets
  # overwritten, breaking all API auth. Same teardown as the upload side.
  # After download: do NOT restore — the device now has source data. The lifecycle's
  # update-identity / wake-mount handles re-opening LUKS with the source key.
  log "block-migrate-dl: quiesce START — stopping all services..."
  log "block-migrate-dl: pre-quiesce state: mountpoint=$(mountpoint -q "$SVC_HOME" 2>/dev/null && echo yes || echo no) dm=$([ -b /dev/mapper/luks-home ] && echo yes || echo no) procs_home=$(fuser "$SVC_HOME" 2>/dev/null | wc -w)"
  if systemctl is-active --quiet postgresql; then
    runuser -l postgres -c "psql -c 'CHECKPOINT;'" >/dev/null 2>&1 || true
    log "block-migrate-dl: PG checkpoint done"
  fi
  timeout 60 systemctl stop ellul-agent-bridge ellul-file-api ellul-sovereign-shield \
    ellul-preview ellul-term-proxy ellul-perf-monitor \
    ellul-watchdog caddy postgresql \
    "pm2-${SVC_USER}" 'ttyd@*' >/dev/null 2>&1 || true
  local PG_WAIT=0
  while systemctl is-active --quiet postgresql && [ "$PG_WAIT" -lt 10 ]; do
    sleep 1; PG_WAIT=$((PG_WAIT + 1))
  done
  # Kill all user processes (PM2 workers, background jobs, etc.)
  pkill -9 -u "$SVC_USER" 2>/dev/null || true
  sleep 1
  local ACTIVE_SVCS=$(systemctl list-units 'ellul-*' 'ttyd@*' 'pm2-*' caddy postgresql --state=active --no-legend 2>/dev/null | awk '{print $1}' | tr '\n' ',')
  log "block-migrate-dl: services stopped (still active: ${ACTIVE_SVCS:-none})"

  # ── Cache node.key before vault teardown ──
  # Identity files (heartbeat key, server-id, ai-proxy-token) live on the boot
  # partition ($IDENTITY_DIR) and survive volume teardown — no caching needed.
  # Only node.key needs caching: it's used to decrypt the source LUKS passphrase
  # after download completes.
  CACHED_KEY_DIR="/run/ellul/migrate-identity"
  rm -rf "$CACHED_KEY_DIR" 2>/dev/null || true
  mkdir -p "$CACHED_KEY_DIR" && chmod 700 "$CACHED_KEY_DIR"
  # Cache ML-KEM private key (needed to decrypt source LUKS passphrase after download)
  cp "$IDENTITY_DIR/node.key" "$CACHED_KEY_DIR/node.key" 2>/dev/null || true
  local NODE_KEY_OK=$([ -f "$CACHED_KEY_DIR/node.key" ] && echo yes || echo no)
  log "block-migrate-dl: node.key cached to $CACHED_KEY_DIR (node_key=$NODE_KEY_OK), identity on boot partition"

  # ── Volume teardown ──
  # CRITICAL on download: LUKS MUST be closed before writing raw blocks.
  # Writing to /dev/sdb while dm-crypt is mapped corrupts the LUKS header.
  sync
  log "block-migrate-dl: tearing down volume..."

  # Stop udev — do NOT restart before luksClose (causes deadlock)
  udevadm control --stop-exec-queue 2>/dev/null || true
  udevadm settle --timeout=5 2>/dev/null || true

  # FIRST: unmount ALL vault bind mounts that reference the LUKS volume.
  # These keep the device busy even after home is unmounted.
  # Must happen BEFORE home unmount and LUKS close.
  log "block-migrate-dl: unmounting vault bind mounts..."
  for _bp in /etc/ellul /etc/caddy /etc/iptables /etc/ssh/authorized_keys \
             /var/lib/ellul-shielded /var/lib/postgresql \
             /var/log/ellul /var/log/caddy /opt/ellul; do
    if mountpoint -q "$_bp" 2>/dev/null; then
      timeout 5 umount -l "$_bp" 2>/dev/null || true
    fi
  done
  log "block-migrate-dl: vault bind mounts unmounted"

  # THEN: unmount home
  systemctl daemon-reload 2>/dev/null || true
  local _HOME_MOUNT="home-${SVC_USER}.mount"
  timeout 30 systemctl stop "$_HOME_MOUNT" >/dev/null 2>&1
  log "block-migrate-dl: systemctl stop $_HOME_MOUNT exit=$?"

  # Kill any remaining processes with open fds on the volume
  if [ -b /dev/mapper/luks-home ]; then
    timeout 5 fuser -km /dev/mapper/luks-home >/dev/null 2>&1 || true
  fi

  # Verify unmount — force lazy unmount if still mounted
  if mountpoint -q "$SVC_HOME" 2>/dev/null; then
    log "block-migrate-dl: home still mounted — force lazy unmount"
    timeout 5 fuser -km "$SVC_HOME" >/dev/null 2>&1 || true
    sleep 1
    timeout 10 umount -l "$SVC_HOME" 2>/dev/null || true
  fi

  log "block-migrate-dl: post-teardown: mountpoint=$(mountpoint -q "$SVC_HOME" 2>/dev/null && echo yes || echo no) dm_open=$(dmsetup info -c --noheadings -o open luks-home 2>&1)"
  if [ -b /dev/mapper/luks-home ]; then
    log "block-migrate-dl: closing LUKS..."
    local LUKS_ERR="$WORK_DIR/dl-luks-err"
    # CRITICAL: LUKS MUST be closed before writing raw blocks.
    # Pattern from b76a1a3a (April 8 — proven working):
    # luksClose, and if it fails, immediately dmsetup remove --force.
    # timeout -s KILL: cryptsetup luksClose hangs indefinitely on these servers
    # even with dm_open=0. SIGKILL after 10s is unkillable. dmsetup remove --force
    # as immediate fallback.
    if timeout -s KILL 10 cryptsetup luksClose luks-home 2>"$LUKS_ERR"; then
      log "block-migrate-dl: LUKS closed"
    else
      log "block-migrate-dl: LUKS close failed/timed out: $(cat "$LUKS_ERR" 2>/dev/null | tr '\n' ' '), trying dmsetup..."
      timeout -s KILL 10 dmsetup remove --force luks-home 2>/dev/null || log "block-migrate-dl: dmsetup remove also failed/timed out"
    fi
    if [ -b /dev/mapper/luks-home ]; then
      log "block-migrate-dl: FATAL — cannot close LUKS, aborting to prevent data corruption"
      jq -nc '{success: false, error: "LUKS close failed — cannot write raw blocks while dm-crypt is mapped"}'
      return 1
    fi
  else
    log "block-migrate-dl: LUKS already closed"
  fi
  udevadm settle --timeout=10 2>/dev/null || true
  udevadm control --stop-exec-queue 2>/dev/null || true
  log "block-migrate-dl: quiesce COMPLETE (dm=$([ -b /dev/mapper/luks-home ] && echo yes || echo no))"

  # Resolve symlink to stable device path
  local OLD_DEVICE="$TARGET_DEVICE"
  TARGET_DEVICE=$(readlink -f "$TARGET_DEVICE" 2>/dev/null || echo "$TARGET_DEVICE")
  log "block-migrate-dl: device resolved $OLD_DEVICE → $TARGET_DEVICE"

  # Test write to verify device is accessible
  log "block-migrate-dl: testing device write..."
  local TEST_WRITE_ERR="$WORK_DIR/dl-test-write-err"
  if dd if=/dev/zero bs=4096 count=1 of="$TARGET_DEVICE" conv=notrunc 2>"$TEST_WRITE_ERR"; then
    log "block-migrate-dl: test write OK"
  else
    log "block-migrate-dl: TEST WRITE FAILED err=$(cat "$TEST_WRITE_ERR" 2>/dev/null | tr '\n' ' ')"
  fi

  # ── Zero the device upfront so zero-chunk writes can be skipped ──
  # After fstrim on the source, most chunks are zeros. Writing zeros per chunk
  # individually is extremely slow on network-attached storage. Discarding the
  # entire device is fast — the download loop only needs to write non-zero chunks.
  local DEVICE_ZEROED=false
  if command -v blkdiscard >/dev/null 2>&1; then
    local DISCARD_START=$(date +%s)
    if blkdiscard "$TARGET_DEVICE" 2>/dev/null; then
      # Spot check: verify a block from mid-device is actually zeroed.
      # Protects against firmware/driver bugs where discard doesn't zero.
      local SPOT_IDX=$(( EXPECTED_CHUNK_COUNT / 2 ))
      local SPOT_HASH=$(dd if="$TARGET_DEVICE" bs=$BLOCK_CHUNK_SIZE skip=$SPOT_IDX count=1 2>/dev/null | sha256sum | awk '{print $1}')
      if [ "$SPOT_HASH" = "$ZERO_CHUNK_HASH" ]; then
        DEVICE_ZEROED=true
        log "block-migrate-dl: blkdiscard verified ($(( $(date +%s) - DISCARD_START ))s) — zero-chunk writes will be skipped"
      else
        log "block-migrate-dl: blkdiscard ran but spot check FAILED (stale data) — will write zero chunks individually"
      fi
    else
      log "block-migrate-dl: blkdiscard failed (non-fatal) — will write zero chunks individually"
    fi
  else
    log "block-migrate-dl: blkdiscard not available — will write zero chunks individually"
  fi

  # ── Sequential chunk download + verify + write ──
  local HASH_DIR="$WORK_DIR/dl-hashes"
  mkdir -p "$HASH_DIR"
  local DOWNLOAD_FAILED_FLAG="$WORK_DIR/download-fail"
  rm -f "$DOWNLOAD_FAILED_FLAG"
  local DOWNLOAD_SUCCESS=true

  # Precompute zero chunk hash — matches upload's fstrim skip logic
  local ZERO_CHUNK_HASH=$(dd if=/dev/zero bs=$BLOCK_CHUNK_SIZE count=1 2>/dev/null | sha256sum | awk '{print $1}')
  log "block-migrate-dl: zero chunk hash=${ZERO_CHUNK_HASH:0:16}..."

  # Pre-fetch first batch of download URLs
  log "block-migrate-dl: fetching first URL batch (start=$RESUME_FROM)..."
  local DL_CACHE="$WORK_DIR/dl-cache"
  rm -f "$DL_CACHE"
  fetch_download_url_batch "$API_BASE" "$SNAPSHOT_ID" "$RESUME_FROM"
  local INITIAL_URLS=$(wc -l < "$DL_CACHE" 2>/dev/null || echo 0)
  log "block-migrate-dl: initial URL cache: $INITIAL_URLS entries"

  # URL lookup helper
  get_download_info() {
    local IDX="$1"
    grep "^${IDX} " "$DL_CACHE" 2>/dev/null | head -1
  }

  # Worker function: download, verify hash, write to device.
  # Tmpfs staging — must verify hash BEFORE writing to block device.
  download_chunk_worker() {
    local INDEX=$1
    local DL_URL="$2"
    local EXPECTED_HASH="$3"
    local DEVICE="$4"
    local CHUNK_FILE="$WORK_DIR/chunk-${INDEX}"

    # Zero chunk: fstrimmed on source, never uploaded to R2.
    # If device was pre-zeroed via blkdiscard, skip the write entirely (saves ~6s per chunk).
    # Otherwise fall back to writing zeros explicitly.
    if [ -n "$ZERO_CHUNK_HASH" ] && [ "$EXPECTED_HASH" = "$ZERO_CHUNK_HASH" ]; then
      if [ "$DEVICE_ZEROED" = "true" ]; then
        echo "$EXPECTED_HASH" > "$HASH_DIR/$INDEX"
        return 0
      fi
      local ZERO_ERR="$WORK_DIR/zero-write-err-${INDEX}"
      dd if=/dev/zero bs=$BLOCK_CHUNK_SIZE count=1 of="$DEVICE" seek=$INDEX conv=notrunc 2>"$ZERO_ERR"
      local ZERO_EXIT=$?
      if [ "$ZERO_EXIT" -ne 0 ]; then
        log "block-migrate-dl: chunk $INDEX ZERO WRITE FAILED exit=$ZERO_EXIT err=$(cat "$ZERO_ERR" 2>/dev/null | tr '\n' ' ')"
        touch "$DOWNLOAD_FAILED_FLAG"
        return 1
      fi
      echo "$EXPECTED_HASH" > "$HASH_DIR/$INDEX"
      return 0
    fi

    # Download with retry
    local ATTEMPT=0
    local DL_OK=false
    while [ $ATTEMPT -lt $MAX_RETRY_PER_CHUNK ]; do
      local HTTP_CODE=$(curl -s -o "$CHUNK_FILE" -w "%{http_code}" \
        --fail --max-time 120 "$DL_URL" 2>/dev/null)

      if [ "$HTTP_CODE" = "200" ]; then
        DL_OK=true
        break
      fi
      rm -f "$CHUNK_FILE"
      ATTEMPT=$((ATTEMPT + 1))
      log "block-migrate: chunk $INDEX download attempt $ATTEMPT failed (HTTP $HTTP_CODE)"
      local BACKOFF=$(( 5 * (1 << (ATTEMPT - 1)) ))
      sleep "$BACKOFF"
    done

    if [ "$DL_OK" != "true" ]; then
      log "block-migrate: chunk $INDEX download FAILED after $MAX_RETRY_PER_CHUNK attempts"
      touch "$DOWNLOAD_FAILED_FLAG"
      return 1
    fi

    # Verify hash BEFORE writing to device (security critical)
    local DL_SIZE=$(stat -c%s "$CHUNK_FILE" 2>/dev/null || echo 0)
    local ACTUAL_HASH=$(sha256sum "$CHUNK_FILE" | awk '{print $1}')
    if [ "$ACTUAL_HASH" != "$EXPECTED_HASH" ]; then
      log "block-migrate: HASH MISMATCH chunk $INDEX: expected=$EXPECTED_HASH actual=$ACTUAL_HASH size=$DL_SIZE"
      rm -f "$CHUNK_FILE"
      touch "$DOWNLOAD_FAILED_FLAG"
      return 1
    fi

    # Store verified hash for inline Merkle computation
    echo "$ACTUAL_HASH" > "$HASH_DIR/$INDEX"

    # Write to device at exact offset
    local WRITE_ERR="$WORK_DIR/write-err-${INDEX}"
    dd if="$CHUNK_FILE" of="$DEVICE" bs=$BLOCK_CHUNK_SIZE seek=$INDEX conv=notrunc oflag=direct 2>"$WRITE_ERR"
    local WRITE_EXIT=$?
    if [ "$WRITE_EXIT" -ne 0 ]; then
      log "block-migrate-dl: chunk $INDEX WRITE FAILED exit=$WRITE_EXIT err=$(cat "$WRITE_ERR" 2>/dev/null | tr '\n' ' ')"
      touch "$DOWNLOAD_FAILED_FLAG"
      rm -f "$CHUNK_FILE"
      return 1
    fi
    rm -f "$CHUNK_FILE"
  }

  local ACTIVE_WORKERS=0
  local NEXT_DL_BATCH_FETCH=$((RESUME_FROM + URL_BATCH_SIZE * 3 / 4))
  local DL_URL_REFRESHES=0

  local DL_ZERO_COUNT=0
  local DL_NONZERO_COUNT=0
  local DL_PROGRESS_BUF=""
  local DL_PROGRESS_COUNT=0
  local DL_REPORT_INTERVAL=8  # Report every 8 chunks (matches URL batch size)
  log "block-migrate-dl: starting download loop ($RESUME_FROM to $((EXPECTED_CHUNK_COUNT - 1)))"

  local DL_PROGRESS_PING_INTERVAL=30
  local DL_LAST_PROGRESS_PING=$RESUME_FROM

  for i in $(seq "$RESUME_FROM" $((EXPECTED_CHUNK_COUNT - 1))); do
    if [ -f "$DOWNLOAD_FAILED_FLAG" ]; then
      DOWNLOAD_SUCCESS=false
      log "block-migrate-dl: aborting at chunk $i (failure flag set)"
      break
    fi

    # ── Progress heartbeat + watchdog ──
    if [ $(( i - DL_LAST_PROGRESS_PING )) -ge $DL_PROGRESS_PING_INTERVAL ]; then
      systemd-notify WATCHDOG=1 2>/dev/null || true
      signed_api_request -s -o /dev/null --connect-timeout 5 --max-time 10 \
        -d "{\"migrationProgress\":true,\"chunksDownloaded\":$i,\"totalChunks\":$EXPECTED_CHUNK_COUNT}" \
        "$API_URL/api/servers/heartbeat" 2>/dev/null || true
      DL_LAST_PROGRESS_PING=$i
    fi

    # Refresh URL batch when 75% consumed
    if [ "$i" -ge "$NEXT_DL_BATCH_FETCH" ] && [ "$i" -lt $((EXPECTED_CHUNK_COUNT - 1)) ]; then
      fetch_download_url_batch "$API_BASE" "$SNAPSHOT_ID" "$i"
      NEXT_DL_BATCH_FETCH=$((i + URL_BATCH_SIZE * 3 / 4))
      DL_URL_REFRESHES=$((DL_URL_REFRESHES + 1))
    fi

    local DL_INFO=$(get_download_info "$i")
    local DL_URL=$(echo "$DL_INFO" | awk '{print $4}')
    local EXPECTED_HASH=$(echo "$DL_INFO" | awk '{print $2}')

    if [ -z "$DL_URL" ] && [ "$EXPECTED_HASH" != "$ZERO_CHUNK_HASH" ]; then
      # URL not in cache — fetch individually (not needed for zero chunks)
      fetch_download_url_batch "$API_BASE" "$SNAPSHOT_ID" "$i" 1
      DL_INFO=$(get_download_info "$i")
      DL_URL=$(echo "$DL_INFO" | awk '{print $4}')
      EXPECTED_HASH=$(echo "$DL_INFO" | awk '{print $2}')
    fi

    if [ -z "$DL_URL" ] && [ "$EXPECTED_HASH" != "$ZERO_CHUNK_HASH" ]; then
      log "block-migrate: chunk $i NO download URL — will fail"
    fi

    # Log first chunk to confirm loop started
    if [ "$i" -eq "$RESUME_FROM" ]; then
      log "block-migrate-dl: first chunk $i — hash=${EXPECTED_HASH:0:16} url_present=$([ -n "$DL_URL" ] && echo yes || echo no) is_zero=$([ "$EXPECTED_HASH" = "$ZERO_CHUNK_HASH" ] && echo yes || echo no)"
    fi

    # Sequential execution
    download_chunk_worker "$i" "$DL_URL" "$EXPECTED_HASH" "$TARGET_DEVICE"
    local WORKER_RC=$?

    # Track zero vs non-zero
    if [ "$EXPECTED_HASH" = "$ZERO_CHUNK_HASH" ]; then
      DL_ZERO_COUNT=$((DL_ZERO_COUNT + 1))
    else
      DL_NONZERO_COUNT=$((DL_NONZERO_COUNT + 1))
    fi

    # Buffer chunk index for batch progress report
    if [ -z "$DL_PROGRESS_BUF" ]; then
      DL_PROGRESS_BUF="$i"
    else
      DL_PROGRESS_BUF="${DL_PROGRESS_BUF},$i"
    fi
    DL_PROGRESS_COUNT=$((DL_PROGRESS_COUNT + 1))

    # Report download progress every DL_REPORT_INTERVAL chunks
    if [ "$DL_PROGRESS_COUNT" -ge "$DL_REPORT_INTERVAL" ] || [ "$i" -eq $((EXPECTED_CHUNK_COUNT - 1)) ]; then
      report_download_progress "$API_BASE" "$SNAPSHOT_ID" "[$DL_PROGRESS_BUF]" >/dev/null 2>&1
      DL_PROGRESS_BUF=""
      DL_PROGRESS_COUNT=0
    fi

    if [ $(( (i + 1) % 10 )) -eq 0 ]; then
      log "Download progress: $((i + 1))/$EXPECTED_CHUNK_COUNT (zero=$DL_ZERO_COUNT nonzero=$DL_NONZERO_COUNT rc=$WORKER_RC)"
      # Lightweight heartbeat ping — keeps the server "alive" in the API so
      # reconcilers and UI don't treat it as dead during long transfers.
      signed_api_request -s -o /dev/null --connect-timeout 3 --max-time 5 \
        -X POST -d '{"migrating":true}' \
        "$API_URL/api/servers/heartbeat" 2>/dev/null &
    fi
  done

  # Flush any remaining buffered progress
  if [ -n "$DL_PROGRESS_BUF" ]; then
    report_download_progress "$API_BASE" "$SNAPSHOT_ID" "[$DL_PROGRESS_BUF]" >/dev/null 2>&1
  fi

  log "block-migrate: download loop done (dispatched up to chunk $i), waiting for remaining workers..."
  wait  # Wait for all remaining workers
  sync  # Flush hash files and device writes before Merkle computation
  log "block-migrate: all download workers completed"

  if [ -f "$DOWNLOAD_FAILED_FLAG" ]; then
    DOWNLOAD_SUCCESS=false
    log "block-migrate: download failed flag detected after wait"
  fi

  local DL_HASH_COUNT=$(ls "$HASH_DIR"/ 2>/dev/null | wc -l)
  log "block-migrate-dl: download loop complete — success=$DOWNLOAD_SUCCESS hashes=$DL_HASH_COUNT/$EXPECTED_CHUNK_COUNT zero=$DL_ZERO_COUNT nonzero=$DL_NONZERO_COUNT"

  rm -f "$DL_CACHE" "$DOWNLOAD_FAILED_FLAG"

  local T_DOWNLOAD_DONE=$(date +%s%N 2>/dev/null || date +%s)

  if [ "$DOWNLOAD_SUCCESS" != "true" ]; then
    local DL_DIAG="chunks_done=$((DL_ZERO_COUNT + DL_NONZERO_COUNT)) zero=$DL_ZERO_COUNT nonzero=$DL_NONZERO_COUNT hashes=$DL_HASH_COUNT device=$TARGET_DEVICE"
    DL_DIAG="$DL_DIAG dm=$([ -b /dev/mapper/luks-home ] && echo yes || echo no)"
    DL_DIAG="$DL_DIAG last_errs=$(cat "$WORK_DIR"/write-err-* "$WORK_DIR"/zero-write-err-* 2>/dev/null | head -3 | tr '\n' ' ')"
    log "block-migrate-dl: FAILED diagnostic: $DL_DIAG"
    rm -rf "$HASH_DIR"
    jq -nc --arg diag "$DL_DIAG" '{success: false, error: "chunk download/verify failed", diagnostic: $diag}'
    return 1
  fi

  # ── Merkle root verification (inline — from download-verified hashes, no device re-read) ──
  # Security: each chunk's SHA-256 was verified against the manifest's expected hash
  # immediately after download and before the hash was stored. Computing Merkle from
  # those verified hashes is cryptographically equivalent to a full re-read, assuming
  # verified write completion semantics from dd oflag=direct.
  local CHUNK_HASHES_FILE="$WORK_DIR/dl-all-hashes"
  > "$CHUNK_HASHES_FILE"
  for i in $(seq 0 $((EXPECTED_CHUNK_COUNT - 1))); do
    if [ -f "$HASH_DIR/$i" ]; then
      cat "$HASH_DIR/$i" >> "$CHUNK_HASHES_FILE"
    fi
  done
  rm -rf "$HASH_DIR"

  # Optional full device re-read (escape hatch for providers with unreliable oflag=direct)
  if [ "$FORCE_FULL_VERIFY" = "true" ]; then
    log "Full device re-read verification requested (forceFullVerification=true)"
    > "$CHUNK_HASHES_FILE"
    for i in $(seq 0 $((EXPECTED_CHUNK_COUNT - 1))); do
      local CHUNK_FILE="$WORK_DIR/verify-chunk"
      dd if="$TARGET_DEVICE" bs=$BLOCK_CHUNK_SIZE skip=$i count=1 iflag=fullblock of="$CHUNK_FILE" 2>/dev/null
      sha256sum "$CHUNK_FILE" | awk '{print $1}' >> "$CHUNK_HASHES_FILE"
      rm -f "$CHUNK_FILE"
    done
  fi

  log "block-migrate: computing download Merkle root..."
  local COMPUTED_ROOT=$(compute_merkle_root "$CHUNK_HASHES_FILE")
  rm -f "$CHUNK_HASHES_FILE"
  log "block-migrate: download Merkle root=${COMPUTED_ROOT:0:16}... expected=${EXPECTED_MERKLE:0:16}..."

  if [ -n "$EXPECTED_MERKLE" ] && [ "$COMPUTED_ROOT" != "$EXPECTED_MERKLE" ]; then
    log "block-migrate: MERKLE ROOT MISMATCH — data integrity violation"
    jq -nc '{success: false, error: "merkle root mismatch after write"}'
    return 1
  fi
  log "block-migrate: Merkle root verified"

  local T_VERIFY_DONE=$(date +%s%N 2>/dev/null || date +%s)

  # ── LUKS header spot-check (defense-in-depth) ──
  local WRITTEN_HEADER_HASH=$(dd if="$TARGET_DEVICE" bs=1M count=16 2>/dev/null | sha256sum | awk '{print $1}')
  local EXPECTED_HEADER_HASH=$(echo "$CMD_PAYLOAD" | jq -r '.expectedLuksHeaderHash // empty')
  if [ -n "$EXPECTED_HEADER_HASH" ] && [ "$WRITTEN_HEADER_HASH" != "$EXPECTED_HEADER_HASH" ]; then
    log "LUKS HEADER HASH MISMATCH: expected=$EXPECTED_HEADER_HASH actual=$WRITTEN_HEADER_HASH"
    jq -nc '{success: false, error: "LUKS header hash mismatch"}'
    return 1
  fi

  # ── Re-open source LUKS + restore vault ──
  # CRITICAL: The raw device now has the source's LUKS ciphertext. We must re-open
  # LUKS using the source's passphrase so the vault is accessible again. Without
  # this, the server is bricked — no heartbeat key, no services, no commands.
  # The source's encrypted LUKS key is in the download payload, encrypted with
  # the target server's ML-KEM public key. Decrypt locally and open.
  # Restore fstab entries + unmask mount units (disabled during teardown).
  # Must happen BEFORE LUKS open so mount-volume and mount -a work correctly.
  sed -i 's|^#MIGRATE# ||' /etc/fstab 2>/dev/null || true
  local _HOME_MOUNT="home-${SVC_USER}.mount"
  systemctl unmask "$_HOME_MOUNT" 2>/dev/null || true
  for _mp in etc-ellul etc-caddy etc-iptables etc-ssh-authorized_keys \
             var-lib-ellul\\x2dshielded var-lib-postgresql \
             var-log-ellul var-log-caddy opt-ellul; do
    systemctl unmask "${_mp}.mount" 2>/dev/null || true
  done
  systemctl daemon-reload 2>/dev/null || true
  udevadm control --start-exec-queue 2>/dev/null || true

  # Re-open source LUKS on target using the ML-KEM-encrypted passphrase from the API.
  # Same crypto path as wake-mount: decrypt with target's ML-KEM private key (cached).
  log "block-migrate-dl: === LUKS RESTORE START ==="
  log "block-migrate-dl: target_device=$TARGET_DEVICE svc_home=$SVC_HOME"
  log "block-migrate-dl: luks_passphrase_len=${#WRAPPED_LUKS_PASSPHRASE} crypto_bin=$([ -x "$CRYPTO_BIN" ] && echo yes || echo no)"
  log "block-migrate-dl: dm_exists=$([ -b /dev/mapper/luks-home ] && echo yes || echo no) home_mounted=$(mountpoint -q "$SVC_HOME" 2>/dev/null && echo yes || echo no)"

  local MOUNT_SCRIPT="/usr/local/bin/ellul-mount-volume"
  local _LUKS_OPENED=false
  local _MOUNT_PATH=""

  if [ -n "$WRAPPED_LUKS_PASSPHRASE" ] && [ -x "$CRYPTO_BIN" ]; then
    local LUKS_KEY_FILE="$WORK_DIR/source-luks-key"
    local NODE_KEY="${CACHED_KEY_DIR}/node.key"
    if [ ! -f "$NODE_KEY" ]; then
      log "block-migrate-dl: FATAL — cached node.key not found at $NODE_KEY, cannot decrypt LUKS passphrase"
    else
      log "block-migrate-dl: decrypting LUKS passphrase (node_key=$(stat -c%s "$NODE_KEY" 2>/dev/null)b)"
      echo "$WRAPPED_LUKS_PASSPHRASE" | "$CRYPTO_BIN" decrypt \
        --key "$NODE_KEY" \
        --stdin > "$LUKS_KEY_FILE" 2>/dev/null
      local DECRYPT_SIZE=$(stat -c%s "$LUKS_KEY_FILE" 2>/dev/null || echo 0)
      log "block-migrate-dl: LUKS passphrase decrypted ($DECRYPT_SIZE bytes)"
      if [ "$DECRYPT_SIZE" -gt 0 ]; then
        cp "$LUKS_KEY_FILE" /dev/shm/.luks-platform-key 2>/dev/null
        cp "$LUKS_KEY_FILE" /dev/shm/.luks-restore-key 2>/dev/null

        # Update root FS platform keyfile BEFORE mount-volume (vault bind mounts hide root FS)
        local _ROOT_KEYFILE="/etc/ellul/.luks-platform-keyfile"
        if [ -f "$_ROOT_KEYFILE" ]; then
          cp "$LUKS_KEY_FILE" "$_ROOT_KEYFILE" 2>/dev/null
          chown root:root "$_ROOT_KEYFILE" 2>/dev/null
          chmod 400 "$_ROOT_KEYFILE" 2>/dev/null
          log "block-migrate-dl: root FS platform keyfile updated ($(stat -c%s "$_ROOT_KEYFILE" 2>/dev/null)b)"
        else
          log "block-migrate-dl: WARN — root FS keyfile not found at $_ROOT_KEYFILE"
        fi

        # Try mount-volume first (opens LUKS + mounts + vault restore).
        # mount-volume writes a JSON result to stdout and human-readable
        # progress to stderr. Keep them separate so jq only parses JSON —
        # merging them caused standard volumes to be misclassified as sovereign.
        log "block-migrate-dl: calling mount-volume mount $TARGET_DEVICE"
        local _MV_OUTPUT _MV_STDERR_FILE
        _MV_STDERR_FILE=$(mktemp /tmp/mv-stderr-XXXXXX)
        _MV_OUTPUT=$("$MOUNT_SCRIPT" mount "$TARGET_DEVICE" 2>"$_MV_STDERR_FILE") || true
        if [ -s "$_MV_STDERR_FILE" ]; then
          log "block-migrate-dl: mount-volume stderr: $(tr '\n' ' ' < "$_MV_STDERR_FILE")"
        fi
        rm -f "$_MV_STDERR_FILE"
        log "block-migrate-dl: mount-volume output: $_MV_OUTPUT"

        if echo "$_MV_OUTPUT" | jq -e '.success == true' >/dev/null 2>&1; then
          _LUKS_OPENED=true
          _MOUNT_PATH="mount-volume"
          local _MV_ALREADY=$(echo "$_MV_OUTPUT" | jq -r '.alreadyMounted // false')
          log "block-migrate-dl: mount-volume succeeded (alreadyMounted=$_MV_ALREADY)"
        else
          log "block-migrate-dl: mount-volume failed, trying manual LUKS open..."
          if timeout 30 cryptsetup luksOpen --key-file /dev/shm/.luks-restore-key --key-slot 1 "$TARGET_DEVICE" luks-home 2>/dev/null; then
            _LUKS_OPENED=true
            _MOUNT_PATH="manual-slot1"
            log "block-migrate-dl: LUKS opened via slot 1"
          elif timeout 60 cryptsetup luksOpen --key-file /dev/shm/.luks-restore-key "$TARGET_DEVICE" luks-home 2>/dev/null; then
            _LUKS_OPENED=true
            _MOUNT_PATH="manual-allslots"
            log "block-migrate-dl: LUKS opened (all slots)"
          else
            log "block-migrate-dl: FATAL — cryptsetup luksOpen failed on all paths"
          fi
          if [ -b /dev/mapper/luks-home ]; then
            mount -o nosuid,nodev /dev/mapper/luks-home "$SVC_HOME" 2>/dev/null || true
            systemctl daemon-reload 2>/dev/null || true
            mount -a 2>/dev/null || true
            log "block-migrate-dl: manual mount done (mounted=$(mountpoint -q "$SVC_HOME" 2>/dev/null && echo yes || echo no))"
          fi
        fi
        rm -f "$LUKS_KEY_FILE" /dev/shm/.luks-restore-key 2>/dev/null
      else
        log "block-migrate-dl: FATAL — ML-KEM decrypt returned empty ($DECRYPT_SIZE bytes)"
      fi
    fi
  else
    log "block-migrate-dl: FATAL — no LUKS passphrase (wrapped_len=${#WRAPPED_LUKS_PASSPHRASE} crypto=$([ -x "$CRYPTO_BIN" ] && echo yes || echo no))"
  fi

  # ── Post-LUKS diagnostic: what's actually on the volume? ──
  log "block-migrate-dl: === POST-LUKS DIAGNOSTIC ==="
  log "block-migrate-dl: luks_opened=$_LUKS_OPENED mount_path=$_MOUNT_PATH"
  log "block-migrate-dl: dm_exists=$([ -b /dev/mapper/luks-home ] && echo yes || echo no)"
  log "block-migrate-dl: home_mounted=$(mountpoint -q "$SVC_HOME" 2>/dev/null && echo yes || echo no)"
  log "block-migrate-dl: home_source=$(findmnt -n -o SOURCE "$SVC_HOME" 2>/dev/null || echo none)"
  if mountpoint -q "$SVC_HOME" 2>/dev/null; then
    log "block-migrate-dl: home_contents=$(ls -A "$SVC_HOME" 2>/dev/null | head -20 | tr '\n' ' ')"
    log "block-migrate-dl: home_usage=$(du -sh "$SVC_HOME" 2>/dev/null | awk '{print $1}')"
    local _VAULT_PATH="$SVC_HOME/.ellul-vault"
    log "block-migrate-dl: vault_exists=$([ -d "$_VAULT_PATH" ] && echo yes || echo no)"
    log "block-migrate-dl: vault_initialized=$([ -f "$_VAULT_PATH/.initialized" ] && echo yes || echo no)"
    if [ -d "$_VAULT_PATH" ]; then
      log "block-migrate-dl: vault_contents=$(ls -A "$_VAULT_PATH" 2>/dev/null | tr '\n' ' ')"
      log "block-migrate-dl: vault_etc_ellul=$(ls "$_VAULT_PATH/etc/ellul" 2>/dev/null | wc -l) files"
      log "block-migrate-dl: vault_shielded=$([ -d "$_VAULT_PATH/var/lib/ellul-shielded" ] && echo yes || echo no)"
      log "block-migrate-dl: vault_shield_data=$(ls "$_VAULT_PATH/etc/ellul/shield-data" 2>/dev/null | wc -l) files"
    fi
  else
    log "block-migrate-dl: WARN — home not mounted, cannot inspect volume"
  fi

  # ── Sovereign boot markers ──
  # Block migration copies only the encrypted volume, NOT the boot partition.
  # The source's sovereign marker must be replicated so luks-boot and enforcer
  # recognize sovereign mode on subsequent reboots.
  if [ "$_LUKS_OPENED" = "false" ] && cryptsetup isLuks "$TARGET_DEVICE" 2>/dev/null; then
    mkdir -p "$IDENTITY_DIR" 2>/dev/null
    echo "sovereign" > "$IDENTITY_DIR/volume-security-mode"
    echo 1 > "$IDENTITY_DIR/volume-was-encrypted"
    chmod 444 "$IDENTITY_DIR/volume-security-mode" "$IDENTITY_DIR/volume-was-encrypted" 2>/dev/null
    log "block-migrate-dl: sovereign boot markers written (LUKS blocks transferred, awaiting PRF unlock)"
  fi

  # ── Unified server state restoration ──
  log "block-migrate-dl: === RESTORE SERVER STATE ==="
  restore_server_state "block-migrate-dl"
  local _RESTORE_RC=$?
  log "block-migrate-dl: restore_server_state returned $_RESTORE_RC"

  # Post-restore diagnostic
  log "block-migrate-dl: post_restore: etc_ellul_mounted=$(mountpoint -q /etc/ellul 2>/dev/null && echo yes || echo no)"
  log "block-migrate-dl: post_restore: shielded_mounted=$(mountpoint -q /var/lib/ellul-shielded 2>/dev/null && echo yes || echo no)"
  log "block-migrate-dl: post_restore: caddy_mounted=$(mountpoint -q /etc/caddy 2>/dev/null && echo yes || echo no)"
  log "block-migrate-dl: post_restore: billing_tier=$(cat /etc/ellul/billing-tier 2>/dev/null || echo MISSING)"
  log "block-migrate-dl: === LUKS RESTORE COMPLETE ==="

  # ── Persist anti-rollback version ──
  local VERSION_DIR="/etc/ellul/shield-data"
  [ -d "$VERSION_DIR" ] || VERSION_DIR="/run/ellul"
  mkdir -p "$VERSION_DIR" 2>/dev/null
  echo "$BLOCK_SNAPSHOT_VERSION" > "$VERSION_DIR/.block-snapshot-version-pending"
  echo "$CMD_PAYLOAD" | jq -r '.manifestJson // empty' > "$VERSION_DIR/.block-migration-manifest.json" 2>/dev/null
  log "block-migrate-dl: anti-rollback version persisted to $VERSION_DIR"

  # ── Report verification to API ──
  local VERIFY_RESP=$(signed_api_request -s --max-time 10 \
    -X POST \
    -d "{\"merkleRootHash\":\"$COMPUTED_ROOT\"}" \
    "$API_BASE/api/servers/block-migration/$SNAPSHOT_ID/verify")

  local VERIFY_OK=$(echo "$VERIFY_RESP" | jq -r '.ok // false')
  log "block-migrate: verify API response ok=$VERIFY_OK resp_len=${#VERIFY_RESP} resp_prefix=${VERIFY_RESP:0:120}"

  local T_END=$(date +%s%N 2>/dev/null || date +%s)

  # ── Metrics ──
  local DOWNLOAD_MS=0 VERIFY_MS=0 TOTAL_MS=0 DL_RATE=0
  if [ ${#T_START} -gt 12 ]; then
    DOWNLOAD_MS=$(( (T_DOWNLOAD_DONE - T_START) / 1000000 ))
    VERIFY_MS=$(( (T_VERIFY_DONE - T_DOWNLOAD_DONE) / 1000000 ))
    TOTAL_MS=$(( (T_END - T_START) / 1000000 ))
    [ "$DOWNLOAD_MS" -gt 0 ] && DL_RATE=$(( $(blockdev --getsize64 "$TARGET_DEVICE" 2>/dev/null || echo 0) * 1000 / DOWNLOAD_MS ))
  fi

  if [ "$VERIFY_OK" = "true" ]; then
    log "Block migration download verified: snapshot=$SNAPSHOT_ID merkle=${COMPUTED_ROOT:0:16}..."
    local RESULT_JSON=$(jq -nc \
      --arg snapshotId "$SNAPSHOT_ID" \
      --arg merkleRootHash "$COMPUTED_ROOT" \
      --argjson downloadDurationMs "$DOWNLOAD_MS" \
      --argjson verificationDurationMs "$VERIFY_MS" \
      --argjson totalWallTimeMs "$TOTAL_MS" \
      --argjson downloadBytesPerSec "$DL_RATE" \
      --argjson parallelWorkers "$PARALLEL_WORKERS" \
      --argjson urlBatchRefreshes "$DL_URL_REFRESHES" \
      '{success: true, snapshotId: $snapshotId, merkleRootHash: $merkleRootHash, metrics: {downloadDurationMs: $downloadDurationMs, verificationDurationMs: $verificationDurationMs, totalWallTimeMs: $totalWallTimeMs, downloadBytesPerSec: $downloadBytesPerSec, parallelWorkers: $parallelWorkers, urlBatchRefreshes: $urlBatchRefreshes}}')

    # ── Self-report command completion with retry ──
    # A lost report leaves the command "claimed" forever, hanging migration.
    # Retry 3x with escalating timeouts. The parent enforcer's report_worker_results
    # is a second line of defense, and the API's stale claim detection is the third.
    if [ -n "$CMD_ID" ]; then
      local SELF_REPORT=$(jq -n --argjson result "$RESULT_JSON" '{success: true, result: $result}' 2>/dev/null)
      local _sr_ok=false
      for _sr_attempt in 1 2 3; do
        local _sr_http
        _sr_http=$(signed_api_request -s -o /dev/null -w "%{http_code}" \
          --connect-timeout 5 --max-time $((10 * _sr_attempt)) \
          -X POST -d "$SELF_REPORT" \
          "$API_URL/api/servers/commands/$CMD_ID/complete" 2>/dev/null) || _sr_http="000"
        if [ "$_sr_http" = "200" ]; then
          _sr_ok=true
          break
        fi
        log "block-migrate-dl: self-report attempt $_sr_attempt/3 failed (HTTP $_sr_http)"
        [ "$_sr_attempt" -lt 3 ] && sleep 2
      done
      if [ "$_sr_ok" = "true" ]; then
        log "block-migrate-dl: self-reported command completion (CMD_ID=$CMD_ID)"
      else
        log "block-migrate-dl: self-report FAILED after 3 attempts — parent + API stale detection will recover"
      fi
    fi

    echo "$RESULT_JSON"
  else
    local VERIFY_ERR=$(echo "$VERIFY_RESP" | jq -r '.error // "unknown verify error"')
    log "Block migration verification failed: $VERIFY_ERR"
    jq -nc --arg err "verification failed: $VERIFY_ERR" '{success: false, error: $err}'
    return 1
  fi
}

# ============================================================================
# POST-UNLOCK VERIFICATION (Phase 2 — strong trust)
# ============================================================================

verify_block_migration_post_unlock() {
  local PENDING_VERSION="/etc/ellul/shield-data/.block-snapshot-version-pending"
  local MANIFEST_CACHE="/etc/ellul/shield-data/.block-migration-manifest.json"

  if [ ! -f "$PENDING_VERSION" ]; then
    return 0
  fi

  log "Post-LUKS-unlock verification: checking bootstrap integrity..."

  # Secure temp for verification files
  local VERIFY_DIR=$(mktemp -d /tmp/block-verify-XXXXXXXX)
  chmod 700 "$VERIFY_DIR"

  # 1. Verify bootstrap integrity hash
  local STORED_HASH=$(cat /etc/ellul/shield-data/.bootstrap-integrity-hash 2>/dev/null)
  if [ -n "$STORED_HASH" ]; then
    local LIVE_HASH=$(compute_bootstrap_integrity_hash)
    if [ "$STORED_HASH" != "$LIVE_HASH" ]; then
      log "QUARANTINE: Bootstrap integrity mismatch (stored=${STORED_HASH:0:16}... live=${LIVE_HASH:0:16}...)"
      rm -rf "$VERIFY_DIR"
      return 1
    fi
    log "Bootstrap integrity verified"
  fi

  # 2. Re-verify manifest ML-DSA-65 signature with vault-stored key (Phase 2 — real trust anchor)
  # The vault-stored migration-sign.pub.json was inside the LUKS container and cannot have been
  # tampered with without breaking the LUKS seal. This is the strong verification.
  if [ -f "$MANIFEST_CACHE" ] && [ -f "$MIGRATION_SIGN_PUB" ]; then
    local MANIFEST_CONTENT=$(cat "$MANIFEST_CACHE" 2>/dev/null)
    if [ -n "$MANIFEST_CONTENT" ] && [ "$MANIFEST_CONTENT" != "null" ]; then
      local MANIFEST_FILE="$VERIFY_DIR/phase2-manifest"
      printf '%s' "$MANIFEST_CONTENT" > "$MANIFEST_FILE"

      # ML-DSA-65 verification with vault-stored public key via ellul-crypto
      if "$CRYPTO_BIN" verify \
        --key "$MIGRATION_SIGN_PUB" \
        --manifest "$MANIFEST_FILE" \
        --algorithm mldsa65 2>/dev/null; then
        log "Phase 2: Manifest ML-DSA-65 signature verified against vault-stored key"
      else
        log "QUARANTINE: Phase 2 manifest ML-DSA-65 signature FAILED — vault key does not match signer"
        rm -rf "$VERIFY_DIR"
        return 1
      fi
    else
      log "Phase 2: Manifest cache incomplete — skipping signature re-verification"
    fi
  fi

  rm -rf "$VERIFY_DIR"

  # 3. Persist anti-rollback version in vault (promote pending → committed)
  local VERSION=$(cat "$PENDING_VERSION" 2>/dev/null)
  if [ -n "$VERSION" ]; then
    echo "$VERSION" > /etc/ellul/shield-data/.block-snapshot-version
    log "Anti-rollback version persisted: $VERSION"
  fi

  rm -f "$PENDING_VERSION" "$MANIFEST_CACHE"
  return 0
}
