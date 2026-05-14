#!/bin/bash
# Locale Reconciler (Phase 7a-NATIVE Layer 3)
#
# Propagates the user's preferred locale from the shield-side intent file
# (/etc/ellul/shield-data/user-locale, written by sovereign-shield's chat
# route on every authenticated HTML serve) to the system-wide source of
# truth (/etc/ellul/user-locale) and to /etc/environment LANG/LC_ALL.
#
# Why a filesystem marker instead of the heartbeat response body:
# Phase 4 made the heartbeat one-way (heartbeat_curl uses -o /dev/null) so
# that a compromised API cannot inject data into the VPS. Locale routing
# must respect the same invariant. Sovereign-shield is the trusted local
# authority that already validates the query-param locale against
# ALL_LOCALES at HTML serve time; the enforcer just mirrors its decision
# into root-owned files that need root to mutate.
#
# Called once per heartbeat tick from heartbeat.sh.
#
# Single source for the locale → glibc map: i18n-consts' GLIBC_LOCALE.
# The `_locale_to_glibc()` function below is emitted from that TS map
# at build time; adding a locale to ALL_LOCALES + GLIBC_LOCALE
# propagates here automatically.

# _locale_to_glibc — emitted from packages/i18n-consts/src/locales.ts
__LOCALE_TO_GLIBC_CASE__

apply_pending_locale() {
  local INTENT_FILE="/etc/ellul/shield-data/user-locale"
  local CURRENT_FILE="/etc/ellul/user-locale"

  # No intent file → nothing to apply (e.g., user has never opened the
  # chat iframe since provisioning). Provisioning seeded /etc/ellul/user-locale
  # with the initial JWT-claim value, so the system already has the right one.
  [ -f "$INTENT_FILE" ] || return 0

  local PENDING
  PENDING=$(tr -d '[:space:]' < "$INTENT_FILE" 2>/dev/null)
  [ -z "$PENDING" ] && return 0

  # Validate against ALL_LOCALES — a corrupt or attacker-modified intent
  # file should not be able to set arbitrary LANG values. The pattern
  # `__SUPPORTED_LOCALE_PATTERN__` is emitted from i18n-consts' ALL_LOCALES.
  case "$PENDING" in
    __SUPPORTED_LOCALE_PATTERN__) ;;
    *)
      log "Locale: rejecting unsupported pending value '$PENDING'"
      emit_event "locale.rejected" "value" "$PENDING" "reason" "unsupported"
      return 0
      ;;
  esac

  local GLIBC
  GLIBC=$(_locale_to_glibc "$PENDING")

  local CURRENT=""
  [ -f "$CURRENT_FILE" ] && CURRENT=$(tr -d '[:space:]' < "$CURRENT_FILE" 2>/dev/null)

  # Already in sync — fast path, runs every heartbeat.
  [ "$PENDING" = "$CURRENT" ] && return 0

  log "Locale: applying $CURRENT → $PENDING (glibc=$GLIBC)"

  # Atomic write to avoid partial reads from MOTD/bashrc on concurrent login.
  local TMP="$CURRENT_FILE.tmp.$$"
  printf '%s\n' "$PENDING" > "$TMP" 2>/dev/null || {
    emit_event "locale.applied" "old" "$CURRENT" "new" "$PENDING" "outcome" "tmpwrite_failed"
    return 0
  }
  chmod 644 "$TMP" 2>/dev/null || true
  chown root:root "$TMP" 2>/dev/null || true
  mv -f "$TMP" "$CURRENT_FILE" 2>/dev/null || {
    rm -f "$TMP" 2>/dev/null
    emit_event "locale.applied" "old" "$CURRENT" "new" "$PENDING" "outcome" "rename_failed"
    return 0
  }

  # Rewrite /etc/environment LANG/LC_ALL. Existing shells keep their
  # snapshotted LANG; new login shells inherit the new value.
  if [ -f /etc/environment ]; then
    local ENV_TMP=/etc/environment.tmp.$$
    grep -v -E '^(LANG|LC_ALL)=' /etc/environment > "$ENV_TMP" 2>/dev/null || true
    printf 'LANG=%s\n'   "$GLIBC" >> "$ENV_TMP"
    printf 'LC_ALL=%s\n' "$GLIBC" >> "$ENV_TMP"
    chmod 644 "$ENV_TMP" 2>/dev/null || true
    mv -f "$ENV_TMP" /etc/environment 2>/dev/null || rm -f "$ENV_TMP"
  fi

  emit_event "locale.applied" "old" "$CURRENT" "new" "$PENDING" "glibc" "$GLIBC" "outcome" "ok"

  # Regenerate context files so CLAUDE.md/AGENTS.md pick up the new locale
  # directive. Per-sandbox context is deferred to the agent-bridge reconciler;
  # here we refresh the global context (~/CLAUDE.md, ~/.ellul/context/global.md)
  # and each sandbox root that has an active project.
  local CTX_SCRIPT="/usr/local/bin/ellul-ctx"
  if [ -x "$CTX_SCRIPT" ]; then
    local SVC_USER
    SVC_USER=$(cat /etc/ellul/svc-user 2>/dev/null || echo "dev")
    local SVC_HOME
    SVC_HOME=$(getent passwd "$SVC_USER" | cut -d: -f6)
    local PROJ_DIR="$SVC_HOME/projects"
    if [ -d "$PROJ_DIR" ]; then
      for sandbox in "$PROJ_DIR"/sbx-*; do
        [ -d "$sandbox" ] || continue
        runuser -l "$SVC_USER" -c "$CTX_SCRIPT $sandbox base" 2>/dev/null || true
      done
    fi
  fi
}
