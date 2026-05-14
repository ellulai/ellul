#!/bin/bash
# ellul-preview-instance — systemd ExecStart for ellul-preview@<instance>
#
# Deployed mode 0755, root:root. Invoked by systemd only; not called directly.
# Receives the UNESCAPED app directory path (via template %I) as argv[1].

set -euo pipefail

INSTANCE="${1:-}"
if [ -z "$INSTANCE" ]; then
  echo "[preview] FATAL: instance argument missing" >&2
  exit 1
fi

# $HOME is set by systemd's User= directive (dev or coder).
APP_PATH="$HOME/projects/$INSTANCE"
SPEC="$APP_PATH/.ellul/preview.json"

if [ ! -d "$APP_PATH" ]; then
  echo "[preview] FATAL: app directory missing: $APP_PATH" >&2
  exit 1
fi
cd "$APP_PATH"

# ── 1. Resolve the dev command ───────────────────────────────────────
# Preferred: read from the canonical preview.json written by scaffold/clone.
# Fallback: package.json.scripts.dev with a LOUD warning. The file-api's
# preview-health endpoint surfaces "specMissing: true" when it observes
# the fallback path, so the UI/agent can prompt the user to commit a spec.
if [ -f "$SPEC" ]; then
  if ! command -v jq >/dev/null 2>&1; then
    echo "[preview] FATAL: jq missing on host — cannot read preview spec" >&2
    exit 1
  fi
  SPEC_PORT=$(jq -r '.port // empty' "$SPEC" 2>/dev/null || true)
  SPEC_START=$(jq -r '.start // empty' "$SPEC" 2>/dev/null || true)
  SPEC_PROD_START=$(jq -r '.prodStart // empty' "$SPEC" 2>/dev/null || true)
  SPEC_RUNTIME=$(jq -r '.runtime // "node"' "$SPEC" 2>/dev/null || echo node)
  SPEC_MODE=$(jq -r '.mode // "hot"' "$SPEC" 2>/dev/null || echo hot)
  # Admission can override the persisted spec via env — set by
  # file-api's preview.service before calling systemctl start. An
  # explicit ELLUL_PREVIEW_MODE wins over the file, which wins over
  # the hot default.
  MODE="${ELLUL_PREVIEW_MODE:-$SPEC_MODE}"
  if [ "$MODE" != "hot" ] && [ "$MODE" != "warm" ]; then
    MODE="hot"
  fi
  if [ -z "$SPEC_PORT" ] || [ -z "$SPEC_START" ]; then
    echo "[preview] FATAL: preview.json missing required fields (port, start)" >&2
    echo "[preview] spec contents:" >&2
    cat "$SPEC" >&2 || true
    exit 1
  fi
  PORT="$SPEC_PORT"
  RUNTIME="$SPEC_RUNTIME"
  # Warm mode runs the prodStart; fall back to start when prodStart is
  # absent (interpreted runtimes whose dev and prod commands match).
  if [ "$MODE" = "warm" ] && [ -n "$SPEC_PROD_START" ]; then
    START="$SPEC_PROD_START"
  else
    START="$SPEC_START"
  fi
else
  # No spec = refuse to launch. Earlier versions fell back to
  # `npm run dev` on port 3000, but file-api allocates preview ports
  # from its own registry (4000+) and routes Caddy there — the
  # fallback silently picked a port nobody was routed to, leaving the
  # user on an iframe that would never load ("Bad Gateway" with no
  # clear signal). file-api's startPreview now calls
  # inferSpecFromRepo on every POST /preview/start, so a missing spec
  # at this layer means file-api was bypassed (unit started directly
  # via systemctl) or inference failed; both cases should surface as
  # a first-class unit-start failure, not a silent mis-route.
  #
  # Exit code 66 is our contract with preview.service.ts — mapped to
  # the `spec_missing` failReason so the UI can render the manual-
  # config panel with a start-command input. 127 stays reserved for
  # bash's own "command not found", 64 for `binary_not_found`.
  echo "[preview] FATAL: no preview.json at $SPEC — refusing to launch." >&2
  echo "[preview] file-api's POST /preview/start auto-infers a spec for every known framework." >&2
  echo "[preview] If you're reading this, the unit was started outside file-api (or inference failed)." >&2
  echo "[preview] Write $SPEC with {\"version\":1,\"runtime\":\"node\",\"start\":\"...\",\"port\":N}." >&2
  exit 66
fi

# ── 2. Port-conflict guard ──────────────────────────────────────────
# A stale process holding the port (previous crash, leaked sibling,
# manual misconfig) would cause either EADDRINUSE or — worse — a silent
# bind on a different port that leaves Caddy routing to nothing. Fail
# loud BEFORE exec so the systemd unit goes 'failed' with a clear log.
if command -v ss >/dev/null 2>&1; then
  if ss -tlnH "sport = :${PORT}" 2>/dev/null | grep -q LISTEN; then
    CULPRIT=$(ss -tlnpH "sport = :${PORT}" 2>/dev/null | head -1 || true)
    echo "[preview] FATAL: port $PORT already bound — refusing to start." >&2
    if [ -n "${CULPRIT:-}" ]; then
      echo "[preview] existing listener: $CULPRIT" >&2
    fi
    echo "[preview] stop the prior process or pick a different port in $SPEC." >&2
    exit 1
  fi
fi

# ── 3. Runtime PATH shimming ────────────────────────────────────────
# systemd inherits a minimal PATH. Each runtime's canonical install path
# lives under $HOME — dev tools go there to survive web_locked mode and
# LUKS-encrypted home volumes. Be explicit so the dev command sees the
# right binaries regardless of what shim wrappers a user shell might add.
NODE_PATH_ENTRY="$HOME/.node/bin"
CARGO_PATH_ENTRY="$HOME/.cargo/bin"
LOCAL_PATH_ENTRY="$HOME/.local/bin"
GO_PATH_ENTRY="/usr/local/go/bin"
DART_PATH_ENTRY="/usr/lib/dart/bin"
FLUTTER_PATH_ENTRY="/opt/flutter/bin"
export PATH="$NODE_PATH_ENTRY:$CARGO_PATH_ENTRY:$LOCAL_PATH_ENTRY:$GO_PATH_ENTRY:$DART_PATH_ENTRY:$FLUTTER_PATH_ENTRY:${PATH:-/usr/local/bin:/usr/bin:/bin}"

# Python compat shims — Ubuntu 24.04+ ships python3 only. Existing specs
# and user-written commands reference bare `python`/`pip`. Create ephemeral
# symlinks so they resolve without requiring python-is-python3 apt package.
SHIM_DIR="/tmp/.ellul-shims-$$"
if ! command -v python >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1; then
  mkdir -p "$SHIM_DIR"
  ln -sf "$(command -v python3)" "$SHIM_DIR/python"
  if ! command -v pip >/dev/null 2>&1 && command -v pip3 >/dev/null 2>&1; then
    ln -sf "$(command -v pip3)" "$SHIM_DIR/pip"
  fi
  export PATH="$SHIM_DIR:$PATH"
fi

export PORT="$PORT"
export HOST="0.0.0.0"

# Cap Node.js heap so frameworks like Next.js don't auto-allocate half
# the system memory for their worker processes.
if [ "$SPEC_RUNTIME" = "node" ] && ! echo "${NODE_OPTIONS:-}" | grep -q "max-old-space-size"; then
  TOTAL_MB=$(awk '/^MemTotal/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)
  if [ "$TOTAL_MB" -gt 0 ]; then
    HEAP_MB=$(( TOTAL_MB / 4 ))
    [ "$HEAP_MB" -lt 256 ] && HEAP_MB=256
    [ "$HEAP_MB" -gt 1536 ] && HEAP_MB=1536
    export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=$HEAP_MB"
  fi
fi
# NODE_ENV follows the lifecycle mode: hot (dev) → development, warm
# (prod-command against build artifact) → production. Framework-agnostic
# — every runtime that reads NODE_ENV gets the correct value without
# framework-specific code paths.
if [ "$MODE" = "warm" ]; then
  export NODE_ENV="production"
else
  export NODE_ENV="development"
fi

# Framework-scoped env vars from spec.env (2026-04-19 post-mortem fix).
# Each value may contain $PORT / $HOST placeholders — eval lets bash
# substitute at export time, same semantics as a user-written shell
# export. If jq can't parse spec.env (missing, malformed), fall through
# silently; the framework's bare devCommand still runs against the
# three baseline vars above.
if command -v jq >/dev/null 2>&1 && [ -f "$SPEC" ]; then
  while IFS= read -r LINE; do
    [ -n "$LINE" ] || continue
    # LINE is `KEY=VALUE` — eval against the already-exported PORT/HOST.
    eval "export $LINE"
  done < <(jq -r '.env // {} | to_entries[] | "\(.key)=\(.value)"' "$SPEC" 2>/dev/null || true)

  # Warm mode overlays spec.prodEnv on top of spec.env so framework-
  # declared production env (RAILS_ENV=production, MIX_ENV=prod,
  # ASPNETCORE_ENVIRONMENT=Production, …) takes effect without
  # leaking into hot mode.
  if [ "$MODE" = "warm" ]; then
    while IFS= read -r LINE; do
      [ -n "$LINE" ] || continue
      eval "export $LINE"
    done < <(jq -r '.prodEnv // {} | to_entries[] | "\(.key)=\(.value)"' "$SPEC" 2>/dev/null || true)
  fi
fi

# ── 4. Ancestor node_modules/.bin walk ──────────────────────────────
# Prepend every `node_modules/.bin/` from $APP_PATH up to the sandbox
# root, innermost-first. This mirrors what npm/yarn/pnpm/bun do natively
# when you run a script, and makes bare-binary dev commands (e.g.
# `next dev -H 0.0.0.0 -p $PORT`) resolve identically for:
#   - single apps (local node_modules/.bin/)
#   - npm/yarn workspace packages (hoisted to workspace root)
#   - pnpm packages (per-package .bin/ pointing into the pnpm store)
#   - any cloned repo with a non-standard layout, so long as install
#     has placed a .bin somewhere up the chain
#
# Also sets NODE_PATH to the deepest ancestor `node_modules/` so
# `require()` of hoisted dependencies resolves. Innermost ancestor wins
# (npm precedence), so a package can shadow the root's binary with its
# own version when it needs to.
SANDBOX="${INSTANCE%%/*}"
SANDBOX_ROOT="$HOME/projects/$SANDBOX"
HOISTED_BIN_PATH=""
WALK_DIR="$APP_PATH"
while [ -n "$WALK_DIR" ] && [ "$WALK_DIR" != "/" ]; do
  NM_DIR="$WALK_DIR/node_modules"
  if [ -d "$NM_DIR/.bin" ]; then
    if [ -z "$HOISTED_BIN_PATH" ]; then
      HOISTED_BIN_PATH="$NM_DIR/.bin"
    else
      HOISTED_BIN_PATH="$HOISTED_BIN_PATH:$NM_DIR/.bin"
    fi
    # First node_modules we find walking outward also seeds NODE_PATH
    # for require() resolution of hoisted deps.
    if [ -z "${NODE_PATH:-}" ]; then
      export NODE_PATH="$NM_DIR"
    fi
  fi
  # Stop at the sandbox root — don't walk into $HOME or /home.
  if [ "$WALK_DIR" = "$SANDBOX_ROOT" ]; then
    break
  fi
  WALK_DIR="$(dirname "$WALK_DIR")"
done
if [ -n "$HOISTED_BIN_PATH" ]; then
  export PATH="$HOISTED_BIN_PATH:$PATH"
fi

# ── 5. Backward-compat: strip legacy `./node_modules/.bin/` prefix ──
# Pre-2026-04-20 scaffolds wrote specs with a literal relative path,
# e.g. `./node_modules/.bin/next dev ...`. That path is wrong for any
# hoisted workspace layout. Since we now put the correct `.bin/` dirs
# on PATH above, stripping the prefix lets old specs resolve the
# binary through PATH without a migration pass.
#
# Only touch START — SPEC_PROD_START is never read after section 1
# chose START from one of them based on MODE, so stripping it here
# would be a no-op.
case "$START" in
  ./node_modules/.bin/*)
    START="${START#./node_modules/.bin/}"
    ;;
esac

# ── 6. Pre-flight binary resolution ─────────────────────────────────
# Fail loudly with a structured message when the dev command's first
# token isn't on PATH. Without this we get a bare `command not found`
# from bash (status 127), systemd hits StartLimitBurst, and the user
# sees "Bad Gateway" with no signal about what's wrong.
#
# Exit code 64 is our contract with preview.service.ts — it maps to
# the `binary_not_found` failReason, which the UI renders as the
# manual-config panel. 127 stays reserved for bash itself.
FIRST_TOKEN="${START%% *}"
# Only gate on resolvable names — skip when the user clearly meant an
# absolute path, relative path, or shell construct (quoted string, env
# prefix, etc.). `command -v` handles builtins correctly, so `node`,
# `python`, `bash` all work.
case "$FIRST_TOKEN" in
  /*|./*|../*|'')
    # Absolute / relative path or empty — let bash handle it and
    # produce the real error (e.g. "Permission denied", "Is a
    # directory") instead of a misleading binary_not_found.
    ;;
  *=*)
    # Env prefix like `FOO=bar next dev` — can't pre-resolve without
    # interpreting the shell; skip.
    ;;
  *)
    if ! command -v "$FIRST_TOKEN" >/dev/null 2>&1; then
      echo "[preview] FATAL: binary '$FIRST_TOKEN' not found on PATH" >&2
      echo "[preview] resolved PATH: $PATH" >&2
      echo "[preview] hint: run install to populate node_modules, or edit $SPEC with a valid start command" >&2
      exit 64
    fi
    ;;
esac

echo "[preview] start: $START (port=$PORT runtime=$RUNTIME mode=$MODE)"

# Pre-expand $PORT and $HOST in the command string. The inner bash -lc
# sources .bashrc which may re-export PORT=3000 (common in dev profiles),
# clobbering the port we allocated. Expanding here makes the command
# self-contained — immune to .bashrc interference.
START="${START//\$PORT/$PORT}"
START="${START//\$HOST/$HOST}"
START="${START//\$\{PORT\}/$PORT}"
START="${START//\$\{HOST\}/$HOST}"

# exec so systemd owns the actual dev server PID — Restart=on-failure,
# MemoryMax, and OOMScoreAdjust apply to the real process, not a bash wrapper.
# Re-export PORT/HOST inside the inner shell so frameworks that read from
# env at runtime (Go, Rust, generic Python) see the correct value even
# after .bashrc potentially clobbers them.
exec bash -lc "export PORT=$PORT HOST=$HOST; $START"
