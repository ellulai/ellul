#!/bin/bash
# ────────────────────────────────────────────────────────────
# File Integrity Monitoring (FIM)
#
# Generates and verifies SHA-256 checksums of critical system files.
# Run by the enforcer on each security check cycle (every 60s).
#
# Monitored paths:
#   /etc/ellul/*           — Platform config and keys
#   /usr/local/bin/ellul-* — Platform binaries
#   /etc/systemd/system/ellul-* — Service units
#   /etc/ssh/sshd_config.d/  — SSH configuration
#   /opt/ellul/seccomp-*   — Seccomp filters
#
# Excluded from monitoring:
#   *.log, *.pid, *.lock     — Runtime state files
#   /etc/ellul/access-state.json — Changes every heartbeat
#   /etc/ellul/origin-tag  — Changes on IP change
# ────────────────────────────────────────────────────────────

BASELINE_FILE="/etc/ellul/.fim-baseline"
VIOLATIONS_FILE="/tmp/.fim-violations"

# Files/patterns to exclude from monitoring (they change at runtime)
EXCLUDE_PATTERNS=(
  "access-state.json"
  "origin-tag"
  "server-status.json"
  ".fim-baseline"
  "*.log"
  "*.pid"
  "*.lock"
  "*.sock"
)

# ── Generate baseline ────────────────────────────────────────

generate_fim_baseline() {
  local baseline_tmp
  baseline_tmp=$(mktemp)

  # Collect checksums of critical files
  {
    # Platform config (excluding runtime state)
    find /etc/ellul/ -maxdepth 1 -type f 2>/dev/null | while read -r f; do
      local skip=false
      for pat in "${EXCLUDE_PATTERNS[@]}"; do
        case "$(basename "$f")" in
          $pat) skip=true; break ;;
        esac
      done
      [ "$skip" = true ] && continue
      sha256sum "$f" 2>/dev/null
    done

    # Platform binaries
    find /usr/local/bin/ -name "ellul-*" -type f 2>/dev/null | while read -r f; do
      sha256sum "$f" 2>/dev/null
    done

    # Service units
    find /etc/systemd/system/ -name "ellul-*" -type f 2>/dev/null | while read -r f; do
      sha256sum "$f" 2>/dev/null
    done

    # SSH config
    if [ -d /etc/ssh/sshd_config.d/ ]; then
      find /etc/ssh/sshd_config.d/ -type f 2>/dev/null | while read -r f; do
        sha256sum "$f" 2>/dev/null
      done
    fi

    # Seccomp filters
    find /opt/ellul/ -name "seccomp-*" -type f 2>/dev/null | while read -r f; do
      sha256sum "$f" 2>/dev/null
    done
  } | sort > "$baseline_tmp"

  mv "$baseline_tmp" "$BASELINE_FILE"
  chmod 600 "$BASELINE_FILE"
  chown root:root "$BASELINE_FILE"
}

# ── Check integrity against baseline ─────────────────────────

check_fim_integrity() {
  if [ ! -f "$BASELINE_FILE" ]; then
    # No baseline yet — generate one (first run)
    generate_fim_baseline
    echo '{"violations":0,"status":"baseline_created"}'
    return 0
  fi

  local violations=0
  local violation_details=""
  local current_tmp
  current_tmp=$(mktemp)

  # Generate current checksums using same paths as baseline
  {
    find /etc/ellul/ -maxdepth 1 -type f 2>/dev/null | while read -r f; do
      local skip=false
      for pat in "${EXCLUDE_PATTERNS[@]}"; do
        case "$(basename "$f")" in
          $pat) skip=true; break ;;
        esac
      done
      [ "$skip" = true ] && continue
      sha256sum "$f" 2>/dev/null
    done

    find /usr/local/bin/ -name "ellul-*" -type f 2>/dev/null | while read -r f; do
      sha256sum "$f" 2>/dev/null
    done

    find /etc/systemd/system/ -name "ellul-*" -type f 2>/dev/null | while read -r f; do
      sha256sum "$f" 2>/dev/null
    done

    if [ -d /etc/ssh/sshd_config.d/ ]; then
      find /etc/ssh/sshd_config.d/ -type f 2>/dev/null | while read -r f; do
        sha256sum "$f" 2>/dev/null
      done
    fi

    find /opt/ellul/ -name "seccomp-*" -type f 2>/dev/null | while read -r f; do
      sha256sum "$f" 2>/dev/null
    done
  } | sort > "$current_tmp"

  # Compare against baseline
  local diff_output
  diff_output=$(diff "$BASELINE_FILE" "$current_tmp" 2>/dev/null) || true

  if [ -n "$diff_output" ]; then
    # Parse diff output for modified/added/removed files
    local modified=""
    local added=""
    local removed=""

    while IFS= read -r line; do
      case "$line" in
        "< "*)
          # Line in baseline but not current (file removed or changed)
          local fpath
          fpath=$(echo "$line" | sed 's/^< [a-f0-9]*  //')
          removed="${removed}${fpath}\n"
          violations=$((violations + 1))
          ;;
        "> "*)
          # Line in current but not baseline (file added or changed)
          local fpath
          fpath=$(echo "$line" | sed 's/^> [a-f0-9]*  //')
          added="${added}${fpath}\n"
          violations=$((violations + 1))
          ;;
      esac
    done <<< "$diff_output"

    if [ "$violations" -gt 0 ]; then
      # Write violations for enforcer to pick up
      echo "{\"violations\":$violations,\"status\":\"integrity_violation\",\"modified\":\"$(echo -e "$added" | tr '\n' ',' | sed 's/,$//')\"}" > "$VIOLATIONS_FILE"
    fi
  fi

  rm -f "$current_tmp"

  echo "{\"violations\":$violations,\"status\":\"$([ "$violations" -eq 0 ] && echo ok || echo integrity_violation)\"}"
  return "$violations"
}

# ── Regenerate baseline (after authorized changes) ───────────

regenerate_fim_baseline() {
  generate_fim_baseline
  rm -f "$VIOLATIONS_FILE"
  echo '{"status":"baseline_regenerated"}'
}

# ── Main ─────────────────────────────────────────────────────

case "${1:-check}" in
  generate) generate_fim_baseline ;;
  check)    check_fim_integrity ;;
  regen)    regenerate_fim_baseline ;;
  *)        echo "Usage: $0 {generate|check|regen}" >&2; exit 1 ;;
esac
