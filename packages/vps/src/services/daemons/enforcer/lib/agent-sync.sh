#!/bin/bash
# Agent Manifest Sync — VPS fleet self-update.
#
# Pulls signed monotonic manifests from
# GET /api/servers/:id/agent-manifest/current, verifies the ML-DSA-65
# JWS signature with the platform signing key on disk, downloads
# component bundles by sha256, atomically flips a `current` symlink in
# /opt/ellul/releases/{component}/, restarts systemd units in
# restartOrder, and reports back to /api/servers/:id/agent-report.
#
# This file is included in the enforcer bundle before heartbeat.sh so
# fetch_entitlement_if_stale and poll_and_execute_commands can call the
# JWS helpers defined below.

# ── Shared JWS helpers (used by entitlement pull, agent sync, and the
# ── apply-pending-update command handler).

# Verify an ML-DSA-65 JWS signature over `header.body`.
#
# Args: $1 = compact JWS string (header.body.sig, base64url segments)
#       $2 = pubkey file path (JSON format, e.g. $COMMAND_SIGNING_PUBKEY_FILE)
# Returns: 0 on valid, 1 on malformed or invalid signature
# Side effects: none (cleans up its own tempfile)
verify_jws_ml_dsa65() {
  local jws="$1"
  local pubkey_file="$2"

  [ -z "$jws" ] && return 1
  [ -f "$pubkey_file" ] || return 1
  [ -x "$CRYPTO_BIN" ] || return 1

  # Structural validation: three base64url segments separated by dots.
  if ! echo "$jws" | grep -qxE '[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+'; then
    return 1
  fi

  local header body sig
  header=$(echo "$jws" | cut -d. -f1)
  body=$(echo "$jws" | cut -d. -f2)
  sig=$(echo "$jws" | cut -d. -f3)

  local sign_input_file
  sign_input_file=$(mktemp /tmp/jws-sign-XXXXXX)
  printf '%s.%s' "$header" "$body" > "$sign_input_file"

  # base64url → standard base64: swap -_ for +/ and pad to length % 4 == 0.
  # ellul-crypto verify reads signatures from stdin as standard base64.
  local sig_std="$sig"
  sig_std="${sig_std//-/+}"
  sig_std="${sig_std//_//}"
  case $(( ${#sig_std} % 4 )) in
    2) sig_std="${sig_std}==" ;;
    3) sig_std="${sig_std}=" ;;
  esac

  local rc=0
  if ! printf '%s' "$sig_std" | "$CRYPTO_BIN" verify \
      --key "$pubkey_file" \
      --input "$sign_input_file" \
      --algorithm mldsa65 2>/dev/null; then
    rc=1
  fi
  rm -f "$sign_input_file"
  return $rc
}

# Parse a v2 or v3 key ring file into newline-separated "kid:tmpfile" pairs.
# For v2, outputs "v2:<keyfile>" (no temp created). For v3, writes each key
# to a temp single-key v2 JSON that ellul-crypto can consume.
# Caller cleans up temp files that are NOT the original keyfile.
parse_keyring() {
  local keyfile="$1"
  [ -f "$keyfile" ] || return 1

  local ver
  ver=$(jq -r '.version // 2' "$keyfile" 2>/dev/null)

  if [ "$ver" != "3" ]; then
    echo "v2:$keyfile"
    return 0
  fi

  local entries
  entries=$(jq -r '.keys[]? | select(.mldsa_pk != null and .mldsa_pk != "" and .kid != null and .kid != "") | [.kid, .algorithm, .mldsa_pk, (.status // "active")] | @tsv' "$keyfile" 2>/dev/null)

  [ -z "$entries" ] && { echo "v2:$keyfile"; return 0; }

  while IFS=$'\t' read -r kid algo pk status; do
    [ "$status" = "revoked" ] && continue
    local tmpf
    tmpf=$(mktemp /run/ellul-keyring-XXXXXX)
    printf '{"version":2,"algorithm":"%s","mldsa_pk":"%s"}' "$algo" "$pk" > "$tmpf"
    echo "$kid:$tmpf"
  done <<< "$entries"
}

# Try all keys in a v2/v3 key ring for JWS verification.
# Fast-path: extract kid from JWS header, try matching key first.
verify_jws_ml_dsa65_ring() {
  local jws="$1"
  local keyring_file="$2"

  [ -z "$jws" ] && return 1
  [ -f "$keyring_file" ] || return 1

  local entries entries_all=() tmpfiles=()
  entries=$(parse_keyring "$keyring_file") || return 1

  local jws_kid=""
  local hdr_b64
  hdr_b64=$(echo "$jws" | cut -d. -f1)
  if [ -n "$hdr_b64" ]; then
    local hdr_std="$hdr_b64"
    hdr_std="${hdr_std//-/+}"
    hdr_std="${hdr_std//_//}"
    case $(( ${#hdr_std} % 4 )) in
      2) hdr_std="${hdr_std}==" ;;
      3) hdr_std="${hdr_std}=" ;;
    esac
    jws_kid=$(printf '%s' "$hdr_std" | base64 -d 2>/dev/null | jq -r '.kid // empty' 2>/dev/null)
  fi

  while IFS= read -r line; do
    [ -z "$line" ] && continue
    local kf="${line#*:}"
    entries_all+=("$line")
    [ "$kf" != "$keyring_file" ] && tmpfiles+=("$kf")
  done <<< "$entries"

  if [ -n "$jws_kid" ]; then
    local e
    for e in "${entries_all[@]}"; do
      local kid="${e%%:*}" kf="${e#*:}"
      if [ "$kid" = "$jws_kid" ]; then
        if verify_jws_ml_dsa65 "$jws" "$kf"; then
          rm -f "${tmpfiles[@]}"
          return 0
        fi
        break
      fi
    done
  fi

  local e
  for e in "${entries_all[@]}"; do
    local kid="${e%%:*}" kf="${e#*:}"
    [ "$kid" = "$jws_kid" ] && continue
    if verify_jws_ml_dsa65 "$jws" "$kf"; then
      rm -f "${tmpfiles[@]}"
      return 0
    fi
  done

  rm -f "${tmpfiles[@]}"
  return 1
}

# Try all keys in a v2/v3 key ring for raw ML-DSA-65 signature verification.
verify_mldsa65_ring() {
  local sig_b64="$1"
  local message_file="$2"
  local keyring_file="$3"

  [ -z "$sig_b64" ] && return 1
  [ -f "$message_file" ] || return 1
  [ -f "$keyring_file" ] || return 1
  [ -x "$CRYPTO_BIN" ] || return 1

  local entries entries_all=() tmpfiles=()
  entries=$(parse_keyring "$keyring_file") || return 1

  while IFS= read -r line; do
    [ -z "$line" ] && continue
    local kf="${line#*:}"
    entries_all+=("$line")
    [ "$kf" != "$keyring_file" ] && tmpfiles+=("$kf")
  done <<< "$entries"

  local e
  for e in "${entries_all[@]}"; do
    local kf="${e#*:}"
    if printf '%s' "$sig_b64" | "$CRYPTO_BIN" verify \
        --key "$kf" \
        --input "$message_file" \
        --algorithm mldsa65 2>/dev/null; then
      rm -f "${tmpfiles[@]}"
      return 0
    fi
  done

  rm -f "${tmpfiles[@]}"
  return 1
}

# Decode the JWS body segment to raw JSON.
#
# Args: $1 = compact JWS string
# Returns: JSON on stdout, empty on failure
# Caller MUST verify the signature FIRST with verify_jws_ml_dsa65.
## Edge-triggered logger for sync_agent_bundle's early-exit reasons.
##
## sync_agent_bundle runs every heartbeat tick (10s). If its prerequisites
## are missing — vault unmounted, server-id absent, signing key gone — it
## must exit fast and SILENTLY for the steady-state case (the same reason
## fires on every tick), but operators NEED to see *which* prerequisite
## failed when a server stops syncing. Logging on every tick floods the
## journal; logging never makes the failure invisible.
##
## Strategy: log only when the reason CHANGES. State stored in a tmpfs
## file under /run so it resets on reboot but persists across heartbeats.
_agent_sync_skip_log() {
  local reason="$1"
  local state_file="/run/ellul-agent-sync-skip-reason"
  local prev=""
  [ -f "$state_file" ] && prev=$(cat "$state_file" 2>/dev/null)
  if [ "$reason" != "$prev" ]; then
    log "agent-sync: skipping — $reason"
    printf '%s' "$reason" > "$state_file" 2>/dev/null || true
  fi
}

## Clear the edge-triggered skip state. Called when sync passes the
## prereq gauntlet so the next failure (a different reason) is logged
## even if we previously logged the same reason. Without this, a server
## that flaps between "missing-server-id" and "missing-signing-pubkey"
## would only log the first transition.
_agent_sync_skip_log_clear() {
  rm -f /run/ellul-agent-sync-skip-reason 2>/dev/null || true
}

## Hash-chain validator — single source of truth used by both
## `sync_agent_bundle` and `apply_pending_update`. Returns 0 if the
## remote manifest is acceptable for the local install state, non-zero
## if the chain says no.
##
## Args: $1 = local installed manifest version (LOCAL_MV, integer)
##       $2 = remote manifest's previousVersion field (string,
##            literal "null" if the manifest has no predecessor)
##       $3 = remote manifest version (for log messages only)
##
## Bootstrap exception: a fresh server (LOCAL_MV=0) has no installed
## components and therefore nothing to "downgrade" — it accepts any
## signed manifest as the starting point. Without this exception, a
## fresh box can NEVER catch up once the canary head advances past v1
## (the API only serves the current head, not historical manifests),
## which leaves every freshly provisioned VPS permanently stuck on the
## bootstrap-baked components. See docs/v2/operations/02-manifest-system.md
## "Bootstrap exception for fresh servers" for the design rationale.
##
## Security: bootstrap is safe because (a) the manifest JWS is verified
## by `verify_jws_ml_dsa65` against the pinned ML-DSA-65 signing key
## BEFORE this function runs, and (b) the API endpoint is HTTPS-only
## and rate-limited per server. An attacker who could MITM the API and
## serve an older signed manifest could only ever do so to a brand-new
## box that has never installed anything — equivalent to provisioning
## the box at the older version directly, which is the same trust
## boundary as the bootstrap image itself.
##
## After bootstrap, monotonicity is enforced: any subsequent manifest
## must chain by version (remote.previousVersion == LOCAL_MV) so
## replay of an older signed manifest is rejected.
##
## NOTE: callers must ALSO have already verified `remote_mv > LOCAL_MV`
## (the monotonic anti-replay fast-path). This function only checks
## the previousVersion linkage, not version ordering.
## Chain rejection state file — persisted so heartbeat_raw can include
## it in the telemetry payload. Cleared when a chain check passes.
## The API surfaces this to release.mjs so operators see chain-reset
## deadlocks instantly instead of watching a convergence timeout.
AGENT_SYNC_CHAIN_REJECTION_FILE="/run/ellul-agent-sync-chain-rejection"

_agent_sync_record_chain_rejection() {
  local remote_mv="$1" remote_prev="$2" local_mv="$3" kind="$4"
  mkdir -p /run 2>/dev/null || true
  printf '{"kind":"%s","remoteVersion":%s,"remotePrevious":%s,"localVersion":%s,"ts":"%s"}\n' \
    "$kind" "$remote_mv" "${remote_prev:-null}" "$local_mv" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    > "$AGENT_SYNC_CHAIN_REJECTION_FILE.new" 2>/dev/null || true
  mv -f "$AGENT_SYNC_CHAIN_REJECTION_FILE.new" "$AGENT_SYNC_CHAIN_REJECTION_FILE" 2>/dev/null || true
}

_agent_sync_clear_chain_rejection() {
  rm -f "$AGENT_SYNC_CHAIN_REJECTION_FILE" 2>/dev/null || true
}

## Throttled chain-rejection upstream report. The VPS reports a
## chain-mismatch to /agent-report at most once per minute per target
## manifest so a runaway enforcer loop can't hammer the API, but also
## reports fast enough that release.mjs sees the failure within a
## single verify poll cycle instead of watching the full convergence
## timeout tick away.
AGENT_SYNC_CHAIN_REPORT_THROTTLE_FILE="/run/ellul-agent-sync-chain-report-throttle"

_agent_sync_maybe_report_chain_rejection() {
  local remote_mv="$1" remote_prev="$2" local_mv="$3" kind="$4"
  # Skip if we already reported this exact rejection in the last 60s.
  local now last last_key cur_key
  now=$(date +%s 2>/dev/null || echo 0)
  cur_key="${remote_mv}:${remote_prev}:${local_mv}:${kind}"
  if [ -f "$AGENT_SYNC_CHAIN_REPORT_THROTTLE_FILE" ]; then
    last=$(head -n1 "$AGENT_SYNC_CHAIN_REPORT_THROTTLE_FILE" 2>/dev/null || echo 0)
    last_key=$(sed -n '2p' "$AGENT_SYNC_CHAIN_REPORT_THROTTLE_FILE" 2>/dev/null || echo "")
    if [ "$last_key" = "$cur_key" ] && [ -n "$last" ] && [ $((now - last)) -lt 60 ]; then
      return 0
    fi
  fi
  printf '%s\n%s\n' "$now" "$cur_key" > "$AGENT_SYNC_CHAIN_REPORT_THROTTLE_FILE" 2>/dev/null || true
  # Report as a failed install so the existing release.mjs failure
  # path surfaces it without needing new summarizeReports logic.
  # The failed_component string is structured so operators (and the
  # API audit log) can pattern-match on "chain_mismatch".
  local err="chain_${kind}: remote_mv=${remote_mv} remote_prev=${remote_prev} local_mv=${local_mv} — run: pnpm release chain-reset --previous-version ${local_mv}"
  post_agent_report "$local_mv" "failed" "$err" 2>/dev/null || true
}

## Auto-recovery counter file. Tracks consecutive chain mismatches for the
## SAME remote manifest. After CHAIN_AUTO_RECOVER_THRESHOLD consecutive
## mismatches, the enforcer accepts the manifest if remote_mv > local_mv
## (the signature was already verified by the caller). This prevents chain
## deadlocks from permanently bricking servers while preserving anti-replay
## protection: only HIGHER versions are auto-accepted, never lower.
##
## Security analysis:
##   - Signature verification (ML-DSA-65) guarantees the manifest is
##     authentic — an attacker can't forge one.
##   - Monotonic check (remote_mv > local_mv) guarantees forward-only.
##   - Chain linkage (previousVersion == local_mv) is defense-in-depth
##     against replay. Auto-recovery relaxes this check ONLY after
##     sustained failure, AND only for higher versions. A replay of an
##     older signed manifest (remote_mv <= local_mv) is still rejected.
##   - AWS/GCP auto-update agents (SSM, OS Config) use the same pattern:
##     signature + monotonic version, no strict chain linkage.
AGENT_SYNC_CHAIN_MISMATCH_COUNTER="/run/ellul-agent-sync-chain-mismatch-count"
CHAIN_AUTO_RECOVER_THRESHOLD=3

agent_sync_chain_check() {
  local local_mv="$1"
  local remote_prev="$2"
  local remote_mv="$3"

  if [ "$local_mv" -eq 0 ]; then
    log "agent-sync: bootstrap accepting manifest v$remote_mv (no prior install state)"
    _agent_sync_clear_chain_rejection
    rm -f "$AGENT_SYNC_CHAIN_REPORT_THROTTLE_FILE" "$AGENT_SYNC_CHAIN_MISMATCH_COUNTER" 2>/dev/null || true
    return 0
  fi

  if [ "$remote_prev" = "null" ]; then
    log "agent-sync: genesis manifest rejected — local=$local_mv (would be a downgrade attack)"
    _agent_sync_record_chain_rejection "$remote_mv" "null" "$local_mv" "genesis_replay"
    _agent_sync_maybe_report_chain_rejection "$remote_mv" "null" "$local_mv" "genesis_replay"
    return 1
  fi

  if [ "$remote_prev" != "$local_mv" ]; then
    # Chain mismatch — check auto-recovery.
    # Increment the consecutive mismatch counter for this specific manifest.
    local count=0 prev_key=""
    local cur_key="${remote_mv}:${remote_prev}"
    if [ -f "$AGENT_SYNC_CHAIN_MISMATCH_COUNTER" ]; then
      count=$(head -n1 "$AGENT_SYNC_CHAIN_MISMATCH_COUNTER" 2>/dev/null || echo 0)
      prev_key=$(sed -n '2p' "$AGENT_SYNC_CHAIN_MISMATCH_COUNTER" 2>/dev/null || echo "")
    fi
    # Reset counter if the manifest changed (different version or prev)
    if [ "$prev_key" != "$cur_key" ]; then
      count=0
    fi
    count=$((count + 1))
    printf '%s\n%s\n' "$count" "$cur_key" > "$AGENT_SYNC_CHAIN_MISMATCH_COUNTER" 2>/dev/null || true

    if [ "$count" -ge "$CHAIN_AUTO_RECOVER_THRESHOLD" ] && [ "$remote_mv" -gt "$local_mv" ]; then
      # Auto-recover: the same higher-version manifest has been presented
      # CHAIN_AUTO_RECOVER_THRESHOLD times. The signature is valid (caller
      # verified), the version is strictly higher (no downgrade), and the
      # chain linkage is the only issue. Accept and move forward.
      log "agent-sync: AUTO-RECOVERY — accepting v$remote_mv after $count consecutive chain mismatches (local=$local_mv, remote.prev=$remote_prev)"
      _agent_sync_clear_chain_rejection
      rm -f "$AGENT_SYNC_CHAIN_REPORT_THROTTLE_FILE" "$AGENT_SYNC_CHAIN_MISMATCH_COUNTER" 2>/dev/null || true
      post_agent_report "$local_mv" "chain_auto_recovered" "accepted v${remote_mv} after ${count} mismatches (prev=${remote_prev} local=${local_mv})" 2>/dev/null || true
      return 0
    fi

    log "agent-sync: chain mismatch ($count/$CHAIN_AUTO_RECOVER_THRESHOLD) — remote.prev=$remote_prev local=$local_mv"
    # `kind` is the suffix; _agent_sync_maybe_report_chain_rejection's
    # template prepends "chain_" on line 183 to build the error code
    # release.mjs's isChainDeadlockReport greps for. Passing
    # "chain_mismatch" here would produce `chain_chain_mismatch`, which
    # release.mjs does NOT recognise as a chain deadlock — it then
    # wrongly treats it as a generic install failure and auto-rolls back
    # the manifest, which is exactly what `shouldSkipRollback` in
    # release.mjs:678 exists to prevent (rolling back on chain mismatch
    # widens the API↔fleet divergence). Matches the `genesis_replay`
    # convention on line 221 (no prefix — template supplies it).
    _agent_sync_record_chain_rejection "$remote_mv" "$remote_prev" "$local_mv" "mismatch"
    _agent_sync_maybe_report_chain_rejection "$remote_mv" "$remote_prev" "$local_mv" "mismatch"
    return 1
  fi

  _agent_sync_clear_chain_rejection
  rm -f "$AGENT_SYNC_CHAIN_REPORT_THROTTLE_FILE" "$AGENT_SYNC_CHAIN_MISMATCH_COUNTER" 2>/dev/null || true
  return 0
}

decode_jws_body() {
  local jws="$1"
  [ -z "$jws" ] && return 1

  local body body_std
  body=$(echo "$jws" | cut -d. -f2)
  [ -z "$body" ] && return 1

  body_std="${body//-/+}"
  body_std="${body_std//_//}"
  case $(( ${#body_std} % 4 )) in
    2) body_std="${body_std}==" ;;
    3) body_std="${body_std}=" ;;
  esac

  printf '%s' "$body_std" | base64 -d 2>/dev/null
}

# ── Agent self-update helpers

# Read the currently-applied installed version for a component from
# /etc/ellul/shield-data/.agent-versions.json, defaulting to empty.
#
# Args: $1 = component name
# Returns: semver string on stdout (empty if not installed)
agent_installed_version() {
  local name="$1"
  [ -f "$AGENT_INSTALLED_FILE" ] || { echo ""; return 0; }
  jq -r --arg n "$name" '.[$n] // ""' "$AGENT_INSTALLED_FILE" 2>/dev/null
}

# Returns 0 (match) if the component version on disk matches the
# manifest AND the primary file's sha256 matches the manifest sha256.
# Returns 1 (drift) on any mismatch — triggers a re-install by the
# caller even if the semver string hasn't changed.
#
# This closes the "same version, new binary content" footgun: without
# it, a manifest that ships 0.1.4 with a new sha256 while the VPS also
# claims "0.1.4" would be silently skipped by the version-only check.
# With it, a sha256 divergence forces re-download and re-install on
# the next sync tick.
#
# Args: $1 = component name
#       $2 = wanted semver (from manifest entry)
#       $3 = wanted sha256 (from manifest entry)
#       $4 = format (bash | elf | tarball | nodejs-tarball)
# Returns: 0 match (skip), 1 drift (re-install needed)
agent_onDisk_matches() {
  local name="$1" wanted_ver="$2" wanted_sha="$3" format="$4"

  # Version must match first. An empty cur means never installed.
  local cur
  cur=$(agent_installed_version "$name")
  [ "$cur" = "$wanted_ver" ] || return 1

  # Pick the primary file whose sha256 we can spot-check. For tarball
  # components the manifest sha256 is of the archive, not any extracted
  # file — so we rely on the sidecar .agent-sha256 written at stage
  # time. Missing sidecar = drift = re-install.
  local dir="$AGENT_RELEASES_ROOT/$name/$wanted_ver"
  [ -d "$dir" ] || return 1

  case "$format" in
    bash)
      [ -f "$dir/$name" ] || return 1
      [ "$(sha256sum "$dir/$name" 2>/dev/null | awk '{print $1}')" = "$wanted_sha" ] || return 1
      ;;
    elf)
      [ -f "$dir/ellul-crypto" ] || return 1
      [ "$(sha256sum "$dir/ellul-crypto" 2>/dev/null | awk '{print $1}')" = "$wanted_sha" ] || return 1
      ;;
    tarball|nodejs-tarball)
      [ -f "$dir/.agent-sha256" ] || return 1
      [ "$(cat "$dir/.agent-sha256" 2>/dev/null)" = "$wanted_sha" ] || return 1
      ;;
    *)
      # Unknown format — treat as drift so the caller re-stages through
      # the format-aware stage_component logic.
      return 1
      ;;
  esac
  return 0
}

# Atomically update one component's installed version in
# /etc/ellul/shield-data/.agent-versions.json.
#
# Args: $1 = component name, $2 = semver
update_installed_version() {
  local name="$1"
  local ver="$2"
  local tmp
  tmp=$(mktemp /etc/ellul/shield-data/.agent-versions.XXXXXX 2>/dev/null) || return 1
  chmod 0600 "$tmp" 2>/dev/null
  chown root:root "$tmp" 2>/dev/null
  if [ -f "$AGENT_INSTALLED_FILE" ]; then
    jq --arg n "$name" --arg v "$ver" '. + {($n): $v}' "$AGENT_INSTALLED_FILE" > "$tmp" 2>/dev/null
  else
    jq -n --arg n "$name" --arg v "$ver" '{($n): $v}' > "$tmp" 2>/dev/null
  fi
  mv -f "$tmp" "$AGENT_INSTALLED_FILE"
}

# Ensure the /usr/local/bin/ellul-* symlink for a component points at
# /opt/ellul/releases/{name}/current/{file}. Handles both the bootstrap
# case (plain file at /usr/local/bin) and the already-symlinked case.
#
# Args: $1 = component name
ensure_bin_symlink() {
  local name="$1"
  local bin dst
  case "$name" in
    ellul-env)
      bin=/usr/local/bin/ellul-env
      dst=/opt/ellul/releases/ellul-env/current/ellul-env
      ;;
    ellul-mount-volume)
      bin=/usr/local/bin/ellul-mount-volume
      dst=/opt/ellul/releases/ellul-mount-volume/current/ellul-mount-volume
      ;;
    ellul-crypto)
      bin=/usr/local/bin/ellul-crypto
      dst=/opt/ellul/releases/ellul-crypto/current/ellul-crypto
      ;;
    core-runtime)
      # Grouped bundle: one release dir, multiple symlinks. Must match
      # CORE_RUNTIME_SUBCOMPONENTS in scripts/build-agent-bundles.mjs.
      # New subcomponents: add a line here AND a manifest entry in the
      # build script; the build will fail the release otherwise.
      #
      # watchdog is intentionally NOT in this list: its systemd unit
      # reads from /opt/ellul/src/services/daemons/watchdog/server.cjs
      # which is deployed at provisioning time, not via the manifest.
      # If you add watchdog to core-runtime in a future release, update
      # the systemd unit path at the same time.
      ln -sfn /opt/ellul/releases/core-runtime/current/file-api.js    /usr/local/bin/ellul-file-api.new     && mv -Tf /usr/local/bin/ellul-file-api.new    /usr/local/bin/ellul-file-api
      ln -sfn /opt/ellul/releases/core-runtime/current/agent-bridge.js /usr/local/bin/ellul-agent-bridge.new && mv -Tf /usr/local/bin/ellul-agent-bridge.new /usr/local/bin/ellul-agent-bridge
      ln -sfn /opt/ellul/releases/core-runtime/current/term-proxy.js  /usr/local/bin/ellul-term-proxy.new   && mv -Tf /usr/local/bin/ellul-term-proxy.new  /usr/local/bin/ellul-term-proxy
      # MCP stdio relay — shipped as a first-class core-runtime member
      # (not a heredoc inside ellul-env). The symlink target is
      # root-owned and read-only for dev, so a compromised agent can't
      # rewrite the relay binary it spawns.
      ln -sfn /opt/ellul/releases/core-runtime/current/mcp-relay.js   /usr/local/bin/ellul-mcp-relay.new    && mv -Tf /usr/local/bin/ellul-mcp-relay.new   /usr/local/bin/ellul-mcp-relay
      # sovereign-shield: NOT a /usr/local/bin entry — its systemd unit
      # ExecStart is `node /opt/ellul/auth/server.js`, so we install
      # the bundle file in place. We COPY (not symlink) because Node
      # resolves require() relative to the REAL path of the loaded
      # file, not the symlink path. A symlink at
      # /opt/ellul/auth/server.js → release-dir/sovereign-shield.js
      # would make `require('better-sqlite3')` walk up from the release
      # dir looking for node_modules/, which doesn't exist there — the
      # actual node_modules/ lives in /opt/ellul/auth/node_modules/
      # alongside the bundle. Symlinking broke shield startup with
      # MODULE_NOT_FOUND on every apply (manifest v27, 2026-04).
      #
      # Copy via cp + mv -Tf preserves the rest of the apply contract:
      # atomic rename, no half-baked file on power loss, and the
      # canonical bytes still live in the release dir so a rollback
      # (or a re-install) can re-copy from there. Agent_onDisk_matches
      # for core-runtime checks the .agent-sha256 sidecar in the
      # release dir, not the auth/ copy, so the cache short-circuit
      # still works correctly.
      #
      # NOTE: /opt/ellul/auth/ also contains node_modules/ and
      # package.json which are NOT manifest-managed (they're provisioned
      # at boot time and don't change between releases). Only server.js
      # rotates. If a future release needs to update node_modules too,
      # extend this entry to copy the whole `auth` directory and
      # ship node_modules in the tarball.
      if [ -e /opt/ellul/auth ] || mkdir -p /opt/ellul/auth 2>/dev/null; then
        if cp /opt/ellul/releases/core-runtime/current/sovereign-shield.js /opt/ellul/auth/server.js.new; then
          chmod 0644 /opt/ellul/auth/server.js.new
          chown root:root /opt/ellul/auth/server.js.new
          mv -Tf /opt/ellul/auth/server.js.new /opt/ellul/auth/server.js
        fi
      fi

      # ellul-agent-namespace: shell script, sudo-reachable, chattr +i
      # locked after provisioning. Updating it requires unlocking, replacing
      # in place (mv -Tf can't rename over an immutable file), then
      # re-locking. Skip if contents already match the bundle copy.
      local ns_src=/opt/ellul/releases/core-runtime/current/agent-namespace.sh
      local ns_dst=/usr/local/bin/ellul-agent-namespace
      if [ -f "$ns_src" ]; then
        if [ ! -f "$ns_dst" ] || ! cmp -s "$ns_src" "$ns_dst"; then
          chattr -i "$ns_dst" 2>/dev/null || true
          if cp "$ns_src" "$ns_dst.new"; then
            chmod 0755 "$ns_dst.new"
            chown root:root "$ns_dst.new"
            mv -Tf "$ns_dst.new" "$ns_dst"
          fi
          chattr +i "$ns_dst" 2>/dev/null || true
        fi
      fi

      # ellul-claude-ns / ellul-codex-ns: the per-CLI namespace wrappers
      # the Claude Agent SDK and any shell-triggered claude/codex
      # invocation route through. Lived only in payload.ts before; that
      # meant a wrapper fix (e.g. recognising the __host__ sentinel for
      # provider probes, or sourcing the binary path from $HOME instead
      # of a hard-coded /home/dev) needed a fleet re-provision. Shipped
      # via core-runtime now so fixes flow through the manifest pipeline.
      # Same unlock → cp → relock pattern as agent-namespace above.
      local cn_src=/opt/ellul/releases/core-runtime/current/claude-ns.sh
      local cn_dst=/usr/local/bin/ellul-claude-ns
      if [ -f "$cn_src" ]; then
        if [ ! -f "$cn_dst" ] || ! cmp -s "$cn_src" "$cn_dst"; then
          chattr -i "$cn_dst" 2>/dev/null || true
          if cp "$cn_src" "$cn_dst.new"; then
            chmod 0755 "$cn_dst.new"
            chown root:root "$cn_dst.new"
            mv -Tf "$cn_dst.new" "$cn_dst"
          fi
          chattr +i "$cn_dst" 2>/dev/null || true
        fi
      fi
      local cx_src=/opt/ellul/releases/core-runtime/current/codex-ns.sh
      local cx_dst=/usr/local/bin/ellul-codex-ns
      if [ -f "$cx_src" ]; then
        if [ ! -f "$cx_dst" ] || ! cmp -s "$cx_src" "$cx_dst"; then
          chattr -i "$cx_dst" 2>/dev/null || true
          if cp "$cx_src" "$cx_dst.new"; then
            chmod 0755 "$cx_dst.new"
            chown root:root "$cx_dst.new"
            mv -Tf "$cx_dst.new" "$cx_dst"
          fi
          chattr +i "$cx_dst" 2>/dev/null || true
        fi
      fi

      # ellul-spawn-scope: validating wrapper around `systemd-run --scope`.
      # The bridge calls this for every adapter pool spawn AND every
      # host-mode probe spawn (resource-v2 Phase A/B). When the bridge
      # ships a new unit-name regex (e.g. adding `ellul-probe-` for probes)
      # but this script on disk is stale, every probe fails with
      # `invalid unit` and providers surface as "not ready" in chat.
      # Same unlock → cp → relock pattern as agent-namespace.
      local ss_src=/opt/ellul/releases/core-runtime/current/spawn-scope.sh
      local ss_dst=/usr/local/bin/ellul-spawn-scope
      if [ -f "$ss_src" ]; then
        if [ ! -f "$ss_dst" ] || ! cmp -s "$ss_src" "$ss_dst"; then
          chattr -i "$ss_dst" 2>/dev/null || true
          if cp "$ss_src" "$ss_dst.new"; then
            chmod 0755 "$ss_dst.new"
            chown root:root "$ss_dst.new"
            mv -Tf "$ss_dst.new" "$ss_dst"
          fi
          chattr +i "$ss_dst" 2>/dev/null || true
        fi
      fi

      # ellul-claude-launch — greenfield Claude OAT credential subsystem.
      # Bridge spawns this binary instead of holding the OAT itself; the
      # launcher exchanges a single-use issuance token for the actual OAT
      # via shield's /api/internal/claude-oat/redeem and execve's into the
      # ellul-claude-ns wrapper with CLAUDE_CODE_OAUTH_TOKEN injected. The
      # OAT never lives in bridge's heap, in env files, or in
      # ~/.claude.json:primaryApiKey. CI lint forbids regression.
      # cp (not symlink) so the launcher binary is content-addressed and
      # survives core-runtime hot updates the same way ellul-claude-ns does.
      local cl_src=/opt/ellul/releases/core-runtime/current/claude-launcher.js
      local cl_dst=/usr/local/bin/ellul-claude-launch
      if [ -f "$cl_src" ]; then
        if [ ! -f "$cl_dst" ] || ! cmp -s "$cl_src" "$cl_dst"; then
          chattr -i "$cl_dst" 2>/dev/null || true
          if cp "$cl_src" "$cl_dst.new"; then
            chmod 0755 "$cl_dst.new"
            chown root:root "$cl_dst.new"
            mv -Tf "$cl_dst.new" "$cl_dst"
          fi
          chattr +i "$cl_dst" 2>/dev/null || true
        fi
      fi

      # ellul-ns-mount: C source compiled on each apply. Source file is
      # shipped via core-runtime so dotfile-bind / overlay fixes flow with
      # the manifest pipeline instead of requiring a re-provision.
      # Compile flags match payload.ts (-static so the binary works
      # across glibc versions). Content-addressed via SHA of the source
      # to skip recompiles when nothing changed. If gcc is missing we
      # leave the existing binary in place — fail-soft so an unexpectedly
      # stripped image doesn't brick the namespace anchor on next apply.
      local nsm_src=/opt/ellul/releases/core-runtime/current/ns-mount.c
      local nsm_dst=/usr/local/bin/ellul-ns-mount
      local nsm_sha_marker=/var/lib/ellul/ns-mount.src.sha256
      if [ -f "$nsm_src" ] && command -v gcc >/dev/null 2>&1; then
        local nsm_sha
        nsm_sha=$(sha256sum "$nsm_src" 2>/dev/null | cut -d' ' -f1)
        local nsm_prev=""
        [ -f "$nsm_sha_marker" ] && nsm_prev=$(cat "$nsm_sha_marker" 2>/dev/null || true)
        if [ -n "$nsm_sha" ] && [ "$nsm_sha" != "$nsm_prev" ]; then
          mkdir -p "$(dirname "$nsm_sha_marker")"
          if gcc -static -Wall -O2 -fstack-protector-strong -D_FORTIFY_SOURCE=2 \
                 -Wl,-z,relro,-z,now -o "$nsm_dst.new" "$nsm_src" 2>/dev/null; then
            chmod 0755 "$nsm_dst.new"
            chown root:root "$nsm_dst.new"
            chattr -i "$nsm_dst" 2>/dev/null || true
            mv -Tf "$nsm_dst.new" "$nsm_dst"
            chattr +i "$nsm_dst" 2>/dev/null || true
            printf '%s\n' "$nsm_sha" > "$nsm_sha_marker"
          else
            rm -f "$nsm_dst.new" 2>/dev/null || true
          fi
        fi
      fi

      # bwrap AppArmor profile. Required on Ubuntu 24.04+ where
      # apparmor_restrict_unprivileged_userns=1 is the default — without
      # this profile, codex / claude-code / opencode internal sandboxes
      # fail "setting up uid map: Permission denied" inside the agent
      # namespace and the App Server traps out (SIGTRAP / exit 133).
      # See packages/vps/src/scripts/security/bwrap-apparmor.ts for the
      # rationale and the policy. Reload via apparmor_parser -r so the
      # kernel picks it up on the same apply that drops the file in
      # place; subsequent applies short-circuit on cmp.
      local aa_src=/opt/ellul/releases/core-runtime/current/bwrap.aa
      local aa_dst=/etc/apparmor.d/bwrap
      if [ -f "$aa_src" ] && command -v apparmor_parser >/dev/null 2>&1; then
        if [ ! -f "$aa_dst" ] || ! cmp -s "$aa_src" "$aa_dst"; then
          if cp "$aa_src" "$aa_dst.new"; then
            chmod 0644 "$aa_dst.new"
            chown root:root "$aa_dst.new"
            mv -Tf "$aa_dst.new" "$aa_dst"
            apparmor_parser -r "$aa_dst" 2>/dev/null || apparmor_parser "$aa_dst" 2>/dev/null || true
          fi
        fi
      fi

      # ellul-namespaces.slice — anchors for per-project namespaces live
      # here, decoupled from agent-bridge's lifecycle so bridge restarts
      # don't kill warm namespaces. Install + daemon-reload on first apply
      # (when content changes); subsequent applies short-circuit on cmp.
      local slice_src=/opt/ellul/releases/core-runtime/current/ellul-namespaces.slice
      local slice_dst=/etc/systemd/system/ellul-namespaces.slice
      if [ -f "$slice_src" ]; then
        if [ ! -f "$slice_dst" ] || ! cmp -s "$slice_src" "$slice_dst"; then
          if cp "$slice_src" "$slice_dst.new"; then
            chmod 0644 "$slice_dst.new"
            chown root:root "$slice_dst.new"
            mv -Tf "$slice_dst.new" "$slice_dst"
            systemctl daemon-reload 2>/dev/null || true
          fi
        fi
      fi

      # shield-ssh-key-mgr: sudo wrapper sovereign-shield uses to write
      # /etc/ssh/authorized_keys/<svc-user>. Same install pattern as
      # agent-namespace above (sudo-reachable, chattr +i, replace in place
      # via unlock → cp → relock). Without it, every POST /_auth/keys
      # 500s because shield can't write the file directly.
      local sk_src=/opt/ellul/releases/core-runtime/current/shield-ssh-key-mgr.sh
      local sk_dst=/usr/local/bin/shield-ssh-key-mgr
      if [ -f "$sk_src" ]; then
        if [ ! -f "$sk_dst" ] || ! cmp -s "$sk_src" "$sk_dst"; then
          chattr -i "$sk_dst" 2>/dev/null || true
          if cp "$sk_src" "$sk_dst.new"; then
            chmod 0755 "$sk_dst.new"
            chown root:root "$sk_dst.new"
            mv -Tf "$sk_dst.new" "$sk_dst"
          fi
          chattr +i "$sk_dst" 2>/dev/null || true
        fi
        # Reconcile the sudoers entry — older provisioning runs (pre-fix)
        # never wrote it, so the wrapper would be unreachable.
        local sudoers=/etc/sudoers.d/shield-runner
        if [ -f "$sudoers" ] && ! grep -q '/usr/local/bin/shield-ssh-key-mgr' "$sudoers" 2>/dev/null; then
          {
            printf '\n# SSH key management: shield writes/reads authorized_keys via root wrapper\n'
            printf 'shield-runner ALL=(root) NOPASSWD: /usr/local/bin/shield-ssh-key-mgr\n'
          } >> "$sudoers"
          chmod 440 "$sudoers"
          chown root:root "$sudoers"
          if ! visudo -cf "$sudoers" >/dev/null 2>&1; then
            log "agent-sync: shield-runner sudoers update failed visudo check — reverting"
            sed -i '/shield-ssh-key-mgr/d' "$sudoers"
          fi
        fi
      fi

      # ellul-ssh-authorized-keys: sshd helper with the two-tier
      # primary→fallback lookup. Shipping via core-runtime so logic
      # changes (e.g. the fallback path itself) reach existing fleet
      # without re-provisioning. Same unlock → cp → relock pattern as
      # the other privileged wrappers above.
      local ah_src=/opt/ellul/releases/core-runtime/current/ellul-ssh-authorized-keys
      local ah_dst=/usr/local/bin/ellul-ssh-authorized-keys
      if [ -f "$ah_src" ]; then
        if [ ! -f "$ah_dst" ] || ! cmp -s "$ah_src" "$ah_dst"; then
          chattr -i "$ah_dst" 2>/dev/null || true
          if cp "$ah_src" "$ah_dst.new"; then
            chmod 0700 "$ah_dst.new"
            chown root:root "$ah_dst.new"
            mv -Tf "$ah_dst.new" "$ah_dst"
          fi
          chattr +i "$ah_dst" 2>/dev/null || true
        fi
      fi

      # SSH authorized_keys boot-partition fallback. The primary path
      # (/etc/ssh/authorized_keys/<user>) is a vault bind mount; if the
      # vault overlay activates over an empty source the user is locked
      # out of their own server (the failure mode that bricked
      # 5.161.112.213 on 2026-04-25). The fallback at
      # /etc/ellul-bootstrap/authorized_keys/ lives on the unencrypted
      # root FS and is read by ellul-ssh-authorized-keys when the primary
      # is empty. This sync block keeps fallback ↔ primary in lockstep on
      # every enforcer pass, so:
      #   1. existing fleet hosts get the fallback seeded from their
      #      working primary on the first apply post-deploy
      #   2. any future drift (manual touch, partial vault restore) is
      #      reconciled within one heartbeat
      #   3. if the primary is mysteriously empty, the fallback is
      #      preserved (we never overwrite a populated fallback with an
      #      empty primary — that would defeat the whole point)
      local fb_dir=/etc/ellul-bootstrap/authorized_keys
      mkdir -p "$fb_dir"
      chown root:shield "$fb_dir" 2>/dev/null || true
      chmod 0770 "$fb_dir"
      local _svc_user="${PS_USER:-dev}"
      local pri_file="/etc/ssh/authorized_keys/$_svc_user"
      local fb_file="$fb_dir/$_svc_user"
      if [ -s "$pri_file" ]; then
        if [ ! -f "$fb_file" ] || ! cmp -s "$pri_file" "$fb_file"; then
          chattr -i "$fb_file" 2>/dev/null || true
          if install -m 0600 -o root -g root "$pri_file" "$fb_file.new"; then
            mv -Tf "$fb_file.new" "$fb_file"
            chattr +i "$fb_file" 2>/dev/null || true
            log "agent-sync: ssh-keys fallback resynced from primary user=$_svc_user"
          fi
        fi
      elif [ -s "$fb_file" ]; then
        log "agent-sync: ssh-keys primary EMPTY but fallback populated user=$_svc_user — vault overlay may be corrupt; SSH still works via fallback"
      fi

      # ellul-preview-ctl: sudo wrapper for preview systemd lifecycle.
      # Same unlock → cp → relock pattern as the two above. file-api's
      # admission code calls actions (`kill` for pressure evictions,
      # `dropin` / `clear-dropin` for framework-aware cgroup sizing)
      # that the provisioning-time copy of the wrapper doesn't know
      # about; shipping it via core-runtime keeps the action list in
      # lockstep with the file-api release that calls them.
      local pc_src=/opt/ellul/releases/core-runtime/current/preview-ctl.sh
      local pc_dst=/usr/local/bin/ellul-preview-ctl
      if [ -f "$pc_src" ]; then
        if [ ! -f "$pc_dst" ] || ! cmp -s "$pc_src" "$pc_dst"; then
          chattr -i "$pc_dst" 2>/dev/null || true
          if cp "$pc_src" "$pc_dst.new"; then
            chmod 0755 "$pc_dst.new"
            chown root:root "$pc_dst.new"
            mv -Tf "$pc_dst.new" "$pc_dst"
          fi
          chattr +i "$pc_dst" 2>/dev/null || true
        fi
      fi

      # ellul-preview-instance: systemd ExecStart target for every
      # per-preview unit. The launcher reads spec.mode (hot/warm) and
      # execs either devCommand or prodCommand; the provisioning-time
      # copy predates that mode field so warm-mode admission ends up
      # running the dev command anyway. Lockstep via core-runtime.
      local pi_src=/opt/ellul/releases/core-runtime/current/preview-instance.sh
      local pi_dst=/usr/local/bin/ellul-preview-instance
      if [ -f "$pi_src" ]; then
        if [ ! -f "$pi_dst" ] || ! cmp -s "$pi_src" "$pi_dst"; then
          chattr -i "$pi_dst" 2>/dev/null || true
          if cp "$pi_src" "$pi_dst.new"; then
            chmod 0755 "$pi_dst.new"
            chown root:root "$pi_dst.new"
            mv -Tf "$pi_dst.new" "$pi_dst"
          fi
          chattr +i "$pi_dst" 2>/dev/null || true
        fi
      fi

      # /usr/local/bin/opencode: TMPDIR-isolation wrapper for the real
      # bun-compiled opencode binary at /usr/local/libexec/ellul/opencode.
      # Lived only in payload.ts (provisioning-time) before, so any
      # wrapper fix required re-provisioning — brittle for bun runtime
      # quirks that only surface at opencode-serve startup. Shipping it
      # as a core-runtime member means wrapper fixes flow via the
      # manifest pipeline. Same unlock → cp → relock as the siblings
      # above. agent-bridge restarts on core-runtime apply (restartUnit
      # below), which causes namespace-lifecycle to respawn opencode
      # serve inside every sandbox through the freshly-installed wrapper
      # — no per-sandbox intervention needed for the new env to land.
      local oc_src=/opt/ellul/releases/core-runtime/current/opencode-exec.sh
      local oc_dst=/usr/local/bin/opencode
      if [ -f "$oc_src" ]; then
        if [ ! -f "$oc_dst" ] || ! cmp -s "$oc_src" "$oc_dst"; then
          chattr -i "$oc_dst" 2>/dev/null || true
          if cp "$oc_src" "$oc_dst.new"; then
            chmod 0755 "$oc_dst.new"
            chown root:root "$oc_dst.new"
            mv -Tf "$oc_dst.new" "$oc_dst"
          fi
          chattr +i "$oc_dst" 2>/dev/null || true
        fi
      fi

      # ellul-update-binary: privileged binary updater. Was provisioning-only —
      # __OPENCODE_VERSION__ baked from BINARY_VERSIONS.opencode at cloud-init,
      # so version pin bumps required re-provisioning. Shipped as a core-runtime
      # member to flow version bumps via the manifest pipeline. Same
      # chattr unlock → cp → relock pattern as siblings above.
      local ub_src=/opt/ellul/releases/core-runtime/current/ellul-update-binary
      local ub_dst=/usr/local/bin/ellul-update-binary
      if [ -f "$ub_src" ]; then
        if [ ! -f "$ub_dst" ] || ! cmp -s "$ub_src" "$ub_dst"; then
          chattr -i "$ub_dst" 2>/dev/null || true
          if cp "$ub_src" "$ub_dst.new"; then
            chmod 0755 "$ub_dst.new"
            chown root:root "$ub_dst.new"
            mv -Tf "$ub_dst.new" "$ub_dst"
          fi
          chattr +i "$ub_dst" 2>/dev/null || true
        fi
      fi

      # ellul-install-runtime: on-demand runtime installer. Was
      # provisioning-only — pinned versions and validation logic baked at
      # cloud-init. The `file` command dependency for Go tarball validation
      # doesn't exist on the VPS (broke every Go scaffold). Shipping via
      # core-runtime lets version bumps AND bug fixes land via manifest.
      # Same unlock → cp → relock as siblings above.
      local ri_src=/opt/ellul/releases/core-runtime/current/ellul-install-runtime.sh
      local ri_dst=/usr/local/bin/ellul-install-runtime
      if [ -f "$ri_src" ]; then
        if [ ! -f "$ri_dst" ] || ! cmp -s "$ri_src" "$ri_dst"; then
          chattr -i "$ri_dst" 2>/dev/null || true
          if cp "$ri_src" "$ri_dst.new"; then
            chmod 0755 "$ri_dst.new"
            chown root:root "$ri_dst.new"
            mv -Tf "$ri_dst.new" "$ri_dst"
          fi
          chattr +i "$ri_dst" 2>/dev/null || true
        fi
        # Reconcile sudoers — older provisioning runs wrote the entry
        # without the trailing `*` wildcard (so `sudo ... go` was denied).
        local ri_sudoers=/etc/sudoers.d/ellul-runtime
        local ri_svc="${PS_USER:-dev}"
        local ri_expected="$ri_svc ALL=(root) NOPASSWD: /usr/local/bin/ellul-install-runtime *"
        if [ ! -f "$ri_sudoers" ] || ! grep -qF "$ri_expected" "$ri_sudoers" 2>/dev/null; then
          printf '%s\n' "$ri_expected" > "$ri_sudoers.new"
          chmod 440 "$ri_sudoers.new"
          chown root:root "$ri_sudoers.new"
          if visudo -cf "$ri_sudoers.new" >/dev/null 2>&1; then
            mv -Tf "$ri_sudoers.new" "$ri_sudoers"
          else
            log "agent-sync: ellul-runtime sudoers failed visudo check — skipping"
            rm -f "$ri_sudoers.new"
          fi
        fi
      fi

      # ellul-ctx: AI context generator (CLAUDE.md / AGENTS.md). Was
      # provisioning-only, so context template changes (e.g.
      # cross-project .shared/ detection) required a full re-provision.
      # No chattr — the script is not security-sensitive.
      local ctx_src=/opt/ellul/releases/core-runtime/current/ellul-ctx.sh
      local ctx_dst=/usr/local/bin/ellul-ctx
      if [ -f "$ctx_src" ]; then
        if [ ! -f "$ctx_dst" ] || ! cmp -s "$ctx_src" "$ctx_dst"; then
          if cp "$ctx_src" "$ctx_dst.new"; then
            chmod 0755 "$ctx_dst.new"
            chown root:root "$ctx_dst.new"
            mv -Tf "$ctx_dst.new" "$ctx_dst"
          fi
        fi
      fi

      # ellul-gbrain-init: first-time gbrain bootstrap (postgres DB,
      # credentials, access token). Runs as root via sudo from the bridge.
      # No chattr — not security-sensitive (creates DB resources, doesn't
      # grant new capabilities). Reconcile sudoers so existing VPSes get
      # the entry without re-provisioning.
      local gi_src=/opt/ellul/releases/core-runtime/current/ellul-gbrain-init
      local gi_dst=/usr/local/bin/ellul-gbrain-init
      if [ -f "$gi_src" ]; then
        if [ ! -f "$gi_dst" ] || ! cmp -s "$gi_src" "$gi_dst"; then
          if cp "$gi_src" "$gi_dst.new"; then
            chmod 0755 "$gi_dst.new"
            chown root:root "$gi_dst.new"
            mv -Tf "$gi_dst.new" "$gi_dst"
          fi
        fi
        # Reconcile sudoers entry for existing VPSes
        local gi_svc
        gi_svc=$(stat -c '%U' /home/dev 2>/dev/null || echo "dev")
        local gi_sudoers=/etc/sudoers.d/dev-packages
        if [ -f "$gi_sudoers" ] && ! grep -q 'ellul-gbrain-init' "$gi_sudoers" 2>/dev/null; then
          chattr -i "$gi_sudoers" 2>/dev/null || true
          printf '%s ALL=(root) NOPASSWD: /usr/local/bin/ellul-gbrain-init\n' "$gi_svc" >> "$gi_sudoers"
          chattr +i "$gi_sudoers" 2>/dev/null || true
        fi
      fi

      # git-credential-ellul: sovereign credential helper with gate flow.
      # Ships alongside bridge + shield so the credential helper's
      # git-exec-authorize call always targets the matching endpoint.
      local gc_src=/opt/ellul/releases/core-runtime/current/git-credential-helper.sh
      local gc_dst=/usr/local/bin/git-credential-ellul
      if [ -f "$gc_src" ]; then
        if [ ! -f "$gc_dst" ] || ! cmp -s "$gc_src" "$gc_dst"; then
          if cp "$gc_src" "$gc_dst.new"; then
            chmod 0755 "$gc_dst.new"
            chown root:root "$gc_dst.new"
            mv -Tf "$gc_dst.new" "$gc_dst"
          fi
        fi
      fi

      # pre-push hook: defense-in-depth gate check. Installed to the
      # user's hooks dir (core.hooksPath in .gitconfig). Owned by the
      # service user so git can execute it.
      local ph_src=/opt/ellul/releases/core-runtime/current/pre-push-hook.sh
      local ph_svc="${PS_USER:-dev}"
      local ph_home="/home/$ph_svc"
      local ph_dst="$ph_home/.ellul/hooks/pre-push"
      if [ -f "$ph_src" ]; then
        mkdir -p "$ph_home/.ellul/hooks"
        chown "$ph_svc:$ph_svc" "$ph_home/.ellul" "$ph_home/.ellul/hooks" 2>/dev/null || true
        if [ ! -f "$ph_dst" ] || ! cmp -s "$ph_src" "$ph_dst"; then
          if cp "$ph_src" "$ph_dst.new"; then
            chmod 0755 "$ph_dst.new"
            chown "$ph_svc:$ph_svc" "$ph_dst.new"
            mv -Tf "$ph_dst.new" "$ph_dst"
          fi
        fi
      fi
      return 0
      ;;
    ellul-namespaced)
      # Multi-arch tarball: amd64/{ellul-namespaced,ellul-fd-pass}
      # and arm64/{ellul-namespaced,ellul-fd-pass}. Pick the matching
      # arch via dpkg, point /usr/local/bin/* at it via symlink. Both
      # binaries flip atomically.
      local nsd_arch
      nsd_arch=$(dpkg --print-architecture 2>/dev/null || echo amd64)
      local nsd_release_dir="/opt/ellul/releases/ellul-namespaced/current/$nsd_arch"
      if [ ! -f "$nsd_release_dir/ellul-namespaced" ] || [ ! -f "$nsd_release_dir/ellul-fd-pass" ]; then
        log "agent-sync: ellul-namespaced bundle missing $nsd_arch binaries at $nsd_release_dir — refusing to flip symlinks"
        return 1
      fi
      chmod 0755 "$nsd_release_dir/ellul-namespaced" "$nsd_release_dir/ellul-fd-pass" 2>/dev/null || true
      # Self-test the new binary BEFORE flipping the live symlink. If it
      # crashes on --version (toolchain regression, missing dynamic dep,
      # ABI break), keep the old binary in place — fail-soft so a bad
      # release doesn't tear down running daemons.
      if ! "$nsd_release_dir/ellul-namespaced" --version >/dev/null 2>&1; then
        log "agent-sync: ellul-namespaced --version self-test failed — refusing to flip symlinks"
        return 1
      fi
      ln -sfn "$nsd_release_dir/ellul-namespaced" /usr/local/bin/ellul-namespaced.new \
        && mv -Tf /usr/local/bin/ellul-namespaced.new /usr/local/bin/ellul-namespaced
      ln -sfn "$nsd_release_dir/ellul-fd-pass" /usr/local/bin/ellul-fd-pass.new \
        && mv -Tf /usr/local/bin/ellul-fd-pass.new /usr/local/bin/ellul-fd-pass
      # Write the nsd-enabled feature flag now that a verified binary
      # is staged. Invariant: flag presence ⟹ binary on disk + daemon
      # expected up. Provisioning (ellul-namespaced.sh) intentionally
      # leaves the flag unwritten on fresh boxes; this is the canonical
      # write path. Bridge ExecStartPre keys off the same flag, so this
      # write unblocks bridge startup. The framework restart driven by
      # the manifest entry's restartUnit field starts the daemon
      # immediately after this returns.
      local nsd_flag=/etc/ellul/feature-flags/nsd-enabled
      if [ ! -e "$nsd_flag" ] || [ "$(head -c 1 "$nsd_flag" 2>/dev/null)" != "1" ]; then
        install -d -m 0755 -o root -g root /etc/ellul/feature-flags 2>/dev/null || true
        printf '1' > "$nsd_flag.tmp" 2>/dev/null \
          && chown root:root "$nsd_flag.tmp" 2>/dev/null \
          && chmod 0644 "$nsd_flag.tmp" 2>/dev/null \
          && mv -f "$nsd_flag.tmp" "$nsd_flag" 2>/dev/null \
          && log "agent-sync: nsd-enabled flag written (binary staged at $nsd_release_dir)"
      fi
      return 0
      ;;
    ide)
      bin=/usr/local/bin/ellul-ide
      dst=/opt/ellul/releases/ide/current/ellul-ide
      ;;
    *)
      return 0
      ;;
  esac
  if [ -L "$bin" ] && [ "$(readlink "$bin" 2>/dev/null)" = "$dst" ]; then
    return 0
  fi
  ln -sfn "$dst" "$bin.new" && mv -Tf "$bin.new" "$bin"
}

# Crash-safety reconciliation pass. If a previous sync flipped a symlink
# but didn't write .agent-versions.json (process died mid-apply), the
# on-disk symlink disagrees with the JSON. The JSON is authoritative
# (written LAST in a successful apply), so we revert the symlink to match.
reconcile_releases_vs_state() {
  [ -f "$AGENT_INSTALLED_FILE" ] || return 0
  [ -d "$AGENT_RELEASES_ROOT" ] || return 0
  local dir name ver link
  for dir in "$AGENT_RELEASES_ROOT"/*/; do
    [ -d "$dir" ] || continue
    name=$(basename "$dir")
    link=$(readlink "$dir/current" 2>/dev/null) || continue
    ver=$(agent_installed_version "$name")
    [ -z "$ver" ] && continue
    if [ "$link" != "$ver" ] && [ -d "$dir/$ver" ]; then
      log "agent-sync: reconcile $name symlink=$link vs state=$ver → reverting"
      ln -sfn "$ver" "$dir/current.new" && mv -Tf "$dir/current.new" "$dir/current"
      ensure_bin_symlink "$name"
    fi
  done

  self_heal_namespaced
}

# Self-heal namespaced binary perms + symlinks + failed-state recovery.
# Runs on every sync_agent_bundle tick (not just on new-manifest path)
# so hosts left in a broken state by the chmod-strip bug recover even
# without a new manifest. Idempotent — does nothing once the unit is up.
# Write embedded ellul-namespaced tier manifest material (signed by the
# operator key, base64-embedded into this script at build time) into the
# paths the daemon's startup gate expects. Idempotent — only writes when
# missing or content differs. The trust root for these files is the same
# PLATFORM_SIGNING_PRIVATE_KEY that signs this bash script.
bootstrap_nsd_manifest_files() {
  [ -n "${ELLUL_NSD_MANIFEST_PUB_B64:-}" ] || return 0
  install -d -m 0755 -o root -g root /etc/ellul/manifests /opt/ellul/manifests 2>/dev/null

  _nsd_write_b64() {
    local target="$1" b64="$2" mode="$3"
    [ -n "$b64" ] || return 0
    local tmp="$target.tmp"
    if ! printf '%s' "$b64" | base64 -d > "$tmp" 2>/dev/null; then
      rm -f "$tmp"
      log "agent-sync: bootstrap-nsd: base64 decode failed for $target"
      return 1
    fi
    if [ -f "$target" ] && cmp -s "$tmp" "$target"; then
      rm -f "$tmp"
      return 0
    fi
    chown root:root "$tmp"
    chmod "$mode" "$tmp"
    mv -f "$tmp" "$target"
    log "agent-sync: bootstrap-nsd: wrote $target"
  }

  _nsd_write_b64 /etc/ellul/manifests/manifest.pub "$ELLUL_NSD_MANIFEST_PUB_B64" 0644
  _nsd_write_b64 /opt/ellul/manifests/free.cbor    "$ELLUL_NSD_FREE_CBOR_B64"    0644
  _nsd_write_b64 /opt/ellul/manifests/paid.cbor    "$ELLUL_NSD_PAID_CBOR_B64"    0644

  if [ -n "${ELLUL_NSD_MANIFEST_PUB_NEXT_B64:-}" ]; then
    _nsd_write_b64 /etc/ellul/manifests/manifest-next.pub "$ELLUL_NSD_MANIFEST_PUB_NEXT_B64" 0644
  else
    rm -f /etc/ellul/manifests/manifest-next.pub 2>/dev/null
  fi
}

# Compare the deployed opencode binary version against the
# build-time-pinned EXPECTED_OPENCODE_VERSION. On drift, run
# ellul-update-binary to download the matching binary. Drift between
# server and the @opencode-ai/sdk in agent-bridge causes session.create
# to return empty payloads — fix at the source by keeping versions
# locked together.
self_heal_opencode_binary_version() {
  [ -n "${EXPECTED_OPENCODE_VERSION:-}" ] || return 0
  local target=/usr/local/libexec/ellul/opencode
  [ -x "$target" ] || return 0

  # Cache: skip `opencode --version` when binary hasn't changed.
  # The binary embeds V8 — each invocation leaks a ~4.5MB JIT .so in /tmp.
  local cache_file=/run/ellul-opencode-ver-cache
  local bin_mtime current
  bin_mtime=$(stat -c '%Y' "$target" 2>/dev/null || echo 0)
  if [ -f "$cache_file" ]; then
    local cached_mtime cached_ver
    read -r cached_mtime cached_ver < "$cache_file" 2>/dev/null || true
    if [ "$cached_mtime" = "$bin_mtime" ] && [ -n "$cached_ver" ]; then
      current="$cached_ver"
    fi
  fi
  if [ -z "${current:-}" ]; then
    local probe_tmp=/tmp/ellul-probe-cache
    mkdir -p "$probe_tmp" 2>/dev/null || true
    current=$(TMPDIR="$probe_tmp" NODE_OPTIONS="--jitless" "$target" --version 2>/dev/null | head -1 | tr -d '[:space:]')
    [ -n "$current" ] && echo "$bin_mtime $current" > "$cache_file"
  fi
  [ -n "$current" ] || return 0
  [ "$current" = "$EXPECTED_OPENCODE_VERSION" ] && return 0

  # Throttle: only attempt every $OPENCODE_VERSION_HEAL_THROTTLE_SEC.
  local throttle_file=/run/ellul-opencode-heal-throttle
  local now
  now=$(date +%s)
  if [ -f "$throttle_file" ]; then
    local last
    last=$(cat "$throttle_file" 2>/dev/null || echo 0)
    if [ "$((now - last))" -lt 300 ]; then
      return 0
    fi
  fi
  echo "$now" > "$throttle_file"

  log "agent-sync: opencode binary $current != expected $EXPECTED_OPENCODE_VERSION — running ellul-update-binary"
  if /usr/local/bin/ellul-update-binary opencode >/dev/null 2>&1; then
    rm -f /run/ellul-opencode-ver-cache 2>/dev/null || true
    log "agent-sync: opencode upgraded to $EXPECTED_OPENCODE_VERSION"
    # Existing per-project opencode-serve processes still run the old
    # binary. Force the bridge to drop them so the next spawn picks up
    # the new version. The bridge will re-spawn lazily on next chat turn.
    pkill -f 'opencode serve' 2>/dev/null || true
  else
    log "agent-sync: ellul-update-binary opencode FAILED — will retry after throttle"
  fi
}

self_heal_cursor_agent_binary() {
  [ -n "${EXPECTED_CURSOR_VERSION:-}" ] || return 0
  local target=/usr/local/bin/cursor-agent

  if [ ! -x "$target" ]; then
    local throttle_file=/run/ellul-cursor-heal-throttle
    local now
    now=$(date +%s)
    if [ -f "$throttle_file" ]; then
      local last
      last=$(cat "$throttle_file" 2>/dev/null || echo 0)
      if [ "$((now - last))" -lt 300 ]; then
        return 0
      fi
    fi
    echo "$now" > "$throttle_file"

    log "agent-sync: cursor-agent binary missing — running ellul-update-binary"
    if /usr/local/bin/ellul-update-binary cursor-agent >/dev/null 2>&1; then
      log "agent-sync: cursor-agent installed"
    else
      log "agent-sync: ellul-update-binary cursor-agent FAILED — will retry after throttle"
    fi
  fi
}

self_heal_namespaced() {
  [ -d "$AGENT_RELEASES_ROOT/ellul-namespaced/current" ] || return 0

  # Feature flag invariant: presence ⟹ binary is on disk and verified.
  # Bridge ExecStartPre keys off this flag — if it's set without a
  # binary, bridge will refuse to start until the daemon socket binds.
  # Heartbeat self-heal cases:
  #   - flag exists with wrong content (legacy `: > flag` empty-file
  #     pattern that the binary treats as absent) → rewrite '1'
  #   - flag missing while symlinks are healthy → write '1' (covers
  #     boxes provisioned before the binary-conditional flag fix)
  local flag=/etc/ellul/feature-flags/nsd-enabled
  local symlinks_ok=0
  if [ -L /usr/local/bin/ellul-namespaced ] && [ -L /usr/local/bin/ellul-fd-pass ]; then
    symlinks_ok=1
  fi
  if [ -f "$flag" ] && [ "$(head -c 1 "$flag" 2>/dev/null)" != "1" ]; then
    log "agent-sync: nsd-enabled flag empty/wrong — writing '1'"
    printf '1' > "$flag.tmp" 2>/dev/null && mv -f "$flag.tmp" "$flag" 2>/dev/null
    chmod 0644 "$flag" 2>/dev/null
  elif [ ! -e "$flag" ] && [ "$symlinks_ok" = "1" ]; then
    log "agent-sync: nsd-enabled flag missing but binary symlinks healthy — writing '1'"
    install -d -m 0755 -o root -g root /etc/ellul/feature-flags 2>/dev/null || true
    printf '1' > "$flag.tmp" 2>/dev/null && mv -f "$flag.tmp" "$flag" 2>/dev/null
    chmod 0644 "$flag" 2>/dev/null
  fi

  bootstrap_nsd_manifest_files

  if [ "$symlinks_ok" != "1" ]; then
    log "agent-sync: ellul-namespaced symlinks missing — self-heal pass"
    if ensure_bin_symlink "ellul-namespaced"; then
      update_installed_version "ellul-namespaced" "$(readlink "$AGENT_RELEASES_ROOT/ellul-namespaced/current" 2>/dev/null)"
    fi
  fi

  # Ensure ip_set kernel module is loaded. The daemon's unit has
  # ProtectKernelModules=true, which blocks auto-load when iptables-restore
  # touches an ipset extension; the resulting "Can't open socket to ipset"
  # error fails every namespace setup. Modprobe is idempotent.
  if [ ! -d /sys/module/ip_set ]; then
    modprobe ip_set 2>/dev/null && \
      log "agent-sync: loaded ip_set kernel module for daemon namespace setup"
  fi

  # Drop-in: align hardening with what bundle.ts ships for new provisions.
  # Existing fleet may have provisioned with restrictive defaults that block
  # the daemon's actual job. Each entry below corresponds to a real fix:
  #
  #   CAP_SYS_CHROOT  — setns(CLONE_NEWNS) requires it; without it ip netns
  #                     add via nsenter EPERMs.
  #   CAP_NET_RAW     — iptables -m set extension calls socket(AF_INET,SOCK_RAW,
  #                     IPPROTO_TCP) for ipset version negotiation; without
  #                     CAP_NET_RAW it fails with "Can't open socket to ipset".
  #   ProtectHome=false        — daemon writes overlay upper/work dirs under
  #                              /home/$USER/.ns-*; ProtectHome=true blocks all
  #                              /home access at openat.
  #   RestrictNamespaces=      — systemd's RestrictNamespaces seccomp filter
  #                              returns ENOSYS for clone3 because BPF can't
  #                              inspect clone_args; the daemon uses clone3
  #                              with CLONE_INTO_CGROUP for atomic placement.
  #                              CapabilityBoundingSet (CAP_SYS_ADMIN) is the
  #                              real gate for namespace ops.
  local dropin_dir=/etc/systemd/system/ellul-namespaced.service.d
  local dropin_file="$dropin_dir/00-caps.conf"
  local dropin_want='[Service]
CapabilityBoundingSet=CAP_SYS_ADMIN CAP_NET_ADMIN CAP_NET_RAW CAP_SETUID CAP_SETGID CAP_DAC_OVERRIDE CAP_CHOWN CAP_SYS_PTRACE CAP_SYS_CHROOT
ProtectHome=false
RestrictNamespaces=
ReadWritePaths=/run/ellul-ns /var/log/ellul /run /var/lib/ellul /etc/ellul
'
  local need_reload=0
  # Byte-exact compare via cmp — `$(cat)` strips trailing newlines, but the
  # file we write retains the trailing newline embedded in $dropin_want, so
  # a string compare misfires every heartbeat → endless restart loop.
  if [ ! -f "$dropin_file" ] || ! printf '%s' "$dropin_want" | cmp -s - "$dropin_file" 2>/dev/null; then
    install -d -m 0755 -o root -g root "$dropin_dir" 2>/dev/null || true
    printf '%s' "$dropin_want" > "$dropin_file.tmp" 2>/dev/null && \
      mv -Tf "$dropin_file.tmp" "$dropin_file" 2>/dev/null
    chmod 0644 "$dropin_file" 2>/dev/null
    log "agent-sync: ellul-namespaced cap-drop-in installed at $dropin_file"
    need_reload=1
  fi

  if [ "$need_reload" = "1" ]; then
    systemctl daemon-reload 2>/dev/null || true
    systemctl restart ellul-namespaced.service 2>/dev/null || true
    return 0
  fi

  if [ -L /usr/local/bin/ellul-namespaced ]; then
    case "$(systemctl is-active ellul-namespaced.service 2>/dev/null)" in
      failed|inactive)
        log "agent-sync: ellul-namespaced unit not active — reset-failed + start"
        systemctl reset-failed ellul-namespaced.service 2>/dev/null || true
        systemctl start ellul-namespaced.service 2>/dev/null || true
        ;;
    esac
  fi
}

# Keep the current release + 2 previous, delete the rest. Critically
# skips the `current` symlink — `rm -rf current/` with a trailing slash
# descends into the symlink target and empties it instead of removing
# the symlink, which silently nukes the just-applied release. We
# iterate without a trailing slash and explicitly reject symlinks.
prune_old_releases() {
  local name="$1"
  local dir="$AGENT_RELEASES_ROOT/$name"
  [ -d "$dir" ] || return 0
  local keep_list entry bname
  keep_list=$(ls -1t "$dir" 2>/dev/null | grep -v '^current$' | head -n 3)
  for entry in "$dir"/*; do
    [ -e "$entry" ] || continue
    [ -L "$entry" ] && continue    # skip the `current` symlink
    [ -d "$entry" ] || continue    # only prune real directories
    bname=$(basename "$entry")
    if ! grep -qx "$bname" <<< "$keep_list"; then
      rm -rf -- "$entry"
    fi
  done
}

# Wait up to N seconds for a systemd unit to reach is-active.
wait_unit_active() {
  # Enterprise-grade health check for a systemd unit after a restart.
  #
  # systemd exposes three signals we care about for "is this unit
  # actually healthy and stable":
  #
  #   ActiveState: "active" | "activating" | "inactive" | "failed" | ...
  #   SubState:    "running" | "exited" | "dead" | "auto-restart" | ...
  #   NRestarts:   monotonic counter — increments every time systemd
  #                auto-restarts the unit due to exit-code failure
  #
  # The original `is-active --quiet` check only looked at ActiveState.
  # A Type=simple unit that exits 1 briefly flips ActiveState=active
  # between activating and auto-restart, so a single-sample check can
  # catch the unit mid-flicker and report it healthy when it's actually
  # in a crash loop. That's how agent-bridge 0.1.1 shipped as
  # "lastInstallOutcome=success" while the service was crash-looping.
  #
  # The correct check is:
  #   1. ActiveState == "active"
  #   2. SubState == "running" (not "exited" / "auto-restart")
  #   3. NRestarts is NOT incrementing across the stability window
  # All three must hold simultaneously for `stable_secs` consecutive
  # seconds before we report success.
  #
  # Args:
  #   $1 = systemd unit name
  #   $2 = total timeout seconds (default 30)
  #   $3 = stability window seconds (default 5) — how long state must
  #        remain (active, running, non-restarting) before passing
  local unit="$1"
  local timeout="${2:-30}"
  local stable_secs="${3:-5}"

  local i=0
  local stable=0
  local baseline_restarts=""
  baseline_restarts=$(systemctl show -p NRestarts --value "$unit" 2>/dev/null || echo "0")
  [ -z "$baseline_restarts" ] && baseline_restarts=0

  while [ $i -lt $timeout ]; do
    # Read the whole state tuple in one systemctl call — cheaper than
    # three separate `show -p` invocations per sample.
    local raw
    raw=$(systemctl show -p ActiveState -p SubState -p NRestarts "$unit" 2>/dev/null || true)
    local active_state sub_state nrestarts
    active_state=$(printf '%s\n' "$raw" | awk -F= '/^ActiveState=/ {print $2}')
    sub_state=$(printf '%s\n'   "$raw" | awk -F= '/^SubState=/ {print $2}')
    nrestarts=$(printf '%s\n'   "$raw" | awk -F= '/^NRestarts=/ {print $2}')
    [ -z "$nrestarts" ] && nrestarts=0

    if [ "$active_state" = "active" ] \
        && [ "$sub_state" = "running" ] \
        && [ "$nrestarts" = "$baseline_restarts" ]; then
      stable=$((stable + 1))
      if [ $stable -ge $stable_secs ]; then
        return 0
      fi
    else
      # Any hiccup resets the stability window. If NRestarts advanced,
      # adopt the new baseline so the next attempt isn't permanently
      # poisoned by the old counter.
      stable=0
      if [ "$nrestarts" != "$baseline_restarts" ]; then
        baseline_restarts="$nrestarts"
      fi
    fi

    sleep 1
    i=$((i + 1))
  done
  return 1
}

# Stage a component: download bundle, verify sha256, extract or place
# into /opt/ellul/releases/{name}/{ver}/. Idempotent — short-circuits
# if the target dir already exists and sha256 matches (makes fleet
# rollback instant — the N-1 bytes are still on disk).
#
# Args: $1 = manifest entry as JSON from `jq -c '.components | to_entries[]'`
# Returns: 0 on success, 1 on failure
stage_component() {
  local entry="$1"
  local name ver path sha size format url
  name=$(jq -r '.key' <<< "$entry")
  ver=$(jq -r '.value.version' <<< "$entry")
  sha=$(jq -r '.value.sha256' <<< "$entry")
  size=$(jq -r '.value.size' <<< "$entry")
  format=$(jq -r '.value.format' <<< "$entry")

  # Shape validation — refuse weird versions + unknown components
  [[ "$ver" =~ ^[A-Za-z0-9._+-]{1,64}$ ]] || { log "agent-sync: invalid version '$ver' for $name"; return 1; }
  case "$name" in
    ellul-env|ellul-mount-volume|ellul-crypto|ellul-namespaced|core-runtime|ide) ;;
    *) log "agent-sync: unknown component $name — rejecting"; return 1 ;;
  esac

  local target="$AGENT_RELEASES_ROOT/$name/$ver"

  # Refuse pre-existing symlink at target (attacker planting trap).
  # Note: pre-existing regular dir means we already have this version.
  if [ -L "$target" ]; then
    logger -t agent-sync -p auth.crit "REJECTED symlink at $target" 2>/dev/null || true
    log "agent-sync: rejecting symlink at $target"
    return 1
  fi

  # Short-circuit: target already exists as a directory. Verify the
  # primary file's sha256 matches the manifest; if so, skip download.
  if [ -d "$target" ]; then
    local primary_file
    case "$name" in
      ellul-env|ellul-mount-volume) primary_file="$target/$name" ;;
      ellul-crypto)                    primary_file="$target/ellul-crypto" ;;
      ellul-namespaced)                primary_file="$target/amd64/ellul-namespaced" ;; # tarball spot-check; cache verified via .agent-sha256
      core-runtime)                      primary_file="$target/file-api.js" ;; # spot-check
      ide)                               primary_file="$target/ellul-ide" ;;
      *)                                 primary_file="" ;;
    esac
    if [ -n "$primary_file" ] && [ -f "$primary_file" ]; then
      # For single-file components, spot-check against the manifest sha.
      # For tarballs (core-runtime), spot-checking file-api.js alone is
      # sufficient: if it matches a known-good release, the whole dir is
      # cached. Mismatch = re-download.
      if [ "$format" != "tarball" ] && [ "$format" != "nodejs-tarball" ]; then
        local got
        got=$(sha256sum "$primary_file" 2>/dev/null | awk '{print $1}')
        if [ "$got" = "$sha" ]; then
          return 0
        fi
      else
        # Tarball cache validation: if target/.agent-sha256 matches, trust it.
        if [ -f "$target/.agent-sha256" ] && [ "$(cat "$target/.agent-sha256")" = "$sha" ]; then
          return 0
        fi
      fi
    fi
    # Sha mismatch or no spot-check — blow away and re-stage.
    rm -rf "$target"
  fi

  # Fresh stage: download to a mktemp dir first so a partial write can't
  # leave a half-baked release dir visible on disk.
  local stage_tmp
  stage_tmp=$(mktemp -d "$AGENT_STAGE_ROOT/stage-$name-XXXXXX") || return 1
  chmod 0700 "$stage_tmp"
  local archive="$stage_tmp/bundle.bin"
  local sid
  sid=$(cat "$SERVER_ID_FILE" 2>/dev/null | tr -d '\n')
  url="$API_URL/api/servers/$sid/agent-packages/$name/$ver"

  local http_code
  http_code=$(signed_api_request -s -L -o "$archive" -w "%{http_code}" \
    --connect-timeout 5 --max-time 300 \
    --max-filesize $((size + 65536)) \
    "$url" 2>/dev/null) || http_code="000"

  if [ "$http_code" != "200" ]; then
    log "agent-sync: download $name@$ver HTTP $http_code"
    rm -rf "$stage_tmp"
    return 1
  fi

  # Sha256 verify BEFORE touching the release dir. Never trust unverified bytes.
  local got_sha
  got_sha=$(sha256sum "$archive" 2>/dev/null | awk '{print $1}')
  if [ "$got_sha" != "$sha" ]; then
    log "agent-sync: $name@$ver sha256 mismatch (got $got_sha, want $sha)"
    rm -rf "$stage_tmp"
    return 1
  fi

  # Create the component parent dir AND version dir with explicit mode.
  # Previously this was a plain `mkdir -p "$target"` which inherits the
  # enforcer's root umask (0077), leaving every intermediate dir at 0700
  # and blocking the service user (dev) from reaching bundle files at
  # $rel/current/*.js — the MODULE_NOT_FOUND crash-loop class of bug.
  #
  # `install -d -m 0755 -o root -g root` creates each dir with the mode
  # and ownership we actually want, eliminating the umask race entirely.
  # No defensive chmod needed anywhere else; if a bug slips through here,
  # it's a creation-site bug, not a missed self-heal.
  install -d -m 0755 -o root -g root "$AGENT_RELEASES_ROOT/$name"
  install -d -m 0755 -o root -g root "$target"

  case "$format" in
    bash)
      install -m 0755 -o root -g root "$archive" "$target/$name"
      if ! bash -n "$target/$name" 2>/dev/null; then
        log "agent-sync: $name bash syntax check failed — rejecting"
        rm -rf "$target" "$stage_tmp"
        return 1
      fi
      ;;
    elf)
      install -m 0755 -o root -g root "$archive" "$target/ellul-crypto"
      # ELF magic check (0x7F 'E' 'L' 'F')
      if [ "$(head -c 4 "$target/ellul-crypto" | od -An -tx1 | tr -d ' ')" != "7f454c46" ]; then
        log "agent-sync: $name not an ELF binary — rejecting"
        rm -rf "$target" "$stage_tmp"
        return 1
      fi
      ;;
    tarball|nodejs-tarball)
      # Extract with defensive flags. tar >=1.32 refuses absolute paths
      # and .. entries by default; --no-same-owner prevents the tarball
      # from overriding our chown.
      if ! tar -xzf "$archive" -C "$target" \
          --no-same-owner \
          --no-same-permissions \
          --no-overwrite-dir 2>/dev/null; then
        log "agent-sync: $name tar extract failed"
        rm -rf "$target" "$stage_tmp"
        return 1
      fi
      # Reject any symlinks inside the extracted tree — defence in depth
      # even though tar already refuses absolute targets.
      if find "$target" -type l -print -quit 2>/dev/null | grep -q .; then
        log "agent-sync: $name archive contains symlinks — rejecting"
        rm -rf "$target" "$stage_tmp"
        return 1
      fi
      chown -R root:root "$target" 2>/dev/null || true
      find "$target" -type d -exec chmod 0755 {} + 2>/dev/null
      find "$target" -type f -exec chmod 0644 {} + 2>/dev/null
      # Promote shebang scripts and ELF binaries to 0755. JS source
      # stays 0644 (loaded via `node FILE`, not execve).
      while IFS= read -r -d '' _f; do
        local _magic
        _magic=$(head -c 4 "$_f" 2>/dev/null | od -An -tx1 | tr -d ' \n')
        case "$_magic" in
          7f454c46*) chmod 0755 "$_f" ;;
          2321*)     chmod 0755 "$_f" ;;
        esac
      done < <(find "$target" -type f -print0)
      # Record the tarball sha so the cache short-circuit can validate
      # without re-hashing every extracted file on the next sync.
      echo "$sha" > "$target/.agent-sha256"
      chmod 0444 "$target/.agent-sha256"
      ;;
    *)
      log "agent-sync: unknown format '$format' for $name"
      rm -rf "$target" "$stage_tmp"
      return 1
      ;;
  esac

  rm -rf "$stage_tmp"
  return 0
}

# Apply a staged component: flip the `current` symlink, ensure the
# /usr/local/bin/ellul-* symlinks exist, restart systemd units, and
# health-check. On failure: flip symlink back to previous version and
# restart again (local rollback to N-1).
#
# Args: $1 = manifest entry JSON
# Returns: 0 on success, 1 on failure (health=partial or health=failed)
apply_component() {
  local entry="$1"
  local name ver unit subcomponents
  name=$(jq -r '.key' <<< "$entry")
  ver=$(jq -r '.value.version' <<< "$entry")
  unit=$(jq -r '.value.restartUnit // ""' <<< "$entry")
  subcomponents=$(jq -r '.value.subcomponents // [] | @json' <<< "$entry")

  stage_component "$entry" || return 1

  local rel="$AGENT_RELEASES_ROOT/$name"
  # Migration safety: older enforcers created $rel as 0700. The install(1)
  # call in stage_component only touches new dirs — an existing 0700 dir
  # with a pre-existing version inside won't be fixed by that path because
  # stage_component short-circuits via the sha256 cache. Re-apply 0755
  # here once so older servers self-heal on their next apply. Can be
  # removed after every fleet server has applied ≥ 0.1.13.
  chmod 0755 "$rel" 2>/dev/null || true
  local prev_target=""
  [ -L "$rel/current" ] && prev_target=$(readlink "$rel/current" 2>/dev/null)

  # Atomic symlink flip
  ln -sfn "$ver" "$rel/current.new"
  mv -Tf "$rel/current.new" "$rel/current"

  ensure_bin_symlink "$name"

  # Non-service components (ellul-mount-volume helper, ellul-crypto CLI)
  # have no restart unit — done.
  if [ -z "$unit" ] || [ "$unit" = "null" ]; then
    update_installed_version "$name" "$ver"
    prune_old_releases "$name"
    return 0
  fi

  # Partition the unit list: restart the ones actually installed on this
  # host, warn-and-skip the ones that aren't. Pre-fix behaviour was a hard
  # cascade-bail when ANY listed unit was unknown to systemd — that turned
  # a build-shipping-a-placeholder (ide without ellul-ide.service) into a
  # permanently-bricked enforcer loop, because apply_manifest_components
  # returned 1 every heartbeat and the deferred ellul-env self-update never
  # ran. The component is already extracted and symlinked on disk; not
  # restarting a service that doesn't exist is strictly better than
  # perpetually failing to apply anything.
  local present_units="" missing_units=""
  for single_unit in $unit; do
    if systemctl list-unit-files "$single_unit" 2>/dev/null | grep -qE "^${single_unit}[[:space:]]"; then
      present_units="${present_units}${present_units:+ }${single_unit}"
    else
      missing_units="${missing_units}${missing_units:+ }${single_unit}"
    fi
  done
  if [ -n "$missing_units" ]; then
    log "agent-sync: $name restart skipped for unit(s) not installed: $missing_units"
  fi

  if [ -n "$present_units" ]; then
    # SERIAL restart with per-unit health gate.
    #
    # Pre-fix: `systemctl restart $present_units` kicked all units at once.
    # For core-runtime that's 5 Node processes cold-starting in parallel
    # (sovereign-shield, file-api, agent-bridge, watchdog, term-proxy) —
    # collective peak RSS on a 2 GB cpx11 exceeds available memory for
    # 60-120s. PSI memory-full avg60 legitimately climbs to 60-80% for a
    # window that overlaps the OOM-loop breaker's 180s threshold, and the
    # host reboots mid-apply. That's the 2026-04-21 brick.
    #
    # Serial restart spreads the cold-start cost over time: wait for each
    # unit to reach is-active before starting the next. Total apply time
    # grows by N × avg_cold_start (≈ 30s for 5 services) but the peak
    # concurrent memory footprint is bounded by one service at a time.
    local failed_units=""
    local first=1
    for single_unit in $present_units; do
      if [ "$first" -eq 0 ]; then
        # Brief settling delay between restarts so the previous unit's
        # heap has actually been reclaimed before the next cold-starts.
        sleep 3
      fi
      first=0

      if ! systemctl restart "$single_unit" 2>/dev/null; then
        log "agent-sync: $name systemctl restart failed for $single_unit — rolling back"
        _apply_component_rollback "$name" "$prev_target" "$unit"
        return 1
      fi

      if ! wait_unit_active "$single_unit" 30; then
        failed_units="${failed_units}${failed_units:+ }${single_unit}"
        # Don't break — record every failure so the rollback-report shows
        # the full picture instead of stopping at the first casualty.
      fi
    done

    if [ -n "$failed_units" ]; then
      log "agent-sync: $name units failed health check: $failed_units — rolling back"
      _apply_component_rollback "$name" "$prev_target" "$unit"
      return 1
    fi

    # Post-apply stability gate.
    #
    # A unit can reach "active (running)" in 30s and then crash-loop within
    # the next 60s — e.g. a config that parses fine but fails on its first
    # real request, or a memory cap that's tripped once load arrives.
    # Watch NRestarts for 60s; any restart after we declared success means
    # the new bundle is unstable under load. Roll back before the perf
    # monitor wakes up to reboot the host.
    local baseline_restarts=""
    for single_unit in $present_units; do
      local nr
      nr=$(systemctl show -p NRestarts --value "$single_unit" 2>/dev/null || echo 0)
      baseline_restarts="${baseline_restarts}${baseline_restarts:+|}${single_unit}=${nr}"
    done

    local stability_window_end=$(( $(date +%s) + 60 ))
    while [ "$(date +%s)" -lt "$stability_window_end" ]; do
      sleep 5
      for single_unit in $present_units; do
        local baseline_entry cur_nr base_nr
        baseline_entry=$(printf '%s\n' "$baseline_restarts" | tr '|' '\n' | grep -F "${single_unit}=" | head -1)
        base_nr="${baseline_entry##*=}"
        cur_nr=$(systemctl show -p NRestarts --value "$single_unit" 2>/dev/null || echo 0)
        if [ "${cur_nr:-0}" -gt "${base_nr:-0}" ] 2>/dev/null; then
          log "agent-sync: $name stability gate FAILED — $single_unit restarted ($base_nr → $cur_nr) within 60s window, rolling back"
          _apply_component_rollback "$name" "$prev_target" "$unit"
          return 1
        fi
        if ! systemctl is-active --quiet "$single_unit" 2>/dev/null; then
          log "agent-sync: $name stability gate FAILED — $single_unit inactive within 60s window, rolling back"
          _apply_component_rollback "$name" "$prev_target" "$unit"
          return 1
        fi
      done
    done
  fi

  # ── Brick-proofing: write the .applied-stable marker ────────────────
  #
  # The marker is written ONLY here, after every present unit survived
  # the stability gate. If the host reboots before this point — apply
  # interrupted by power loss, the OOM-loop breaker firing during the
  # gate, the operator pulling the plug — the new version on disk is
  # missing its marker, and `agent_sync_validate_at_boot` will roll it
  # back to the last known-stable version BEFORE any service starts.
  #
  # Combined with serial restart (no longer triggers OOM breaker),
  # post-apply gate (catches in-flight failures), perf-monitor's
  # apply-in-progress lock (suppresses breaker mid-window), and the
  # luks-boot non-blocking restart (no more 19-min boot stalls), this
  # closes the last "rebooted into a half-applied bundle" hole.
  local stable_marker="$rel/$ver/.applied-stable"
  local now_iso
  now_iso=$(date -Iseconds)
  printf 'version=%s\napplied_at=%s\n' "$ver" "$now_iso" > "$stable_marker.new" 2>/dev/null
  mv -Tf "$stable_marker.new" "$stable_marker" 2>/dev/null || true
  chmod 0444 "$stable_marker" 2>/dev/null || true

  update_installed_version "$name" "$ver"
  prune_old_releases "$name"
  return 0
}

# Boot-time validation: roll back any component whose `current` symlink
# points at a release directory missing the `.applied-stable` marker.
#
# A missing marker means the apply was interrupted before the stability
# gate could declare it good — most often by a reboot during the 60s
# window (OOM breaker, power loss, operator). Without this check, the
# host comes back with a half-applied bundle that may crash on first
# request, and there's no signal to the apply path to roll it back —
# the apply is "complete" as far as agent-sync is concerned.
#
# Called once from run_daemon at startup, BEFORE the heartbeat loop.
# Idempotent — components without rotateable releases (bash scripts,
# elf binaries) are skipped.
agent_sync_validate_at_boot() {
  [ -d "$AGENT_RELEASES_ROOT" ] || return 0

  for rel in "$AGENT_RELEASES_ROOT"/*/; do
    local name cur prev
    name=$(basename "$rel")
    [ -L "$rel/current" ] || continue
    cur=$(readlink "$rel/current" 2>/dev/null)
    [ -n "$cur" ] || continue
    [ -d "$rel/$cur" ] || continue

    # If the marker is present, the component passed its stability gate
    # at apply time. Trust it.
    [ -f "$rel/$cur/.applied-stable" ] && continue

    # Component has no marker. Find a previous version that DOES have one.
    # Walk versions newest-first to skip any other half-applied dirs.
    local found=""
    for candidate_dir in $(ls -1t "$rel" 2>/dev/null); do
      [ "$candidate_dir" = "current" ] && continue
      [ "$candidate_dir" = "$cur" ] && continue
      [ -d "$rel/$candidate_dir" ] || continue
      [ -f "$rel/$candidate_dir/.applied-stable" ] || continue
      found="$candidate_dir"
      break
    done

    if [ -z "$found" ]; then
      # No safe target. This happens on a fresh server where the very
      # first apply was interrupted, or after marker garbage collection
      # ran too eagerly. Leave `current` alone — the next agent-sync
      # cycle will re-apply the manifest from R2 with the full gate.
      log "agent-sync: $name @ $cur lacks .applied-stable but no prior stable version exists — leaving for next sync"
      continue
    fi

    log "agent-sync: BOOT-ROLLBACK $name $cur → $found (current was missing .applied-stable, likely interrupted apply)"
    ln -sfn "$found" "$rel/current.new"
    mv -Tf "$rel/current.new" "$rel/current"
    ensure_bin_symlink "$name"
    update_installed_version "$name" "$found"
  done
}

# Private helper: roll a component back to its previous version.
# Called by apply_component on failure.
_apply_component_rollback() {
  local name="$1"
  local prev_target="$2"
  local unit="$3"
  local rel="$AGENT_RELEASES_ROOT/$name"

  if [ -n "$prev_target" ] && [ -d "$rel/$prev_target" ]; then
    ln -sfn "$prev_target" "$rel/current.new"
    mv -Tf "$rel/current.new" "$rel/current"
    ensure_bin_symlink "$name"
    systemctl restart $unit 2>/dev/null || true
    log "agent-sync: $name rolled back to $prev_target"
  else
    log "agent-sync: $name no previous version to roll back to"
  fi
}

# Apply a manifest to this VPS. Iterates components in restartOrder.
# On any failure, cascade-roll back every component already applied in
# this manifest run so the fleet never lands in a half-applied state.
# ellul-env self-update is deferred to the end because the exec
# replaces this process.
#
# Args: $1 = decoded manifest JSON (the inner body, not the wrapping envelope)
# Returns: 0 on full success, 1 on any failure (state fully reverted)
#          Prints "__SELF_UPDATE_READY__" on stdout when the caller must
#          exec the new ellul-env after reporting.
apply_manifest_components() {
  # ── Apply-in-progress breadcrumb ──────────────────────────────────────
  # Tell ellul-perf-monitor to suppress its OOM-loop breaker while we run.
  # Core-runtime applies cold-start 5 Node services and legitimately push
  # PSI memory-full into the 60-80% range for 60-120s; the breaker's 180s
  # sustained-pressure rule would otherwise reboot the host mid-apply,
  # which is the exact 2026-04-21 brick pattern. The lock is mtime-stamped;
  # if this process crashes or is killed before clearing it, perf-monitor
  # expires the lock after APPLY_LOCK_MAX_AGE_SEC so we can never wedge the
  # breaker off permanently.
  #
  # Wrap the body in an inner function so we clean up on every return
  # path with a single explicit call, regardless of which `return` fires.
  mkdir -p /run 2>/dev/null
  printf '%d\n' "$$" > /run/ellul-apply-in-progress 2>/dev/null || true
  _apply_manifest_components_inner "$@"
  local rc=$?
  rm -f /run/ellul-apply-in-progress
  return $rc
}

_apply_manifest_components_inner() {
  local manifest="$1"

  local deferred_self_update=""

  # Parallel arrays of components applied successfully so far in this
  # run. Used for cascade rollback on any subsequent failure.
  local -a applied_names=()
  local -a applied_prev=()
  local -a applied_units=()

  # Peer components that failed apply. We remember these so that a
  # deferred ellul-env self-update can still run (breaking the
  # chicken-and-egg where a peer bug locks the enforcer to its buggy
  # self), then either cascade or get retried by the new daemon.
  local -a peer_failed_names=()
  local peer_failed_rc=0

  while IFS= read -r entry; do
    [ -z "$entry" ] && continue
    local name wanted wanted_sha wanted_format cur
    name=$(jq -r '.key' <<< "$entry")
    wanted=$(jq -r '.value.version' <<< "$entry")
    wanted_sha=$(jq -r '.value.sha256' <<< "$entry")
    wanted_format=$(jq -r '.value.format' <<< "$entry")
    cur=$(agent_installed_version "$name")

    # Gate on requiredFeatureFlags — if the manifest declares feature
    # flags for this component, every flag must exist and contain "1"
    # in /etc/ellul/feature-flags/. Provisioning writes these flags
    # based on the server's profile; components gated by missing flags
    # are silently skipped without blocking sibling installs.
    local _skip_flags=false
    local _flags
    _flags=$(jq -r '.value.requiredFeatureFlags // [] | .[]' <<< "$entry" 2>/dev/null)
    if [ -n "$_flags" ]; then
      while IFS= read -r _flag; do
        [ -z "$_flag" ] && continue
        if [ "$(head -c 1 "/etc/ellul/feature-flags/$_flag" 2>/dev/null)" != "1" ]; then
          log "agent-sync: $name skipped — feature flag '$_flag' not set"
          _skip_flags=true
          break
        fi
      done <<< "$_flags"
    fi
    if [ "$_skip_flags" = "true" ]; then
      continue
    fi

    # Skip only when BOTH version AND sha256 match what's on disk.
    # Closes the "same version, new binary" footgun — a manifest that
    # reuses a semver with different bytes forces re-install here.
    if agent_onDisk_matches "$name" "$wanted" "$wanted_sha" "$wanted_format"; then
      continue
    fi
    if [ "$cur" = "$wanted" ]; then
      log "agent-sync: $name $wanted on-disk sha256 drift — re-installing"
    else
      log "agent-sync: $name $cur → $wanted"
    fi

    if [ "$name" = "ellul-env" ]; then
      if stage_component "$entry"; then
        deferred_self_update="$entry"
      else
        _cascade_rollback applied_names applied_prev applied_units
        log "agent-sync: bailing — ellul-env stage failed"
        return 1
      fi
      continue
    fi

    # Capture prev_target BEFORE apply_component flips the symlink so
    # cascade rollback can revert this component if a later one fails.
    local rel="$AGENT_RELEASES_ROOT/$name"
    local prev_target=""
    [ -L "$rel/current" ] && prev_target=$(readlink "$rel/current" 2>/dev/null)
    local unit
    unit=$(jq -r '.value.restartUnit // ""' <<< "$entry")

    if apply_component "$entry"; then
      applied_names+=("$name")
      applied_prev+=("$prev_target")
      applied_units+=("$unit")
    else
      # Remember the peer failure but keep processing — specifically the
      # deferred ellul-env self-update must still get its chance. Without
      # this, a single broken peer component (ide in the v58 incident)
      # prevents the enforcer from ever installing the fixed version
      # that would otherwise unbrick the host. Cascade rollback is
      # deferred to the post-loop block below so a successful self-update
      # can clear the peer failure on its own terms (the new daemon's
      # next apply cycle sees the working manifest afresh).
      peer_failed_names+=("$name")
      peer_failed_rc=1
      log "agent-sync: $name apply failed (will still attempt deferred self-update if any)"
    fi
  done < <(jq -c '.components | to_entries | sort_by(.value.restartOrder) | .[]' <<< "$manifest")

  # Self-update runs even if a peer component failed. The broken peer is
  # typically a symptom of a manifest bug that the NEWER enforcer fixes
  # (as in v60/v61 vs the v58 ide bug) — deferring self-update behind
  # peer success is the root-cause chicken-and-egg that bricks servers.
  #
  # Safety net for a self-update that's itself broken: _apply_self_update
  # runs bash -n + --self-test on the staged binary before flipping, and
  # writes a pending-commit marker. If the new daemon crash-loops before
  # its first successful heartbeat, agent_sync_recover_from_crash rolls
  # back to the prior working binary. So "try self-update first" is
  # strictly safer than the deferred model.
  if [ -n "$deferred_self_update" ]; then
    if _apply_self_update "$deferred_self_update"; then
      # Peer failures (if any) are logged but NOT cascaded here — the
      # new daemon will retry them on its own first apply cycle. The
      # agent-report line tells the operator what went sideways.
      if [ "$peer_failed_rc" -ne 0 ]; then
        log "agent-sync: self-update applied despite peer failure(s): ${peer_failed_names[*]} — new daemon will retry"
      fi
      echo "__SELF_UPDATE_READY__"
      return 0
    else
      # Self-update itself failed its preflight or flip — we have no
      # better fallback than cascading whatever peer state was in flight.
      _cascade_rollback applied_names applied_prev applied_units
      log "agent-sync: bailing — self-update failed, rolled back $(( ${#applied_names[@]} )) prior components"
      return 1
    fi
  fi

  # No self-update this cycle; if a peer failed, cascade now so we stay
  # consistent with the "all or nothing" promise for non-self-update runs.
  if [ "$peer_failed_rc" -ne 0 ]; then
    _cascade_rollback applied_names applied_prev applied_units
    log "agent-sync: bailing — peer apply failed (${peer_failed_names[*]}), rolled back $(( ${#applied_names[@]} )) prior components"
    return 1
  fi

  return 0
}

# Reverse-iterate the applied-so-far list, rolling each component back
# to the symlink target recorded before apply_component touched it.
# Arguments are names of bash arrays passed by reference (namerefs).
_cascade_rollback() {
  local -n _names=$1
  local -n _prevs=$2
  local -n _units=$3
  local i
  for (( i=${#_names[@]}-1; i>=0; i-- )); do
    local n="${_names[$i]}"
    local p="${_prevs[$i]}"
    local u="${_units[$i]}"
    log "agent-sync: cascade rollback $n → ${p:-none}"
    _apply_component_rollback "$n" "$p" "$u"
    # Revert installed-versions mirror so the next sync loop observes
    # truth on disk.
    if [ -n "$p" ]; then
      update_installed_version "$n" "$p"
    fi
  done
}

# Seed the cloud-init baseline enforcer into the release dir so
# _apply_self_update always has a valid prev_target for rollback.
#
# Before this seed: first-install self-update wrote prev_target="" into
# the pending-commit marker. If the new daemon crash-looped,
# agent_sync_recover_from_crash would hit the "cannot roll back — prev
# missing on disk" branch and leave the broken binary in place. The VPS
# would then be bricked with NO safe harbour.
#
# After seeding: even the very first self-update can unwind to the
# cloud-init baseline, identical to the binary that booted the machine.
# Idempotent and O(1): exits immediately once the "baseline" dir exists.
#
# Called from run_daemon startup, BEFORE any apply cycle can touch
# /opt/ellul/releases/ellul-env.
agent_sync_seed_baseline() {
  local rel="$AGENT_RELEASES_ROOT/ellul-env"
  local baseline_dir="$rel/baseline"
  [ -d "$baseline_dir" ] && return 0
  local bin="/usr/local/bin/ellul-env"
  [ -f "$bin" ] || return 0
  # Skip if bin is already a symlink into a release — there's a managed
  # version in play and the standard rollback chain is sufficient.
  [ -L "$bin" ] && return 0
  install -d -m 0755 "$rel" 2>/dev/null || return 0
  install -d -m 0755 "$baseline_dir" 2>/dev/null || return 0
  if install -m 0755 "$bin" "$baseline_dir/ellul-env" 2>/dev/null; then
    # sha256 sidecar keeps agent_onDisk_matches honest if the manifest
    # ever lists "baseline" as a valid version (it won't, but defensive).
    sha256sum "$baseline_dir/ellul-env" 2>/dev/null | awk '{print $1}' \
      > "$baseline_dir/.agent-sha256" 2>/dev/null
    log "agent-sync: seeded cloud-init baseline into $baseline_dir (rollback floor)"
  fi
  # If /opt/ellul/releases/ellul-env/current doesn't exist yet, point it
  # at baseline so _apply_self_update sees a readable prev_target on the
  # first cycle. ln -sfn is atomic and won't fight a concurrent apply.
  if [ ! -L "$rel/current" ]; then
    ln -sfn "baseline" "$rel/current.new" 2>/dev/null && \
      mv -Tf "$rel/current.new" "$rel/current" 2>/dev/null && \
      log "agent-sync: pointed ellul-env/current → baseline (first-run floor)"
  fi
}

# Private helper: stage the new ellul-env, run --self-test against
# the STAGED binary, write the pending-commit marker, flip the symlink.
# Caller is responsible for the final exec.
_apply_self_update() {
  local entry="$1"
  local ver
  ver=$(jq -r '.value.version' <<< "$entry")
  local rel="$AGENT_RELEASES_ROOT/ellul-env"
  local staged="$rel/$ver/ellul-env"

  [ -f "$staged" ] || { log "agent-sync: self-update $ver missing from stage"; return 1; }
  [ -x "$staged" ] || chmod 0755 "$staged"

  # Pre-flight 1: bash parse check. Catches syntax errors.
  if ! bash -n "$staged" 2>/dev/null; then
    log "agent-sync: self-update $ver failed bash -n"
    return 1
  fi

  # Pre-flight 2: --self-test on the STAGED binary. Catches logic bugs
  # that would parse cleanly but break sync_agent_bundle (broken jq
  # invocation, missing path, wrong CRYPTO_BIN location, etc.). This is
  # the only thing protecting the fleet from a bad deploy bricking
  # future updates.
  if ! bash "$staged" --self-test >/dev/null 2>&1; then
    local rc=$?
    log "agent-sync: self-update $ver failed --self-test (exit $rc)"
    return 1
  fi

  # Capture the previous target BEFORE flipping so the pending-commit
  # marker and recovery path can revert on failure.
  local prev_target=""
  [ -L "$rel/current" ] && prev_target=$(readlink "$rel/current" 2>/dev/null)

  # Write the pending-commit marker: recovered_by the new daemon on
  # first successful heartbeat (agent_sync_commit_pending), or by the
  # next daemon startup if stale (agent_sync_recover_from_crash).
  local now
  now=$(date +%s)
  jq -nc \
    --arg prev "$prev_target" \
    --arg next "$ver" \
    --argjson ts "$now" \
    '{previous: $prev, next: $next, stagedAt: $ts}' \
    > "$AGENT_PENDING_COMMIT_FILE.new"
  chmod 0600 "$AGENT_PENDING_COMMIT_FILE.new"
  mv -Tf "$AGENT_PENDING_COMMIT_FILE.new" "$AGENT_PENDING_COMMIT_FILE"

  # Atomic flip
  ln -sfn "$ver" "$rel/current.new"
  mv -Tf "$rel/current.new" "$rel/current"
  ensure_bin_symlink "ellul-env"
  update_installed_version "ellul-env" "$ver"
  prune_old_releases "ellul-env"
  return 0
}

# Called by run_daemon at startup. If a pending-commit marker exists:
#
#   - fresh (< AGENT_COMMIT_WINDOW_SEC): leave it. The new daemon will
#     clear it after the first successful heartbeat via
#     agent_sync_commit_pending.
#   - stale: the new daemon crash-looped, systemd restarted it multiple
#     times, and no commit ever landed. Roll back to the recorded
#     previous version and exec it.
agent_sync_recover_from_crash() {
  [ -f "$AGENT_PENDING_COMMIT_FILE" ] || return 0

  local staged_at prev next now age
  staged_at=$(jq -r '.stagedAt // 0' "$AGENT_PENDING_COMMIT_FILE" 2>/dev/null)
  prev=$(jq -r '.previous // ""' "$AGENT_PENDING_COMMIT_FILE" 2>/dev/null)
  next=$(jq -r '.next // ""' "$AGENT_PENDING_COMMIT_FILE" 2>/dev/null)
  now=$(date +%s)
  age=$(( now - staged_at ))

  if [ "$age" -lt "$AGENT_COMMIT_WINDOW_SEC" ]; then
    log "agent-sync: pending self-update commit in flight (age=${age}s next=$next)"
    return 0
  fi

  log "agent-sync: STALE pending commit (age=${age}s, prev=$prev, next=$next) — rolling back"

  local rel="$AGENT_RELEASES_ROOT/ellul-env"
  if [ -z "$prev" ] || [ ! -d "$rel/$prev" ]; then
    log "agent-sync: cannot roll back — prev=$prev missing on disk"
    rm -f "$AGENT_PENDING_COMMIT_FILE"
    return 1
  fi

  ln -sfn "$prev" "$rel/current.new"
  mv -Tf "$rel/current.new" "$rel/current"
  ensure_bin_symlink "ellul-env"
  update_installed_version "ellul-env" "$prev"
  rm -f "$AGENT_PENDING_COMMIT_FILE"

  # Report the crash-loop rollback so the operator sees it in the
  # dashboard before the rolled-back binary exec's.
  post_agent_report "" "rolled_back" "ellul-env" 2>/dev/null || true

  log "agent-sync: rolled back to ellul-env $prev — exec"
  exec /usr/local/bin/ellul-env daemon
}

# Called from run_daemon after the first successful heartbeat. Deletes
# the pending-commit marker so agent_sync_recover_from_crash treats the
# next restart as normal.
agent_sync_commit_pending() {
  [ -f "$AGENT_PENDING_COMMIT_FILE" ] || return 0
  local next
  next=$(jq -r '.next // ""' "$AGENT_PENDING_COMMIT_FILE" 2>/dev/null)
  rm -f "$AGENT_PENDING_COMMIT_FILE"
  [ -n "$next" ] && log "agent-sync: committed self-update to $next"
}

# POST /api/servers/:id/agent-report with the current installed versions
# and health summary. Fire-and-forget — a failed report does not block
# the sync. Called after every sync_agent_bundle run and after every
# apply-pending-update command handler.
post_agent_report() {
  local applied_version="$1"
  local outcome="$2"  # success | partial | failed | rolled_back | pending_approval
  local failed_component="${3:-}"

  local installed="{}"
  [ -f "$AGENT_INSTALLED_FILE" ] && installed=$(cat "$AGENT_INSTALLED_FILE" 2>/dev/null || echo "{}")
  [ -z "$installed" ] && installed="{}"

  local auto_update="true"
  [ -f "$AGENT_AUTO_UPDATE_FILE" ] && auto_update=$(cat "$AGENT_AUTO_UPDATE_FILE" 2>/dev/null | tr -d '\n' | head -c 8)
  [[ "$auto_update" =~ ^(true|false)$ ]] || auto_update="true"

  local pending_version="null"
  [ -f "$AGENT_PENDING_MANIFEST_FILE" ] && \
    pending_version=$(jq -r '.version // "null"' "$AGENT_PENDING_MANIFEST_FILE" 2>/dev/null || echo "null")

  local sid
  sid=$(cat "$SERVER_ID_FILE" 2>/dev/null | tr -d '\n')
  [ -z "$sid" ] && return 0

  local kernel uptime
  kernel=$(uname -r 2>/dev/null || echo "unknown")
  uptime=$(awk '{print int($1)}' /proc/uptime 2>/dev/null || echo 0)

  local health_json
  health_json=$(jq -c -n \
    --arg reportedAt "$(date -u +%FT%TZ)" \
    --arg kernel "$kernel" \
    --argjson uptime "$uptime" \
    --argjson installed "$installed" \
    '{reportedAt: $reportedAt, kernel: $kernel, uptime: $uptime, components: ($installed | to_entries | map({key: .key, value: {installedVersion: .value, systemd: "active", liveness: "not-applicable", restartCount24h: 0}}) | from_entries)}' \
    2>/dev/null)

  # Build the body with `jq -c` (compact, single-line output). Pretty-
  # printed JSON passed via `curl -d "$body"` produces an EMPTY request
  # body — curl's -d flag mishandles multi-line bash variables and
  # silently truncates. Compact single-line JSON bypasses the quirk.
  # Also OMIT lastInstallError when empty, so older API builds still
  # using `.optional()` (undefined-only) accept it.
  local body
  if [ -z "$failed_component" ]; then
    body=$(jq -c -n \
      --argjson applied "$applied_version" \
      --argjson installed "$installed" \
      --argjson health "$health_json" \
      --arg outcome "$outcome" \
      --argjson autoUpdate "$([ "$auto_update" = "true" ] && echo true || echo false)" \
      --argjson pending "$pending_version" \
      '{appliedVersion: $applied, installedVersions: $installed, health: $health, lastInstallOutcome: $outcome, autoUpdateEffective: $autoUpdate, pendingUpdateVersion: $pending}' \
      2>/dev/null)
  else
    body=$(jq -c -n \
      --argjson applied "$applied_version" \
      --argjson installed "$installed" \
      --argjson health "$health_json" \
      --arg outcome "$outcome" \
      --arg failed "$failed_component" \
      --argjson autoUpdate "$([ "$auto_update" = "true" ] && echo true || echo false)" \
      --argjson pending "$pending_version" \
      '{appliedVersion: $applied, installedVersions: $installed, health: $health, lastInstallOutcome: $outcome, lastInstallError: $failed, autoUpdateEffective: $autoUpdate, pendingUpdateVersion: $pending}' \
      2>/dev/null)
  fi

  # Capture the HTTP code so failures are visible in the enforcer log.
  # NOTE: do NOT add -H "Content-Type: application/json" here —
  # signed_api_request already sets it, and a duplicate header makes
  # curl send `Content-Type: application/json, application/json` which
  # Hono's JSON parser rejects silently, so the API gets an empty body
  # and every field 400s as ZodError "Required, received undefined".
  # This bug was the only thing blocking agent_reports from populating.
  local http_code
  http_code=$(signed_api_request -s -o /dev/null -w '%{http_code}' \
    --connect-timeout 5 --max-time 10 \
    -X POST -d "$body" \
    "$API_URL/api/servers/$sid/agent-report" 2>/dev/null) || http_code="000"

  if [ "$http_code" = "200" ]; then
    log "agent-report: outcome=$outcome applied=$applied_version http=200"
  else
    log "agent-report: outcome=$outcome applied=$applied_version http=$http_code FAILED"
  fi
}

# ─── Liveness ping ──────────────────
#
# Unconditional heartbeat posting {agentVersion, installedVersions,
# manifestVersion, autoUpdate, systemdHealth}. Fires on its own cadence
# from the enforcer main loop, completely independent of sync_agent_bundle. This
# is the signal the dashboard uses to answer "is this VPS alive right
# now?". Before this channel existed, a VPS with nothing to sync would
# never post to the API at all and the UI would get stuck in "waiting
# for first report" forever.

# Capture a snapshot of the critical ellul.ai services for the ping
# body. Callers stringify via jq. Keys are systemd unit names.
collect_systemd_health() {
  # The set of units we probe is the same set that matters for the
  # "health" column in the dashboard. Adding/removing here does not
  # require an API change — the API accepts any map<string, enum>.
  local units=(
    "ellul-enforcer"
    "ellul-file-api"
    "ellul-agent-bridge"
    "ellul-watchdog"
    "ellul-term-proxy"
    "ellul-sovereign-shield"
    "caddy"
  )

  # Start with an empty object; fold each unit state in via jq.
  local out='{}'
  local u state
  for u in "${units[@]}"; do
    if [ "$IS_MACOS" = "true" ]; then
      # Parity on darwin dev boxes: just report "unknown" so the ping
      # still lands. macOS dev isn't the fleet target, this keeps the
      # path compilable for local testing.
      state="unknown"
    else
      if systemctl list-unit-files --no-legend "$u.service" 2>/dev/null | grep -q "^$u.service"; then
        state=$(systemctl is-active "$u" 2>/dev/null || echo "unknown")
        case "$state" in
          active|activating|inactive|failed) ;;
          *) state="unknown" ;;
        esac
      else
        # Unit not installed on this VPS (e.g. term-proxy before a
        # specific provisioning step). Report as unknown rather than
        # inactive — avoids false red badges.
        state="unknown"
      fi
    fi
    out=$(jq -c --arg k "$u" --arg v "$state" '. + {($k): $v}' <<< "$out" 2>/dev/null || echo "$out")
  done

  printf '%s' "$out"
}

# Fire one unconditional liveness ping. No-op when the vault isn't
# mounted (sovereign awaiting_unlock) or the signing stack isn't ready.
# Never returns an error code — failed pings are logged but never block
# the main loop or trigger the heartbeat-failure path.
agent_ping() {
  # Vault-locked boxes can't sign anything. Skip silently.
  if ! mountpoint -q /etc/ellul 2>/dev/null; then
    return 0
  fi
  [ ! -f "$SERVER_ID_FILE" ] && return 0
  [ -z "$API_URL" ] && return 0

  local sid
  sid=$(cat "$SERVER_ID_FILE" 2>/dev/null | tr -d '\n')
  [ -z "$sid" ] && return 0

  # What's actually installed right now, as reported by the versions file.
  local installed="{}"
  [ -f "$AGENT_INSTALLED_FILE" ] && installed=$(cat "$AGENT_INSTALLED_FILE" 2>/dev/null || echo "{}")
  [ -z "$installed" ] && installed="{}"

  # The currently-applied manifest version (or 0 if we've never synced).
  local manifest_version=0
  if [ -f "$AGENT_MANIFEST_VERSION_FILE" ]; then
    manifest_version=$(tr -d '\n' < "$AGENT_MANIFEST_VERSION_FILE" | head -c 16)
  fi
  [[ "$manifest_version" =~ ^[0-9]+$ ]] || manifest_version=0

  # Sovereignty flag as a JSON boolean.
  local auto_update="true"
  [ -f "$AGENT_AUTO_UPDATE_FILE" ] && auto_update=$(cat "$AGENT_AUTO_UPDATE_FILE" 2>/dev/null | tr -d '\n' | head -c 8)
  [[ "$auto_update" =~ ^(true|false)$ ]] || auto_update="true"

  # The enforcer's own running version. Computed at RUNTIME from the
  # currently-executing script's sha256 — NOT from the manifest metadata.
  # This is a code-execution proof: the semver comes from the installed-
  # versions file (which could be updated by a metadata-only change), but
  # the suffix is the sha256 of whatever binary is actually running right
  # now. The only way `pinged_agent_version` can contain a non-empty hex
  # suffix is if this exact code path is executing — no amount of manifest
  # spoofing can forge it. The resolved symlink target is what's actually
  # been exec'd after apply_self_update's exec, so hashing it captures
  # reality.
  local agent_semver self_path self_hash
  agent_semver=$(jq -r '.["ellul-env"] // "bootstrap"' <<< "$installed" 2>/dev/null || echo "bootstrap")
  self_path=$(readlink -f /usr/local/bin/ellul-env 2>/dev/null)
  if [ -n "$self_path" ] && [ -r "$self_path" ]; then
    self_hash=$(sha256sum "$self_path" 2>/dev/null | cut -c1-12)
  fi
  local agent_version
  if [ -n "${self_hash:-}" ]; then
    agent_version="${agent_semver}+${self_hash}"
  else
    agent_version="$agent_semver"
  fi

  local systemd_health
  systemd_health=$(collect_systemd_health)
  [ -z "$systemd_health" ] && systemd_health='{}'

  # Capability set for this enforcer release.
  # See lib/capabilities.sh for the current array. Sent on every ping
  # so the dashboard can gate VPS-dependent features by string match.
  local capabilities_json
  capabilities_json=$(enforcer_capabilities_json 2>/dev/null)
  [ -z "$capabilities_json" ] && capabilities_json='[]'

  local body
  body=$(jq -c -n \
    --arg av "$agent_version" \
    --argjson iv "$installed" \
    --argjson mv "$manifest_version" \
    --argjson au "$([ "$auto_update" = "true" ] && echo true || echo false)" \
    --argjson sh "$systemd_health" \
    --argjson caps "$capabilities_json" \
    '{agentVersion: $av, installedVersions: $iv, manifestVersion: $mv, autoUpdateEffective: $au, systemdHealth: $sh, capabilities: $caps}' \
    2>/dev/null)

  if [ -z "$body" ]; then
    log "agent-ping: failed to build body"
    return 0
  fi

  # Capture the response body so the API can push a new cadence back
  # via pingIntervalSeconds. Also capture the HTTP code so failed pings
  # land in the enforcer log (useful for debugging auth drift).
  local resp_file http_code
  resp_file=$(mktemp /tmp/agent-ping-XXXXXX)
  http_code=$(signed_api_request -s -o "$resp_file" -w '%{http_code}' \
    --connect-timeout 3 --max-time 8 \
    -X POST -d "$body" \
    "$API_URL/api/servers/$sid/agent-ping" 2>/dev/null) || http_code="000"

  # Visual-test trace: stamps the enforcer version on every ping line
  # so the update flow is observable in the enforcer log. Bumping this
  # string on a release is a cheap way to prove a self-update actually
  # swapped the binary (vs the manifest metadata changing with no real
  # behavior diff).
  log "agent-ping: fire v=$agent_version mv=$manifest_version interval=${PING_INTERVAL_TICKS}t"

  if [ "$http_code" = "200" ]; then
    # Mark that at least one ping has succeeded this boot. The main
    # loop uses this marker to force an extra ping attempt until one
    # lands, so a freshly-booted VPS doesn't have to wait N ticks for
    # the dashboard to light up.
    touch "$AGENT_PING_BOOT_MARKER" 2>/dev/null || true

    # Honour a server-pushed cadence change. Writes to the persistent
    # cadence file so subsequent boots come up with the new interval.
    if [ -s "$resp_file" ]; then
      local new_secs
      new_secs=$(jq -r '.pingIntervalSeconds // empty' "$resp_file" 2>/dev/null)
      if [[ "$new_secs" =~ ^[0-9]+$ ]] && [ "$new_secs" -ge 10 ] && [ "$new_secs" -le 3600 ]; then
        # Convert seconds → ticks using HEARTBEAT_INTERVAL. Round up so
        # we never ping faster than the server asked.
        local new_ticks=$(( (new_secs + HEARTBEAT_INTERVAL - 1) / HEARTBEAT_INTERVAL ))
        [ "$new_ticks" -lt 1 ] && new_ticks=1
        if [ "$new_ticks" != "$PING_INTERVAL_TICKS" ]; then
          PING_INTERVAL_TICKS=$new_ticks
          echo "$new_ticks" > "$AGENT_PING_TICK_FILE" 2>/dev/null || true
          log "agent-ping: cadence updated to ${new_secs}s (${new_ticks} ticks)"
        fi
      fi
    fi

    log "agent-ping: http=200 applied=$manifest_version auto=$auto_update"
  else
    log "agent-ping: http=$http_code applied=$manifest_version FAILED"
  fi

  rm -f "$resp_file"
  return 0
}

# Main entry point. Pulls the latest manifest, applies diffs, reports
# health. Called from heartbeat() and heartbeat_raw() after
# poll_and_execute_commands + fetch_entitlement_if_stale.
sync_agent_bundle() {
  # Guard: vault must be mounted (sovereign awaiting_unlock → no-op).
  # The shield-data directory lives inside the vault.
  # Vault must be mounted before we can read shield-data files. On a
  # sovereign-locked box this returns until the user unlocks via PRF.
  if ! mountpoint -q /etc/ellul 2>/dev/null; then
    _agent_sync_skip_log "vault-unmounted"
    return 0
  fi
  if [ ! -f "$COMMAND_SIGNING_PUBKEY_FILE" ]; then
    _agent_sync_skip_log "missing-signing-pubkey ($COMMAND_SIGNING_PUBKEY_FILE)"
    return 0
  fi
  if [ ! -x "$CRYPTO_BIN" ]; then
    _agent_sync_skip_log "missing-crypto-binary ($CRYPTO_BIN)"
    return 0
  fi

  # Ensure releases tree exists on disk (bootstrap VPSes have nothing yet).
  mkdir -p "$AGENT_RELEASES_ROOT" "$AGENT_STAGE_ROOT" 2>/dev/null
  chmod 0755 "$AGENT_RELEASES_ROOT" 2>/dev/null
  chmod 0700 "$AGENT_STAGE_ROOT" 2>/dev/null

  # Concurrency: non-blocking flock. A second heartbeat mid-sync no-ops.
  if ! exec 9>"$AGENT_UPDATE_LOCK"; then
    _agent_sync_skip_log "lock-open-failed ($AGENT_UPDATE_LOCK)"
    return 0
  fi
  if ! flock -n 9; then
    # Another sync is already running — silent (high-frequency, expected).
    exec 9>&-
    return 0
  fi

  # Read current manifest version for conditional GET.
  local LOCAL_MV=0
  if [ -f "$AGENT_MANIFEST_VERSION_FILE" ]; then
    LOCAL_MV=$(tr -d '\n' < "$AGENT_MANIFEST_VERSION_FILE" | head -c 16)
  fi
  [[ "$LOCAL_MV" =~ ^[0-9]+$ ]] || LOCAL_MV=0

  local sid
  sid=$(cat "$SERVER_ID_FILE" 2>/dev/null | tr -d '\n')
  if [ -z "$sid" ]; then
    _agent_sync_skip_log "missing-server-id ($SERVER_ID_FILE) — provisioning incomplete"
    exec 9>&-
    return 0
  fi

  # All prerequisites passed — clear the edge-triggered skip state so a
  # FUTURE prereq failure (different reason) gets logged even if we
  # previously logged the same reason on a prior tick.
  _agent_sync_skip_log_clear

  # Self-heal runs every tick, before the conditional-GET cache gate.
  # Reconcile inside the manifest-applied path only fires on new
  # manifests, which is too rare to recover from a bad state.
  self_heal_namespaced
  self_heal_opencode_binary_version
  self_heal_cursor_agent_binary

  # Conditional GET
  local resp_file http_code
  resp_file=$(mktemp /tmp/agent-manifest-XXXXXX)
  http_code=$(signed_api_request -s -o "$resp_file" -w "%{http_code}" \
    --connect-timeout 5 --max-time 10 \
    -H "If-None-Match: version=$LOCAL_MV" \
    "$API_URL/api/servers/$sid/agent-manifest/current" 2>/dev/null) || http_code="000"

  case "$http_code" in
    304|204)
      # 304: cache hit (common path). 204: no eligible manifest.
      rm -f "$resp_file"
      exec 9>&-
      return 0
      ;;
    200)
      ;;
    *)
      log "agent-sync: manifest fetch HTTP $http_code"
      rm -f "$resp_file"
      exec 9>&-
      return 0
      ;;
  esac

  local remote_mv jws
  remote_mv=$(jq -r '.version // empty' "$resp_file" 2>/dev/null)
  jws=$(jq -r '.jws // empty' "$resp_file" 2>/dev/null)
  rm -f "$resp_file"

  if [ -z "$remote_mv" ] || [ -z "$jws" ]; then
    log "agent-sync: malformed manifest response"
    exec 9>&-
    return 0
  fi
  if ! [[ "$remote_mv" =~ ^[0-9]+$ ]]; then
    log "agent-sync: bad version in manifest response"
    exec 9>&-
    return 0
  fi

  # Monotonic anti-replay (fast path)
  if [ "$remote_mv" -le "$LOCAL_MV" ]; then
    exec 9>&-
    return 0
  fi

  # ML-DSA-65 signature verify (key ring aware)
  if ! verify_jws_ml_dsa65_ring "$jws" "$COMMAND_SIGNING_PUBKEY_FILE"; then
    log "agent-sync: manifest v$remote_mv JWS verification FAILED — rejecting"
    exec 9>&-
    return 1
  fi

  # Decode body
  local manifest
  manifest=$(decode_jws_body "$jws")
  if [ -z "$manifest" ]; then
    log "agent-sync: manifest body decode failed"
    exec 9>&-
    return 1
  fi

  # Hash-chain anti-replay (with bootstrap exception for fresh servers).
  local remote_prev
  remote_prev=$(jq -r '.previousVersion // "null"' <<< "$manifest")
  if ! agent_sync_chain_check "$LOCAL_MV" "$remote_prev" "$remote_mv"; then
    exec 9>&-
    return 1
  fi

  # Crash-safety: trust .agent-versions.json > on-disk symlinks
  reconcile_releases_vs_state

  # Check auto-update policy (sovereignty flag)
  local auto_update="true"
  [ -f "$AGENT_AUTO_UPDATE_FILE" ] && auto_update=$(cat "$AGENT_AUTO_UPDATE_FILE" 2>/dev/null | tr -d '\n' | head -c 8)
  [[ "$auto_update" =~ ^(true|false)$ ]] || auto_update="true"

  if [ "$auto_update" = "false" ]; then
    # Manual mode: stage + verify bundles, save pending manifest, no flip.
    local any_stage_failure=false
    while IFS= read -r entry; do
      [ -z "$entry" ] && continue
      local name wanted wanted_sha wanted_format
      name=$(jq -r '.key' <<< "$entry")
      wanted=$(jq -r '.value.version' <<< "$entry")
      wanted_sha=$(jq -r '.value.sha256' <<< "$entry")
      wanted_format=$(jq -r '.value.format' <<< "$entry")

      # Skip only when BOTH version AND on-disk sha256 match. A sha256
      # drift with unchanged version forces a restage — same guardrail
      # as the auto-mode loop above.
      if agent_onDisk_matches "$name" "$wanted" "$wanted_sha" "$wanted_format"; then
        continue
      fi

      if ! stage_component "$entry"; then
        any_stage_failure=true
      fi
    done < <(jq -c '.components | to_entries | sort_by(.value.restartOrder) | .[]' <<< "$manifest")

    if $any_stage_failure; then
      post_agent_report "$LOCAL_MV" "failed" "stage failed in manual mode"
      exec 9>&-
      return 1
    fi

    # Save pending manifest for --apply-pending-update command
    printf '%s' "$manifest" > "$AGENT_PENDING_MANIFEST_FILE.new"
    chmod 0600 "$AGENT_PENDING_MANIFEST_FILE.new"
    chown root:root "$AGENT_PENDING_MANIFEST_FILE.new"
    mv -f "$AGENT_PENDING_MANIFEST_FILE.new" "$AGENT_PENDING_MANIFEST_FILE"

    post_agent_report "$LOCAL_MV" "pending_approval"
    log "agent-sync: manifest v$remote_mv staged for manual apply (autoUpdate=false)"
    exec 9>&-
    return 0
  fi

  # Auto mode: apply everything.
  local result
  result=$(apply_manifest_components "$manifest" "sync")
  local rc=$?

  if [ $rc -ne 0 ]; then
    post_agent_report "$LOCAL_MV" "failed" "component apply failure"
    exec 9>&-
    return 1
  fi

  post_agent_report "$remote_mv" "success"
  echo "$remote_mv" > "$AGENT_MANIFEST_VERSION_FILE.new"
  chmod 0600 "$AGENT_MANIFEST_VERSION_FILE.new"
  mv -f "$AGENT_MANIFEST_VERSION_FILE.new" "$AGENT_MANIFEST_VERSION_FILE"

  log "agent-sync: applied manifest v$remote_mv (was $LOCAL_MV)"

  # Clear any stale pending manifest — we just applied forward.
  rm -f "$AGENT_PENDING_MANIFEST_FILE" 2>/dev/null

  # Self-update: if ellul-env was among the applied components, we
  # need to exec into the new binary. apply_manifest_components prints
  # "__SELF_UPDATE_READY__" when that happened; here we just exec.
  if echo "$result" | grep -q '__SELF_UPDATE_READY__'; then
    log "agent-sync: self-update applied, re-exec enforcer"
    exec 9>&-
    exec /usr/local/bin/ellul-env daemon
  fi

  exec 9>&-
  return 0
}

# Apply a staged pending manifest. Invoked by the apply-pending-update
# DIRECT command handler (from poll_and_execute_commands). Re-verifies
# the hash chain (in case a newer manifest was published between stage
# and apply), runs apply_manifest_components, writes the manifest
# version file on success.
#
# Returns via stdout: "ok <version>" on success, "error <reason>" on failure.
apply_pending_update() {
  if [ ! -f "$AGENT_PENDING_MANIFEST_FILE" ]; then
    echo "error no-pending-manifest"
    return 1
  fi

  # Concurrency guard: share the same lock as sync_agent_bundle so a
  # user-initiated apply-pending can't race an in-flight auto sync.
  exec 9>"$AGENT_UPDATE_LOCK" || { echo "error lock-open-failed"; return 1; }
  if ! flock -w 30 9; then
    echo "error lock-busy"
    return 1
  fi

  local manifest
  manifest=$(cat "$AGENT_PENDING_MANIFEST_FILE" 2>/dev/null)
  if [ -z "$manifest" ]; then
    echo "error pending-manifest-empty"
    return 1
  fi

  local LOCAL_MV=0
  [ -f "$AGENT_MANIFEST_VERSION_FILE" ] && LOCAL_MV=$(tr -d '\n' < "$AGENT_MANIFEST_VERSION_FILE" | head -c 16)
  [[ "$LOCAL_MV" =~ ^[0-9]+$ ]] || LOCAL_MV=0

  local remote_mv remote_prev
  remote_mv=$(jq -r '.version // empty' <<< "$manifest")
  remote_prev=$(jq -r '.previousVersion // "null"' <<< "$manifest")

  if ! [[ "$remote_mv" =~ ^[0-9]+$ ]]; then
    echo "error bad-version"
    return 1
  fi
  if [ "$remote_mv" -le "$LOCAL_MV" ]; then
    echo "error stale"
    return 1
  fi
  # Same chain rule as sync_agent_bundle — fresh server bootstrap is
  # accepted, established servers must match prev==local exactly.
  if ! agent_sync_chain_check "$LOCAL_MV" "$remote_prev" "$remote_mv"; then
    echo "error chain-mismatch"
    return 1
  fi

  # Crash-safety pass before applying
  reconcile_releases_vs_state

  # Wall-clock budget on the whole apply. apply_manifest_components
  # already bounds each systemctl restart via wait_unit_active 30, but
  # a pathological manifest with many components could still exceed the
  # command-queue timeout. Abort early if we blow past the budget.
  local _apply_start=$SECONDS
  local _apply_budget=480   # 8 min — matches the 600s command timeout less buffer

  local result
  result=$(apply_manifest_components "$manifest")
  local rc=$?

  if [ $(( SECONDS - _apply_start )) -gt $_apply_budget ]; then
    log "agent-sync: pending apply exceeded ${_apply_budget}s budget"
    post_agent_report "$LOCAL_MV" "failed" "apply-timeout"
    echo "error apply-timeout"
    return 1
  fi

  if [ $rc -ne 0 ]; then
    post_agent_report "$LOCAL_MV" "failed" "pending apply failure"
    echo "error apply-failed"
    return 1
  fi

  post_agent_report "$remote_mv" "success"
  echo "$remote_mv" > "$AGENT_MANIFEST_VERSION_FILE.new"
  chmod 0600 "$AGENT_MANIFEST_VERSION_FILE.new"
  mv -f "$AGENT_MANIFEST_VERSION_FILE.new" "$AGENT_MANIFEST_VERSION_FILE"

  rm -f "$AGENT_PENDING_MANIFEST_FILE"
  log "agent-sync: pending manifest v$remote_mv applied"

  # Self-update re-exec
  if echo "$result" | grep -q '__SELF_UPDATE_READY__'; then
    echo "ok $remote_mv self-update-exec"
    exec /usr/local/bin/ellul-env daemon
  fi

  echo "ok $remote_mv"
  return 0
}

# ── Self-test + introspect entry points

# Called via `bash $staged_binary --self-test` from _apply_self_update
# before the symlink flip. Validates that THIS binary can actually run
# the sync loop. Because the staged binary is fully sourced at this
# point, checking for required functions catches the "parses cleanly
# but broke the sync logic" failure mode for free. The pre-existing
# crypto binary isn't re-validated — it hasn't changed.
run_self_test() {
  # 1. constants sourced, critical paths set
  [ -n "$AGENT_INSTALLED_FILE" ] || exit 10
  [ -n "$COMMAND_SIGNING_PUBKEY_FILE" ] || exit 10
  [ -n "$AGENT_RELEASES_ROOT" ] || exit 10
  [ -n "$AGENT_PENDING_COMMIT_FILE" ] || exit 10

  # 2. tools + files present
  [ -x /usr/bin/jq ] || exit 11
  [ -x "$CRYPTO_BIN" ] || exit 12
  [ -f "$COMMAND_SIGNING_PUBKEY_FILE" ] || exit 13

  # 3. pubkey file parses as JSON with mldsa_pk field
  /usr/bin/jq -e '.mldsa_pk' "$COMMAND_SIGNING_PUBKEY_FILE" >/dev/null 2>&1 || exit 14

  # 4. required functions defined — catches refactor bugs that would
  #    brick the sync loop silently.
  local fn
  for fn in sync_agent_bundle apply_manifest_components apply_component \
            stage_component _apply_self_update _apply_component_rollback \
            agent_sync_recover_from_crash agent_sync_commit_pending \
            agent_sync_seed_baseline \
            verify_jws_ml_dsa65 verify_jws_ml_dsa65_ring verify_mldsa65_ring \
            parse_keyring decode_jws_body post_agent_report \
            apply_pending_update agent_sync_chain_check; do
    if [ "$(type -t "$fn" 2>/dev/null)" != "function" ]; then
      echo "self-test: missing function $fn" >&2
      exit 15
    fi
  done

  # 5. vault paths resolvable
  [ -d /etc/ellul/shield-data ] || exit 16

  # 6. lock file acquirable (test + release, separate lock from the
  #    real sync loop's so a concurrent sync doesn't false-positive).
  ( flock -n 9 && true ) 9>/var/lock/ellul-self-test.lock 2>/dev/null || exit 17
  rm -f /var/lock/ellul-self-test.lock

  # 7. agent_sync_chain_check truth table — runs in-process so the
  #    self-test catches any future regression of the bootstrap path
  #    that left fresh boxes permanently stuck on the canary chain.
  if ! run_chain_check_tests >/dev/null 2>&1; then
    echo "self-test: agent_sync_chain_check truth table failed" >&2
    exit 18
  fi

  echo "self-test: ok"
  return 0
}

## Truth table for agent_sync_chain_check. Suppresses `log` output so
## the test runs cleanly inside `run_self_test`; callers that want to
## see the trace should call directly.
##
## Cases:
##   1. Fresh box, current head with chained prev   → accept (bootstrap)
##   2. Fresh box, genesis manifest                  → accept
##   3. Established box, prev matches local          → accept
##   4. Established box, genesis manifest             → reject (downgrade)
##   5. Established box, prev mismatch                → reject (chain break)
##   6. Established box at version N, manifest with prev = N+5 → reject
run_chain_check_tests() {
  # Silence the chain check's own log() during tests by shadowing it
  # in this subshell scope. The real log() function continues to work
  # for production calls because we restore on exit.
  local _orig_log
  _orig_log=$(declare -f log 2>/dev/null || true)
  log() { :; }

  local fail=0

  _expect_chain_ok() {
    local desc="$1" local_mv="$2" remote_prev="$3" remote_mv="$4"
    if agent_sync_chain_check "$local_mv" "$remote_prev" "$remote_mv"; then
      return 0
    fi
    echo "chain-test FAIL ($desc): expected ACCEPT, got REJECT (local=$local_mv prev=$remote_prev mv=$remote_mv)" >&2
    fail=$((fail + 1))
    return 1
  }

  _expect_chain_reject() {
    local desc="$1" local_mv="$2" remote_prev="$3" remote_mv="$4"
    if ! agent_sync_chain_check "$local_mv" "$remote_prev" "$remote_mv"; then
      return 0
    fi
    echo "chain-test FAIL ($desc): expected REJECT, got ACCEPT (local=$local_mv prev=$remote_prev mv=$remote_mv)" >&2
    fail=$((fail + 1))
    return 1
  }

  _expect_chain_ok     "bootstrap to chained head"      0  19   20
  _expect_chain_ok     "bootstrap to genesis"           0  null  1
  _expect_chain_ok     "established normal advance"    19  19   20
  _expect_chain_reject "established rejects genesis"   19  null  1
  _expect_chain_reject "established rejects skip"      19  21   22
  _expect_chain_reject "established rejects backwards" 19  17   18

  # Restore the original log function (or remove the override).
  unset -f log
  if [ -n "$_orig_log" ]; then
    eval "$_orig_log"
  fi

  return $fail
}

# Called via `ellul-env --introspect`. Prints a JSON blob describing
# this binary's version + capabilities + signing key fingerprint.
# Useful for ops, compatibility checks, and diffing what's deployed.
run_introspect() {
  local installed_ver fingerprint
  installed_ver=$(agent_installed_version "ellul-env")
  [ -z "$installed_ver" ] && installed_ver="unknown"

  fingerprint="unknown"
  if [ -f "$COMMAND_SIGNING_PUBKEY_FILE" ]; then
    fingerprint=$(jq -r '.mldsa_pk // empty' "$COMMAND_SIGNING_PUBKEY_FILE" 2>/dev/null | sha256sum | cut -d' ' -f1 | head -c 16)
  fi

  cat <<EOF
{
  "version": "$installed_ver",
  "capabilities": ["agent-sync", "jws-verify", "jws-verify-ring", "entitlement-pull", "apply-pending-update", "block-migrate", "self-test", "introspect"],
  "signingKeyFingerprint": "$fingerprint"
}
EOF
}
