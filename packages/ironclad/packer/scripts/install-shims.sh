#!/bin/bash
# Command Shims — UX-Friendly Restriction Messages
#
# These shims intercept restricted commands and show clean "upgrade"
# messages instead of confusing "Connection Reset" or timeout errors.
#
# SECURITY NOTE: These are UX, not security. A user could bypass them
# by calling /usr/bin/git directly. The Warden (network proxy) remains
# the hard backstop — if they bypass the shim, they hit the wall.
#
# Path priority: /usr/local/bin is before /usr/bin in $PATH,
# so these shims take precedence over system binaries.
set -euo pipefail

echo "[golden] Installing command shims..."

# ============================================================
# 1. git shim — blocks push, allows clone/fetch/pull + local ops
# ============================================================
cat > /usr/local/bin/git << 'SHIM'
#!/bin/bash
# git shim — Free Tier: code comes in, can't leave
# Allowed: clone, fetch, pull (read-only), all local commands
# Blocked: push (code can't leave)

# Walk the args to find the subcommand (skip flags like -C, --git-dir)
subcmd=""
for arg in "$@"; do
  case "$arg" in
    -*) continue ;;  # skip flags
    *)  subcmd="$arg"; break ;;
  esac
done

case "$subcmd" in
  push)
    echo -e "\033[0;31m"
    echo "======================================================"
    echo "  ACTION BLOCKED: Free Tier Restriction"
    echo "======================================================"
    echo -e "\033[0m"
    echo "  'git push' is disabled on the Free Tier."
    echo "  You can clone, pull, and work locally — but code can't leave."
    echo ""
    echo "  To push code, upgrade to Sovereign:"
    echo "  https://coemad.com/pricing"
    echo ""
    exit 1
    ;;
  clone|fetch|pull)
    # Read-only remote operations — allowed (code comes in)
    exec /usr/bin/git "$@"
    ;;
  remote)
    # Allow all remote subcommands (add, set-url, show, etc.)
    # Users can set up remotes for cloning/pulling
    exec /usr/bin/git "$@"
    ;;
  *)
    # status, commit, log, diff, branch, checkout, add, reset, stash, merge, rebase, tag, etc.
    exec /usr/bin/git "$@"
    ;;
esac
SHIM

chmod +x /usr/local/bin/git
echo "[golden]   Installed: /usr/local/bin/git (blocks push, allows clone/pull)"

# ============================================================
# 2. ssh shim — blocks all outbound SSH
# ============================================================
cat > /usr/local/bin/ssh << 'SHIM'
#!/bin/bash
# ssh shim — Free Tier restriction on outbound SSH
echo -e "\033[0;31m"
echo "======================================================"
echo "  ACTION BLOCKED: Free Tier Restriction"
echo "======================================================"
echo -e "\033[0m"
echo "  Outbound SSH is disabled on the Free Tier."
echo "  This includes ssh, scp, and rsync over SSH."
echo ""
echo "  To connect to external servers, upgrade to Sovereign:"
echo "  https://coemad.com/pricing"
echo ""
exit 1
SHIM

chmod +x /usr/local/bin/ssh
echo "[golden]   Installed: /usr/local/bin/ssh (blocks outbound)"

# Also shim scp and rsync (both use SSH under the hood)
cat > /usr/local/bin/scp << 'SHIM'
#!/bin/bash
echo -e "\033[0;31m"
echo "======================================================"
echo "  ACTION BLOCKED: Free Tier Restriction"
echo "======================================================"
echo -e "\033[0m"
echo "  'scp' is disabled on the Free Tier (uses SSH)."
echo ""
echo "  Upgrade to Sovereign: https://coemad.com/pricing"
echo ""
exit 1
SHIM

chmod +x /usr/local/bin/scp

cat > /usr/local/bin/rsync << 'SHIM'
#!/bin/bash
# rsync shim — only block remote transfers, allow local
# Check if any argument contains a colon (user@host:path = remote)
for arg in "$@"; do
  case "$arg" in
    -*) continue ;;
    *:*)
      echo -e "\033[0;31m"
      echo "======================================================"
      echo "  ACTION BLOCKED: Free Tier Restriction"
      echo "======================================================"
      echo -e "\033[0m"
      echo "  Remote rsync is disabled on the Free Tier."
      echo ""
      echo "  Upgrade to Sovereign: https://coemad.com/pricing"
      echo ""
      exit 1
      ;;
  esac
done
# Local rsync (no remote target) — pass through
exec /usr/bin/rsync "$@"
SHIM

chmod +x /usr/local/bin/rsync
echo "[golden]   Installed: /usr/local/bin/scp, rsync (blocks remote transfers)"

# ============================================================
# 3. Cloud CLI deploy shims
# ============================================================
# These tools don't exist on the golden image, but users might
# npm install -g them. The shim prevents execution even if installed
# to a local node_modules/.bin or npx'd.

DEPLOY_TOOLS=(vercel flyctl netlify heroku aws gcloud az railway render wrangler)

for tool in "${DEPLOY_TOOLS[@]}"; do
  cat > "/usr/local/bin/$tool" << SHIM
#!/bin/bash
echo -e "\033[0;31m"
echo "======================================================"
echo "  DEPLOYMENT BLOCKED: Free Tier Restriction"
echo "======================================================"
echo -e "\033[0m"
echo "  '$tool' is not available on the Free Tier."
echo "  The Free Tier is for coding, not shipping."
echo ""
echo "  To deploy your code, upgrade to Sovereign:"
echo "  https://coemad.com/pricing"
echo ""
exit 1
SHIM
  chmod +x "/usr/local/bin/$tool"
done

echo "[golden]   Installed: ${DEPLOY_TOOLS[*]} (deploy blockers)"

# ============================================================
# 4. Tunnel tool shims
# ============================================================
TUNNEL_TOOLS=(ngrok cloudflared bore localtunnel lt expose)

for tool in "${TUNNEL_TOOLS[@]}"; do
  cat > "/usr/local/bin/$tool" << SHIM
#!/bin/bash
echo -e "\033[0;31m"
echo "======================================================"
echo "  TUNNELING BLOCKED: Free Tier Restriction"
echo "======================================================"
echo -e "\033[0m"
echo "  '$tool' is not available on the Free Tier."
echo "  Exposing local ports to the internet is restricted."
echo ""
echo "  To tunnel traffic, upgrade to Sovereign:"
echo "  https://coemad.com/pricing"
echo ""
exit 1
SHIM
  chmod +x "/usr/local/bin/$tool"
done

echo "[golden]   Installed: ${TUNNEL_TOOLS[*]} (tunnel blockers)"

# ============================================================
# 5. npm publish shim (wrapper around real npm)
# ============================================================
cat > /usr/local/bin/npm << 'SHIM'
#!/bin/bash
# npm shim — blocks publish, passes everything else through

subcmd=""
for arg in "$@"; do
  case "$arg" in
    -*) continue ;;
    *)  subcmd="$arg"; break ;;
  esac
done

case "$subcmd" in
  publish)
    echo -e "\033[0;31m"
    echo "======================================================"
    echo "  ACTION BLOCKED: Free Tier Restriction"
    echo "======================================================"
    echo -e "\033[0m"
    echo "  'npm publish' is disabled on the Free Tier."
    echo "  Install and develop packages freely, but publishing"
    echo "  requires an upgrade."
    echo ""
    echo "  Upgrade to Sovereign: https://coemad.com/pricing"
    echo ""
    exit 1
    ;;
  *)
    # install, run, test, build, etc. — all allowed
    exec /usr/bin/npm "$@"
    ;;
esac
SHIM

chmod +x /usr/local/bin/npm
echo "[golden]   Installed: /usr/local/bin/npm (blocks publish)"

# ============================================================
# 6. Verify PATH priority
# ============================================================
# /usr/local/bin must come BEFORE /usr/bin in coder's PATH
# This is the default on Ubuntu, but verify it.
CODER_PATH=$(su - coder -c 'echo $PATH' 2>/dev/null || echo "")
if echo "$CODER_PATH" | grep -q "/usr/local/bin"; then
  echo "[golden]   PATH priority verified: /usr/local/bin is in coder PATH"
else
  # Force it via profile
  echo 'export PATH="/usr/local/bin:$PATH"' >> /home/coder/.bashrc
  echo "[golden]   Added /usr/local/bin to coder .bashrc PATH"
fi

echo "[golden] Command shims installed successfully"
echo "[golden]   UX shims: git (push blocked, clone/pull allowed), ssh, scp, rsync, npm"
echo "[golden]   Deploy blockers: ${DEPLOY_TOOLS[*]}"
echo "[golden]   Tunnel blockers: ${TUNNEL_TOOLS[*]}"
echo "[golden]   NOTE: These are UX only. The Warden is the hard backstop."
