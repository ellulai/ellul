#!/bin/bash
# ellul-preview-ctl — scoped wrapper for preview systemd control.
#
# Installed mode 0755, root:root, chattr +i. Invoked by file-api via:
#   sudo /usr/local/bin/ellul-preview-ctl <action> <instance>
# where <instance> is the systemd-escaped app path.
#
# Sudoers (/etc/sudoers.d/ellul-preview-units) grants the SVC_USER
# NOPASSWD access to THIS wrapper only — never to systemctl directly.

set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

if [ $# -lt 2 ]; then
  echo "ellul-preview-ctl: usage: <start|stop|restart|is-active|reset-failed|status|kill|dropin|clear-dropin> <instance> [args...]" >&2
  exit 1
fi

ACTION="$1"
INSTANCE="$2"

case "$ACTION" in
  start|stop|restart|is-active|reset-failed|status|kill|dropin|clear-dropin) ;;
  *)
    /usr/bin/logger -t ellul-preview-ctl -p auth.warning "REJECTED action '$ACTION' from uid=$(id -u)"
    echo "ellul-preview-ctl: blocked action '$ACTION'" >&2
    exit 1
    ;;
esac

# systemd-escape's output character class is exactly [A-Za-z0-9._\\:@-]+.
# The backslash-x escapes for hex bytes produce \\x2d which is valid
# under that class (letters + digits). Anything outside is either a
# programmer error (passing the unescaped app path directly) or a path
# injection attempt.
if [[ ! "$INSTANCE" =~ ^[A-Za-z0-9._\\:@-]+$ ]]; then
  /usr/bin/logger -t ellul-preview-ctl -p auth.warning "REJECTED instance '$INSTANCE' from uid=$(id -u)"
  echo "ellul-preview-ctl: invalid instance name" >&2
  exit 1
fi

UNIT="ellul-preview@${INSTANCE}.service"

# is-active returns 3 on "not active", which is not a failure for the
# caller. Propagate the exit code so the file-api wrapper can read it.
if [ "$ACTION" = "is-active" ]; then
  /bin/systemctl is-active --quiet "$UNIT"
  exit $?
fi

# `kill` is the admission controller's pressure-driven eviction path.
# Three steps, in order:
#
#   1. SIGKILL every process in the cgroup immediately. No SIGTERM
#      grace window — the caller picked `kill` precisely because the
#      incoming preview can't wait for graceful shutdown.
#
#   2. `reset-failed` clears the failed sentinel so StartLimitBurst
#      doesn't refuse a future start of the same instance.
#
#   3. `stop` is what actually tells systemd "this unit is intentionally
#      terminated — do NOT honor `Restart=on-failure`". Without it,
#      systemd treats the SIGKILL-induced exit as a crash and restarts
#      the unit after RestartSec seconds, which is how an eviction
#      turns into a doom loop: the drained memory gets immediately
#      re-consumed by the restarted victim, the drain target is never
#      reached, admission times out, the new preview never starts, and
#      the user sees "Live Preview — waiting for dev server" forever.
#      The stop call is near-instant because the cgroup is already
#      empty from step 1.
if [ "$ACTION" = "kill" ]; then
  /bin/systemctl kill --kill-who=all -s KILL "$UNIT" 2>/dev/null || true
  /bin/systemctl reset-failed "$UNIT" 2>/dev/null || true
  /bin/systemctl stop "$UNIT"
  exit $?
fi

# `dropin` writes a per-instance systemd drop-in with framework-sized
# resource caps. The additional args are a whitelist of known directive
# names + numeric values — no shell interpolation, no arbitrary unit
# text. Reload via daemon-reload so the next start picks them up.
#
#   ellul-preview-ctl dropin <instance> <MemoryHigh-MB> <MemoryMax-MB> <TasksMax> <CPUQuotaPercent>
#
# Empty string for any slot skips that directive. Writes to
# /run/systemd/system/ellul-preview@<inst>.service.d/10-framework.conf
# (volatile tmpfs path; the per-instance caps are rewritten on every
# preview start, no persistence needed).
if [ "$ACTION" = "dropin" ]; then
  if [ $# -ne 6 ]; then
    echo "ellul-preview-ctl: dropin takes exactly 4 numeric args (memHighMB memMaxMB tasksMax cpuQuotaPct)" >&2
    exit 1
  fi
  MEM_HIGH="$3"; MEM_MAX="$4"; TASKS="$5"; CPUQ="$6"
  # Strict numeric validation — anything else is a programmer error or
  # an injection attempt.
  for v in "$MEM_HIGH" "$MEM_MAX" "$TASKS" "$CPUQ"; do
    if [ -n "$v" ] && ! [[ "$v" =~ ^[0-9]+$ ]]; then
      /usr/bin/logger -t ellul-preview-ctl -p auth.warning "REJECTED dropin arg '$v'"
      echo "ellul-preview-ctl: dropin arg must be numeric or empty" >&2
      exit 1
    fi
  done
  # /run/systemd/system is the runtime drop-in path systemd reads alongside
  # /etc/systemd/system/<unit>.d/. Tmpfs, root:root 0755, volatile across
  # reboots — smaller blast radius than /etc and per-instance caps are
  # rewritten on every preview start anyway. Lets file-api keep its
  # ProtectSystem=strict on /etc with a narrower ReadWritePaths grant.
  DROPIN_DIR="/run/systemd/system/ellul-preview@${INSTANCE}.service.d"
  DROPIN_FILE="$DROPIN_DIR/10-framework.conf"
  mkdir -p "$DROPIN_DIR"
  {
    echo "# Written by ellul-preview-ctl for framework-aware sizing."
    echo "[Service]"
    [ -n "$MEM_HIGH" ] && echo "MemoryHigh=${MEM_HIGH}M"
    [ -n "$MEM_MAX" ]  && echo "MemoryMax=${MEM_MAX}M"
    [ -n "$TASKS" ]    && echo "TasksMax=${TASKS}"
    [ -n "$CPUQ" ]     && echo "CPUQuota=${CPUQ}%"
  } > "$DROPIN_FILE"
  chmod 0644 "$DROPIN_FILE"
  /bin/systemctl daemon-reload
  exit 0
fi

if [ "$ACTION" = "clear-dropin" ]; then
  # /run/systemd/system is the runtime drop-in path systemd reads alongside
  # /etc/systemd/system/<unit>.d/. Tmpfs, root:root 0755, volatile across
  # reboots — smaller blast radius than /etc and per-instance caps are
  # rewritten on every preview start anyway. Lets file-api keep its
  # ProtectSystem=strict on /etc with a narrower ReadWritePaths grant.
  DROPIN_DIR="/run/systemd/system/ellul-preview@${INSTANCE}.service.d"
  rm -f "$DROPIN_DIR/10-framework.conf"
  rmdir "$DROPIN_DIR" 2>/dev/null || true
  /bin/systemctl daemon-reload
  exit 0
fi

exec /bin/systemctl "$ACTION" "$UNIT"
