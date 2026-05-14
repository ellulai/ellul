#!/bin/bash
# PostgreSQL Ensure -- called by sovereign-shield via sudo
# No arguments accepted. Runs recovery + restart + readiness check.
set -uo pipefail

# Hard timeout: if we haven't recovered in 30s, give up
( sleep 30; kill -9 $$ 2>/dev/null ) &
WATCHDOG_PID=$!
trap "kill $WATCHDOG_PID 2>/dev/null" EXIT

LOGFILE="/var/log/ellul-pg-recovery.log"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [pg-ensure] $*" >> "$LOGFILE" 2>/dev/null; }

# Detect psql path dynamically (same as recovery script)
PG_VERSION=$(ls /usr/lib/postgresql/ 2>/dev/null | sort -V | tail -1)
PSQL="/usr/bin/psql"
if [ -n "$PG_VERSION" ] && [ -x "/usr/lib/postgresql/$PG_VERSION/bin/psql" ]; then
  PSQL="/usr/lib/postgresql/$PG_VERSION/bin/psql"
fi

# Step 1: Quick check -- maybe PG is already fine
if sudo -u postgres "$PSQL" -c "SELECT 1" -At &>/dev/null; then
  exit 0
fi

log "PG unavailable -- starting ensure sequence"

# Step 2: Run the full recovery script
/usr/local/bin/ellul-pg-recovery 2>>"$LOGFILE" || true

# Step 3: Detect cluster unit and restart
CLUSTER_UNIT=$(systemctl list-units --type=service --all --plain --no-legend 2>/dev/null | awk '/^postgresql@/{print $1; exit}')
if [ -n "$CLUSTER_UNIT" ]; then
  systemctl reset-failed "$CLUSTER_UNIT" 2>/dev/null || true
  systemctl restart "$CLUSTER_UNIT" 2>/dev/null || true
  log "Restarted $CLUSTER_UNIT"
else
  systemctl reset-failed postgresql 2>/dev/null || true
  systemctl restart postgresql 2>/dev/null || true
  log "Restarted postgresql (meta-service)"
fi

# Step 4: Wait for readiness (up to 10s)
for i in 1 2 3 4 5; do
  if sudo -u postgres "$PSQL" -c "SELECT 1" -At &>/dev/null; then
    log "PG recovered successfully"
    exit 0
  fi
  sleep 2
done

log "PG still unavailable after ensure sequence"
exit 1
