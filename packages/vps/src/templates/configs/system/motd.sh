#!/bin/bash
# Only show MOTD for interactive shells (non-interactive login shells
# like runuser -l would corrupt PM2 jlist JSON output with ANSI text)
[[ $- != *i* ]] && return

SERVER_DOMAIN=$(cat /etc/ellul/domain 2>/dev/null || echo "$(hostname -I | awk '{print $1}' | tr '.' '-').sslip.io")
APPS_DIR="__SVC_HOME__/.ellul/apps"

# Locale: read at MOTD time so the language follows the user's preference
# without needing a re-provision. Enforcer keeps this file in sync with
# the shield's intent on every heartbeat tick (Phase 7a-NATIVE Layer 3).
USER_LOCALE=$(cat /etc/ellul/user-locale 2>/dev/null | tr -d '[:space:]')
[ -z "$USER_LOCALE" ] && USER_LOCALE="en"

# Per-locale string variables — emitted from a single source in
# packages/i18n-messages/messages/<locale>/vpsShell.json by the
# `buildMotdShellCase()` builder. Adding a locale means dropping the
# JSON file + re-running the build; this template stays untouched.
__LOCALE_CASES__

echo ""
echo -e "  \033[1;32mELLUL.AI\033[0m - ${BANNER_TAGLINE}"
echo ""

if ls "$APPS_DIR"/*.json &>/dev/null 2>&1; then
  echo -e "  \033[32m${DEPLOYED_HEADER}\033[0m"
  for f in "$APPS_DIR"/*.json; do
    [ -f "$f" ] || continue
    APP_NAME=$(jq -r '.name' "$f" 2>/dev/null)
    APP_STACK=$(jq -r '.stack // ""' "$f" 2>/dev/null)
    echo -e "    \033[1;32m*\033[0m ${APP_NAME} [\033[36m${APP_STACK}\033[0m] -> https://${APP_NAME}.${SERVER_DOMAIN}"
  done
  echo ""
else
  echo -e "  \033[90m${EMPTY_LINE}\033[0m"
  echo ""
fi

echo -e "  \033[32m${AI_HEADER}\033[0m opencode claude codex cursor"
if [ ! -f /var/lib/ellul.ai/lazy-ai-ready ]; then
  echo -e "  \033[33m${TOOLS_INSTALLING}\033[0m"
fi
echo -e "  \033[32m${CMDS_HEADER}\033[0m ellul-apps"
echo ""
