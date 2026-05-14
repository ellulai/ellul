#!/bin/bash
FORCE=false
[ "$1" = "--force" ] || [ "$1" = "-f" ] && FORCE=true

GREEN='\033[32m'
CYAN='\033[36m'
YELLOW='\033[33m'
NC='\033[0m'

log() { echo -e "${CYAN}[janitor]${NC} $1"; }
success() { echo -e "${GREEN}*${NC} $1"; }

get_disk_usage() {
  df -h / | awk 'NR==2 {print $5}'
}

get_free_mb() {
  df -m / | awk 'NR==2 {print $4}'
}

echo ""
echo -e "${CYAN}ELLUL.AI JANITOR${NC}"
echo ""

BEFORE_MB=$(get_free_mb)
log "Disk usage: $(get_disk_usage) used"
log "Free space: ${BEFORE_MB}MB"
echo ""

if [ "$FORCE" = false ]; then
  echo "This will clean:"
  echo "  * NPM cache"
  echo "  * Git garbage collection"
  echo "  * Old log files (> 7 days)"
  echo "  * Build artifacts (.next, dist, build)"
  echo "  * Python cache (__pycache__)"
  echo "  * PM2 preview logs (truncate to 1000 lines)"
  echo ""
  read -p "Continue? [y/N] " CONFIRM
  [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ] && exit 0
  echo ""
fi

log "Cleaning NPM cache..."
bash -lc 'source ~/.nvm/nvm.sh && npm cache clean --force' 2>/dev/null
success "NPM cache cleaned"

log "Running git gc on all projects..."
for dir in $HOME/projects/*/; do
  if [ -d "$dir/.git" ]; then
    (cd "$dir" && git gc --prune=now --quiet 2>/dev/null)
  fi
done
success "Git repos optimized"

log "Cleaning old log files..."
find /var/log -type f -name "*.log" -mtime +7 -delete 2>/dev/null || true
find /var/log -type f -name "*.gz" -delete 2>/dev/null || true
success "Old logs removed"

log "Truncating PM2 preview logs..."
for logfile in $HOME/.pm2/logs/*.log; do
  if [ -f "$logfile" ]; then
    tail -1000 "$logfile" > "$logfile.tmp" && mv "$logfile.tmp" "$logfile"
  fi
done
success "PM2 preview logs truncated"

log "Cleaning build artifacts..."
find $HOME/projects -type d -name ".next" -exec rm -rf {} + 2>/dev/null || true
find $HOME/projects -type d -name "dist" -exec rm -rf {} + 2>/dev/null || true
find $HOME/projects -type d -name "build" -exec rm -rf {} + 2>/dev/null || true
find $HOME/projects -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
find $HOME/projects -type d -name ".cache" -exec rm -rf {} + 2>/dev/null || true
success "Build artifacts cleaned"

log "Cleaning temp files..."
rm -rf /tmp/npm-* 2>/dev/null || true
rm -rf /tmp/v8-compile-cache-* 2>/dev/null || true
rm -rf $HOME/.npm/_cacache 2>/dev/null || true
success "Temp files cleaned"

log "Vacuuming journal logs..."
journalctl --vacuum-time=3d --quiet 2>/dev/null || true
success "Journal logs cleaned"

echo ""
AFTER_MB=$(get_free_mb)
FREED_MB=$((AFTER_MB - BEFORE_MB))

if [ $FREED_MB -gt 0 ]; then
  success "Freed ${FREED_MB}MB of disk space!"
else
  log "Disk was already clean (nothing significant to free)"
fi

echo ""
log "Disk usage now: $(get_disk_usage) used"
log "Free space: ${AFTER_MB}MB"
echo ""
