# ── Detect PostgreSQL version ─────────────────────────────────────
PG_VERSION=$(ls /usr/lib/postgresql/ 2>/dev/null | sort -V | tail -1)
if [ -z "$PG_VERSION" ]; then
  log "No PostgreSQL version found -- skipping"
  exit 0
fi

PG_DATA="/var/lib/postgresql/$PG_VERSION/main"
PG_BIN="/usr/lib/postgresql/$PG_VERSION/bin"

# ── Guard: no data directory = first boot ─────────────────────────
if [ ! -d "$PG_DATA" ] || [ ! -f "$PG_DATA/PG_VERSION" ]; then
  log "No data directory at $PG_DATA -- first boot, skipping"
  exit 0
fi

# ── Guard: postgres user must exist ───────────────────────────────
if ! id -u postgres &>/dev/null; then
  log "postgres user does not exist -- skipping (apt not yet run?)"
  exit 0
fi

# ── F5: Fix ownership (vault wake drift) ─────────────────────────
# Fast-check: only recurse if top-level ownership is wrong.
# Avoids O(n) stat on every invocation for large data dirs.
PG_DIR_OWNER=$(stat -c '%U:%G' /var/lib/postgresql 2>/dev/null || echo "unknown:unknown")
DATA_DIR_OWNER=""
if [ -d "$PG_DATA" ]; then
  DATA_DIR_OWNER=$(stat -c '%U:%G' "$PG_DATA" 2>/dev/null || echo "unknown:unknown")
fi
if [ "$PG_DIR_OWNER" != "postgres:postgres" ] || { [ -n "$DATA_DIR_OWNER" ] && [ "$DATA_DIR_OWNER" != "postgres:postgres" ]; }; then
  log "Ownership drift detected ($PG_DIR_OWNER / $DATA_DIR_OWNER) -- running chown -R"
  chown -R postgres:postgres /var/lib/postgresql 2>/dev/null || {
    log "WARN: chown failed -- continuing anyway"
  }
else
  log "Ownership OK ($PG_DIR_OWNER) -- skipping chown -R"
fi

# ── F4: Remove stale postmaster.pid ──────────────────────────────
PID_FILE="$PG_DATA/postmaster.pid"
if [ -f "$PID_FILE" ]; then
  STALE_PID=$(head -1 "$PID_FILE" 2>/dev/null || true)
  if [ -n "$STALE_PID" ] && ! kill -0 "$STALE_PID" 2>/dev/null; then
    log "Removing stale postmaster.pid (PID $STALE_PID not running)"
    rm -f "$PID_FILE"
  fi
fi

# ── F6: Ensure pg_wal directory exists ────────────────────────────
if [ ! -d "$PG_DATA/pg_wal" ]; then
  log "WARN: pg_wal directory missing -- re-creating"
  mkdir -p "$PG_DATA/pg_wal"
  chown postgres:postgres "$PG_DATA/pg_wal"
  chmod 700 "$PG_DATA/pg_wal"
fi

# ── F8: Emergency disk space check ───────────────────────────────
# pg_resetwal needs to write a new WAL segment.
DISK_AVAIL_KB=$(df -k "$PG_DATA" 2>/dev/null | awk 'NR==2{print $4}' || echo 0)
if [ "$DISK_AVAIL_KB" -lt 32768 ]; then
  log "WARN: Only ${DISK_AVAIL_KB}KB free -- emergency WAL cleanup before recovery"
  # Remove all but the most recent WAL segment
  if [ -d "$PG_DATA/pg_wal" ]; then
    WAL_COUNT=$(find "$PG_DATA/pg_wal" -maxdepth 1 -type f -name '0*' 2>/dev/null | wc -l)
    if [ "$WAL_COUNT" -gt 1 ]; then
      find "$PG_DATA/pg_wal" -maxdepth 1 -type f -name '0*' 2>/dev/null | sort | head -n -1 | xargs rm -f 2>/dev/null
      log "Cleaned $(( WAL_COUNT - 1 )) old WAL segments"
    fi
  fi
  # Also clean pg_wal/archive_status
  rm -f "$PG_DATA/pg_wal/archive_status/"*.done 2>/dev/null || true
fi
