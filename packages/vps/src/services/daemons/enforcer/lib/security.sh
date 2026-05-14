#!/bin/bash
# Enforcer Security Functions
# Security tier detection, identity pinning, and lockdown.

# Detect security tier.
#
# Reads the explicit tier file written by the API during tier transitions.
# Does NOT infer tier from LUKS or encryption state — all volumes are now
# encrypted by default, so /dev/mapper/luks-home always exists and cannot
# distinguish between managed encryption (standard/web_lock) and user-initiated
# Privacy Lock (private_locked).
#
# The tier file is authoritative. It's written by:
# - update-identity during provisioning/wake
# - tier transition commands from the API
# - Persisted in the vault across hibernate/wake
#
# Fallback: if no tier file exists, detect from system state (legacy compat).
detect_security_tier() {
  # Primary: read explicit tier file (authoritative)
  local TIER_FILE="/etc/ellul/security-tier"
  if [ -f "$TIER_FILE" ]; then
    local FILE_TIER
    FILE_TIER=$(cat "$TIER_FILE" 2>/dev/null | tr -d '[:space:]')
    case "$FILE_TIER" in
      standard|web_locked|private_locked)
        echo "$FILE_TIER"
        return 0
        ;;
    esac
  fi

  # Fallback: detect from system state (only for servers without tier file)
  local SHIELD_ACTIVE="inactive"
  svc_is_active ellul-sovereign-shield && SHIELD_ACTIVE="active"
  local HAS_PASSKEY=false

  local CRED_COUNT=0
  if [ -f "/etc/ellul/shield-data/local-auth.db" ] && [ -s "/etc/ellul/shield-data/local-auth.db" ]; then
    CRED_COUNT=$(node -e "try{const d=require('/opt/ellul/auth/node_modules/better-sqlite3')('/etc/ellul/shield-data/local-auth.db',{readonly:true});console.log(d.prepare('SELECT COUNT(*) as c FROM credential').get().c)}catch(e){console.log(0)}" 2>/dev/null || echo "0")
  fi
  if [ "$CRED_COUNT" -gt 0 ]; then
    HAS_PASSKEY=true
  fi

  # Web Locked: Shield active with passkey registered (no auto-promote to private_locked)
  if [ "$SHIELD_ACTIVE" = "active" ] && [ "$HAS_PASSKEY" = "true" ]; then
    echo "web_locked"
  else
    echo "standard"
  fi
}

# Persist heartbeat failure counter across restarts
load_failure_count() {
  if [ -f "$HEARTBEAT_FAILURE_FILE" ]; then
    cat "$HEARTBEAT_FAILURE_FILE" 2>/dev/null || echo "0"
  else
    echo "0"
  fi
}

save_failure_count() {
  echo "$1" > "$HEARTBEAT_FAILURE_FILE"
}

reset_failure_count() {
  rm -f "$HEARTBEAT_FAILURE_FILE" 2>/dev/null || true
}

# Phase 4: verify_owner() REMOVED. Owner.lock is set once during cloud-init
# provisioning and is immutable (chattr +i). The API can no longer inject a
# userId that would trigger ownership lockdown. Identity pinning is still
# enforced -- it's just set at boot, not verified against API on every heartbeat.

# Phase 7: Enforce Caddy directory ownership and permissions.
# Auto-remediates if a package upgrade or manual change drifts permissions.
# Caddy dirs must be caddy:caddy 2770 (SGID) -- agent must NOT have access.
enforce_caddy_permissions() {
  local NEEDS_FIX=false

  for dir in /etc/caddy /etc/caddy/sites-enabled /etc/caddy/app-routes.d; do
    if [ -d "$dir" ]; then
      local owner=$(stat -c '%U:%G' "$dir" 2>/dev/null)
      local perms=$(stat -c '%a' "$dir" 2>/dev/null)
      if [ "$owner" != "caddy:caddy" ] || [ "$perms" != "2770" ]; then
        chown caddy:caddy "$dir"
        chmod 2770 "$dir"
        NEEDS_FIX=true
        log "caddy dir permissions fixed: $dir ($owner/$perms → caddy:caddy/2770)"
      fi
    fi
  done

  # Admin socket directory
  if [ -d "/run/caddy" ]; then
    local owner=$(stat -c '%U:%G' /run/caddy 2>/dev/null)
    local perms=$(stat -c '%a' /run/caddy 2>/dev/null)
    if [ "$owner" != "caddy:caddy" ] || [ "$perms" != "2770" ]; then
      chown caddy:caddy /run/caddy
      chmod 2770 /run/caddy
      NEEDS_FIX=true
      log "caddy socket dir permissions fixed: /run/caddy"
    fi
  fi

  # Verify Caddyfile ownership AND mode (caddy:caddy 664 -- owner rw, group rw,
  # others none under parent dir 2770). 664 (not 640) so shield-runner (in
  # caddy group via SupplementaryGroups) can regenerate the file on startup;
  # the parent dir 2770 already blocks "other" from traversing, so the extra
  # group-write bit does not widen the effective access surface. See commit
  # 248c5cab: every other Caddyfile writer (caddy-main.sh, linux-services.sh,
  # caddy-regen.sh, heartbeat.sh, shield/main.ts, deployment.service.ts) was
  # moved to 664 — this enforcer hook was the missing one, and was silently
  # downgrading 664→640 every 60s and breaking shield's caddyfile-regen with
  # EACCES on every boot.
  if [ -f "/etc/caddy/Caddyfile" ]; then
    local cf_owner=$(stat -c '%U:%G' /etc/caddy/Caddyfile 2>/dev/null)
    local cf_perms=$(stat -c '%a' /etc/caddy/Caddyfile 2>/dev/null)
    if [ "$cf_owner" != "caddy:caddy" ]; then
      chown caddy:caddy /etc/caddy/Caddyfile
      NEEDS_FIX=true
      log "Caddyfile ownership fixed: $cf_owner → caddy:caddy"
    fi
    if [ "$cf_perms" != "664" ]; then
      chmod 664 /etc/caddy/Caddyfile
      NEEDS_FIX=true
      log "Caddyfile mode fixed: $cf_perms → 664"
    fi
  fi

  if [ "$NEEDS_FIX" = "true" ]; then
    log "caddy permissions remediated"
  fi

  # Self-heal /etc/ellul/deployment-model from /opt/ellul/metadata.json. This
  # file is the canonical input for shield's caddyfile-regen and the heartbeat
  # reconfigure-caddy-domain command. Boot-config writes it on first boot, but
  # existing fleets that pick up the new shield/heartbeat binaries via release
  # before reprovisioning would otherwise fall through to firewall-mode (an
  # unrelated ironclad value) and pick the wrong Caddyfile shape. Run as root,
  # idempotent, mode 644 to match boot-config.
  if [ -f /opt/ellul/metadata.json ]; then
    local DM_RAW DM_NORM
    DM_RAW=$(jq -r '.deployment_model // "cloudflare"' /opt/ellul/metadata.json 2>/dev/null)
    case "$DM_RAW" in
      cloudflare|gateway|proxied) DM_NORM="proxied" ;;
      direct) DM_NORM="direct" ;;
      *) DM_NORM="proxied" ;;
    esac
    local DM_CURRENT=""
    [ -f /etc/ellul/deployment-model ] && DM_CURRENT=$(cat /etc/ellul/deployment-model 2>/dev/null)
    if [ "$DM_CURRENT" != "$DM_NORM" ]; then
      printf '%s\n' "$DM_NORM" > /etc/ellul/deployment-model
      chmod 644 /etc/ellul/deployment-model
      chown root:root /etc/ellul/deployment-model
      log "deployment-model self-healed: '${DM_CURRENT}' → '${DM_NORM}' (from metadata)"
    fi
  fi
}

# Get SSH key count from authorized_keys (root-owned path)
get_ssh_key_count() {
  local AUTH_KEYS="/etc/ssh/authorized_keys/${PS_USER:-dev}"
  if [ -f "$AUTH_KEYS" ] && [ -s "$AUTH_KEYS" ]; then
    grep -c '^ssh-' "$AUTH_KEYS" 2>/dev/null || echo "0"
  else
    echo "0"
  fi
}

# ═══════════════════════════════════════════════════════════════════════
# Security Invariant Enforcement
# ═══════════════════════════════════════════════════════════════════════
# Detects and auto-remediates configuration drift from the provisioning spec.
# Deployment failures are architecture failures unless the architecture
# detects and self-corrects them. These checks run every 60s.
# Pattern: check → log → remediate → verify.

SECURITY_INVARIANT_LAST=0
SECURITY_VIOLATION_COUNT=0
SECURITY_CRITICAL_COUNT=0
SECURITY_WARNING_COUNT=0
SECURITY_CONSECUTIVE_FAILURES=0
SECURITY_DEGRADED=false

# Extract leaked secrets from /etc/default/ellul into the root-only secrets file.
# The readable env file must NEVER contain JWT_SECRET or AI_PROXY_TOKEN keys.
_remediate_env_secrets() {
  local ENV_FILE="/etc/default/ellul"
  local SECRETS_FILE="/etc/default/ellul-secrets"
  local TEMP_ENV TEMP_SECRETS

  TEMP_ENV=$(mktemp /tmp/.env-clean-XXXXXX)
  TEMP_SECRETS=$(mktemp /tmp/.env-secrets-XXXXXX)
  chmod 600 "$TEMP_ENV" "$TEMP_SECRETS"

  # Seed secrets file with existing content
  [ -f "$SECRETS_FILE" ] && cat "$SECRETS_FILE" > "$TEMP_SECRETS"

  while IFS= read -r line || [ -n "$line" ]; do
    local IS_SECRET=false
    for key in JWT_SECRET ELLUL_JWT_SECRET AI_PROXY_TOKEN ELLUL_AI_PROXY_TOKEN ELLUL_AI_TOKEN; do
      if echo "$line" | grep -qE "^${key}="; then
        # Only append if not already in secrets file
        if ! grep -qE "^${key}=" "$TEMP_SECRETS" 2>/dev/null; then
          echo "$line" >> "$TEMP_SECRETS"
        fi
        IS_SECRET=true
        break
      fi
    done
    if [ "$IS_SECRET" = false ]; then
      echo "$line" >> "$TEMP_ENV"
    fi
  done < "$ENV_FILE"

  # Atomic replacement
  cat "$TEMP_ENV" > "$ENV_FILE"
  cat "$TEMP_SECRETS" > "$SECRETS_FILE"
  rm -f "$TEMP_ENV" "$TEMP_SECRETS"

  chmod 644 "$ENV_FILE"
  chown root:root "$ENV_FILE"
  chmod 600 "$SECRETS_FILE"
  chown root:root "$SECRETS_FILE"

  log "SECURITY: secrets extracted from $ENV_FILE → $SECRETS_FILE"

  # Restart services that may have cached the leaked secrets in memory.
  # The enforcer itself runs as root and reads from EnvironmentFile at startup,
  # so any secrets it loaded from the old env file persist in its process env.
  # Sovereign-shield reads jwt-secret from /etc/ellul/ directly (not env file),
  # but restart it too to clear any stale env inheritance.
  log "SECURITY: restarting services to purge stale secrets from process memory"
  svc_restart ellul-sovereign-shield 2>/dev/null || true
  svc_restart ellul-file-api 2>/dev/null || true
  svc_restart ellul-agent-bridge 2>/dev/null || true
  # NOTE: The enforcer itself (this process) loaded the EnvironmentFile at startup.
  # We schedule a deferred self-restart so the current heartbeat cycle completes first.
  # The systemd Restart=always policy ensures we come back with the clean env.
  DEFERRED_ENFORCER_RESTART=true
}

# Recompile seccomp binary from source if missing.
# Source integrity: the provisioning payload writes seccomp-exec.c and sets it
# immutable (chattr +i). If the immutable bit is missing, we restore it BEFORE
# compiling. If the source file itself is missing, we cannot safely recompile —
# a tampered source would produce a binary that appears to work but allows
# dangerous syscalls through.
_recompile_seccomp() {
  local SRC="/opt/ellul/seccomp-exec.c"
  local BIN="/usr/local/bin/ellul-seccomp-exec"

  if [ ! -f "$SRC" ]; then
    log "SECURITY CRITICAL: seccomp source not found at $SRC — cannot recompile"
    return 1
  fi

  # Verify source integrity: immutable bit should be set by provisioning.
  # If missing, restore it. This prevents a compromised root process from
  # modifying the source to weaken the syscall filter.
  if ! lsattr "$SRC" 2>/dev/null | grep -q 'i'; then
    chattr +i "$SRC" 2>/dev/null || true
    log "SECURITY: seccomp source immutable bit restored"
  fi

  # Install build deps if needed (apt lock timeout prevents contention)
  dpkg -s libseccomp-dev >/dev/null 2>&1 || \
    apt-get install -y -qq -o DPkg::Lock::Timeout=30 libseccomp-dev >/dev/null 2>&1 || true

  # Temporarily remove immutable for compilation (gcc reads, doesn't write, but
  # chattr -i is needed if we ever need to update the source via provisioning)
  if gcc -o "$BIN" "$SRC" -lseccomp -O2 -Wall -Wextra -Werror \
    -D_FORTIFY_SOURCE=2 -fstack-protector-strong -Wl,-z,relro,-z,now 2>/dev/null; then
    chmod 755 "$BIN"
    # Self-test: run /bin/true through seccomp filter
    if "$BIN" /bin/true 2>/dev/null; then
      log "SECURITY: seccomp binary recompiled and verified"
    else
      rm -f "$BIN"
      log "SECURITY CRITICAL: seccomp binary failed self-test after recompilation"
      return 1
    fi
  else
    rm -f "$BIN" 2>/dev/null
    log "SECURITY CRITICAL: seccomp compilation failed — agent execution will be blocked"
    return 1
  fi
}

# Periodic security invariant enforcement.
# Called from heartbeat loop. Internal 60s cooldown.
#
# Severity levels:
#   CRITICAL — control plane integrity compromised (secret leak, missing seccomp,
#              shield on wrong interface). Requires immediate remediation.
#   WARNING  — permission drift, missing immutable bits. Important but not an
#              active exploit path on its own.
#
# Quarantine: if CRITICAL violations persist across 3 consecutive check cycles
# (remediation keeps failing), the server is marked degraded. The heartbeat
# payload includes this flag so the API can exclude it from workload scheduling.
#
# Trust amplifier privilege reduction (agent-bridge shield-ipc, file-api caddy
# group access) is deferred to a subsequent phase. This function validates
# inputs at the boundary; privilege scoping requires systemd unit changes
# and careful testing of the git/deploy/preview workflows that depend on
# those group memberships.
check_security_invariants() {
  local NOW
  NOW=$(date +%s)
  if [ $(( NOW - SECURITY_INVARIANT_LAST )) -lt 60 ]; then
    return
  fi
  SECURITY_INVARIANT_LAST=$NOW

  local VIOLATIONS=0
  local CRITICAL=0
  local WARNING=0

  # ── CHECK 1 [CRITICAL]: /etc/default/ellul must NOT contain secret keys ──
  # Secrets belong in /etc/default/ellul-secrets (600 root:root).
  # This catches the known provisioning bug where older payloads merged everything.
  if [ -f /etc/default/ellul ]; then
    if grep -qE '^(JWT_SECRET|ELLUL_JWT_SECRET|AI_PROXY_TOKEN|ELLUL_AI_PROXY_TOKEN|ELLUL_AI_TOKEN)=' /etc/default/ellul 2>/dev/null; then
      log "SECURITY CRITICAL: /etc/default/ellul contains secret keys — remediating"
      VIOLATIONS=$((VIOLATIONS + 1))
      CRITICAL=$((CRITICAL + 1))
      _remediate_env_secrets
    fi
  fi

  # ── CHECK 2 [WARNING]: /etc/default/ellul-secrets permissions ──
  if [ -f /etc/default/ellul-secrets ]; then
    local PERMS OWNER
    PERMS=$(stat -c '%a' /etc/default/ellul-secrets 2>/dev/null)
    OWNER=$(stat -c '%U:%G' /etc/default/ellul-secrets 2>/dev/null)
    if [ "$PERMS" != "600" ] || [ "$OWNER" != "root:root" ]; then
      log "SECURITY WARNING: /etc/default/ellul-secrets perms drift ($PERMS $OWNER) — fixing"
      chmod 600 /etc/default/ellul-secrets
      chown root:root /etc/default/ellul-secrets
      VIOLATIONS=$((VIOLATIONS + 1))
      WARNING=$((WARNING + 1))
    fi
  fi

  # ── CHECK 3 [WARNING]: /etc/ellul-bootstrap/ai-proxy-token permissions ──
  if [ -f /etc/ellul-bootstrap/ai-proxy-token ]; then
    local PERMS OWNER_UID OWNER_GID SHIELD_GID
    PERMS=$(stat -c '%a' /etc/ellul-bootstrap/ai-proxy-token 2>/dev/null)
    OWNER_UID=$(stat -c '%u' /etc/ellul-bootstrap/ai-proxy-token 2>/dev/null)
    OWNER_GID=$(stat -c '%g' /etc/ellul-bootstrap/ai-proxy-token 2>/dev/null)
    SHIELD_GID=$(getent group shield 2>/dev/null | cut -d: -f3 || echo "")
    if [ "$PERMS" != "640" ] || [ "$OWNER_UID" != "0" ] || [ -n "$SHIELD_GID" -a "$OWNER_GID" != "$SHIELD_GID" ]; then
      chmod 640 /etc/ellul-bootstrap/ai-proxy-token
      chown root:shield /etc/ellul-bootstrap/ai-proxy-token
      log "SECURITY WARNING: ai-proxy-token perms fixed ($PERMS uid=$OWNER_UID → 640 root:shield)"
      VIOLATIONS=$((VIOLATIONS + 1))
      WARNING=$((WARNING + 1))
    fi
  fi

  # ── CHECK 4 [WARNING]: /etc/ellul/jwt-secret permissions ──
  if [ -f /etc/ellul/jwt-secret ]; then
    local PERMS
    PERMS=$(stat -c '%a' /etc/ellul/jwt-secret 2>/dev/null)
    if [ "$PERMS" != "640" ]; then
      chmod 640 /etc/ellul/jwt-secret
      # shield-ipc group — only shield + agent-bridge/file-api processes can read
      chown root:shield-ipc /etc/ellul/jwt-secret 2>/dev/null || chown root:root /etc/ellul/jwt-secret
      log "SECURITY WARNING: jwt-secret perms fixed ($PERMS → 640)"
      VIOLATIONS=$((VIOLATIONS + 1))
      WARNING=$((WARNING + 1))
    fi
  fi

  # ── CHECK 5 [CRITICAL]: seccomp binary exists and is executable (Linux only) ──
  if [ "$IS_MACOS" != true ]; then
    if [ ! -x /usr/local/bin/ellul-seccomp-exec ]; then
      log "SECURITY CRITICAL: seccomp binary missing — attempting recompilation"
      VIOLATIONS=$((VIOLATIONS + 1))
      CRITICAL=$((CRITICAL + 1))
      _recompile_seccomp
    fi
  fi

  # ── CHECK 6 [CRITICAL]: sovereign-shield bound to 127.0.0.1 only ──
  if [ "$IS_MACOS" != true ] && command -v ss &>/dev/null; then
    local SHIELD_LISTEN
    SHIELD_LISTEN=$(ss -tlnH sport = :3005 2>/dev/null | grep -v '127\.0\.0\.1' | grep -v '::1' || true)
    if [ -n "$SHIELD_LISTEN" ]; then
      log "SECURITY CRITICAL: sovereign-shield listening on non-localhost interface"
      VIOLATIONS=$((VIOLATIONS + 1))
      CRITICAL=$((CRITICAL + 1))
      svc_restart ellul-sovereign-shield
    fi
  fi

  # ── CHECK 7 [WARNING]: owner.lock immutable bit ──
  if [ -f /etc/ellul/owner.lock ] && [ -s /etc/ellul/owner.lock ]; then
    if ! lsattr /etc/ellul/owner.lock 2>/dev/null | grep -q 'i'; then
      chattr +i /etc/ellul/owner.lock 2>/dev/null || true
      log "SECURITY WARNING: owner.lock immutable bit restored"
      VIOLATIONS=$((VIOLATIONS + 1))
      WARNING=$((WARNING + 1))
    fi
  fi

  # ── CHECK 8 [WARNING]: sshd config immutable bit ──
  if [ -f /etc/ssh/sshd_config.d/ellul.conf ]; then
    if ! lsattr /etc/ssh/sshd_config.d/ellul.conf 2>/dev/null | grep -q 'i'; then
      chattr +i /etc/ssh/sshd_config.d/ellul.conf 2>/dev/null || true
      log "SECURITY WARNING: sshd config immutable bit restored"
      VIOLATIONS=$((VIOLATIONS + 1))
      WARNING=$((WARNING + 1))
    fi
  fi

  # ── CHECK 9 [WARNING]: File integrity monitoring ──
  # Compares SHA-256 checksums of critical files against baseline.
  # Baseline generated on first run; violations indicate tampering.
  if [ "$IS_MACOS" != true ] && [ -x /usr/local/bin/ellul-file-integrity ]; then
    local FIM_RESULT
    FIM_RESULT=$(/usr/local/bin/ellul-file-integrity check 2>/dev/null || echo '{"violations":0,"status":"error"}')
    local FIM_VIOLATIONS
    FIM_VIOLATIONS=$(echo "$FIM_RESULT" | grep -o '"violations":[0-9]*' | grep -o '[0-9]*' || echo "0")
    if [ "$FIM_VIOLATIONS" -gt 0 ]; then
      log "SECURITY WARNING: File integrity check found $FIM_VIOLATIONS modified files"
      VIOLATIONS=$((VIOLATIONS + FIM_VIOLATIONS))
      WARNING=$((WARNING + FIM_VIOLATIONS))
    fi
  fi

  # ── Violation accounting and quarantine logic ──
  if [ $VIOLATIONS -gt 0 ]; then
    log "SECURITY: $VIOLATIONS violations ($CRITICAL critical, $WARNING warning) detected and remediated"
    SECURITY_VIOLATION_COUNT=$((SECURITY_VIOLATION_COUNT + VIOLATIONS))
    SECURITY_CRITICAL_COUNT=$((SECURITY_CRITICAL_COUNT + CRITICAL))
    SECURITY_WARNING_COUNT=$((SECURITY_WARNING_COUNT + WARNING))
  fi

  # Quarantine: if CRITICAL violations persist across consecutive cycles,
  # remediation is failing. Mark the server degraded so the API can exclude
  # it from workload scheduling until manual intervention.
  if [ $CRITICAL -gt 0 ]; then
    SECURITY_CONSECUTIVE_FAILURES=$((SECURITY_CONSECUTIVE_FAILURES + 1))
    if [ $SECURITY_CONSECUTIVE_FAILURES -ge 3 ] && [ "$SECURITY_DEGRADED" = false ]; then
      SECURITY_DEGRADED=true
      log "SECURITY CRITICAL: remediation failed 3 consecutive cycles — marking server DEGRADED"
      log "SECURITY CRITICAL: agent execution may be blocked until manual intervention"
    fi
  else
    # Clean cycle — reset failure counter and clear degraded state
    if [ $SECURITY_CONSECUTIVE_FAILURES -gt 0 ]; then
      if [ "$SECURITY_DEGRADED" = true ]; then
        log "SECURITY: all critical invariants restored — clearing DEGRADED state"
      fi
      SECURITY_CONSECUTIVE_FAILURES=0
      SECURITY_DEGRADED=false
    fi
  fi
}
