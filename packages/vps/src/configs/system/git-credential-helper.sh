#!/bin/bash
# ellul.ai Sovereign Credential Helper
# Gets credentials from sovereign-shield via a credential session.
#
# Fast path only: GIT_CREDENTIAL_SESSION env var (set by shield's safeGitCmd).
# Agents use the git_push/git_pull platform tools instead of raw `git push`.
#
# SECURITY: Forwards the git-provided host/protocol to shield so shield can
# reject cross-host credential emission. This defeats .git/config `insteadOf`
# rewrites, malicious remote URLs, and any other redirection an attacker with
# write access to the worktree might plant.
if [ "$1" != "get" ]; then exit 0; fi

# Parse git's stdin. git sends key=value lines terminated by a blank line.
HOST=""
PROTOCOL=""
while IFS= read -r line; do
  [ -z "$line" ] && break
  case "$line" in
    host=*) HOST="${line#host=}" ;;
    protocol=*) PROTOCOL="${line#protocol=}" ;;
  esac
done

# Refuse http — shield requires TLS end-to-end.
if [ "$PROTOCOL" != "https" ]; then
  exit 0
fi

# Sanitise host before JSON embed.
SAFE_HOST=$(printf '%s' "$HOST" | tr -dc 'A-Za-z0-9.:-')
if [ -z "$SAFE_HOST" ]; then
  exit 0
fi

# ── Fast path: pre-existing session (shield's safeGitCmd flow) ──
if [ -n "$GIT_CREDENTIAL_SESSION" ]; then
  SESSION_ESCAPED=$(printf '%s' "$GIT_CREDENTIAL_SESSION" | sed 's/[\\\"]/\\&/g')
  RESULT=$(curl -sf --max-time 5 -X POST http://localhost:3005/api/internal/git-credentials \
    -H "Content-Type: application/json" \
    -d "{\"session\":\"$SESSION_ESCAPED\",\"host\":\"$SAFE_HOST\",\"protocol\":\"$PROTOCOL\"}" 2>/dev/null)
  if [ $? -ne 0 ] || [ -z "$RESULT" ]; then
    exit 0
  fi
  USERNAME=$(echo "$RESULT" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')
  PASSWORD=$(echo "$RESULT" | sed -n 's/.*"password":"\([^"]*\)".*/\1/p')
  if [ -n "$USERNAME" ] && [ -n "$PASSWORD" ]; then
    echo "username=$USERNAME"
    echo "password=$PASSWORD"
  fi
  exit 0
fi

# No session — agent should use the git_push platform tool, not raw git push.
exit 0
