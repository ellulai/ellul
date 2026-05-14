#!/bin/bash
# ellul.ai scaffold CLI shim — installed at /usr/local/bin/create-* paths.
# Intercepts agent bypass of scaffold_project.
#
# Why: agent reasoning logs on 2026-04-20 showed the LLM's trained reflex
# ("Next.js → npx create-next-app") overrides the MONOREPO / NEVER-mkdir
# primer that the dispatcher injects into CLAUDE.md / AGENTS.md / GEMINI.md.
# Prose cannot stop a trained shell habit. This shim converts the habit
# into a hard failure with an actionable error pointing at the MCP tool.

BIN_NAME="$(basename "$0")"
ARGS="$*"

FRAMEWORK=""
case "$BIN_NAME" in
  create-next-app)              FRAMEWORK="next" ;;
  create-react-app)             FRAMEWORK="cra" ;;
  create-vite|create-vite-app)  FRAMEWORK="vite" ;;
  create-nuxt|create-nuxt-app)  FRAMEWORK="nuxt" ;;
  create-remix)                 FRAMEWORK="remix" ;;
  create-svelte)                FRAMEWORK="svelte" ;;
  create-astro)                 FRAMEWORK="astro" ;;
  create-expo|create-expo-app)  FRAMEWORK="expo" ;;
  create-qwik)                  FRAMEWORK="qwik" ;;
  create-gatsby)                FRAMEWORK="gatsby" ;;
  create-hono|create-honox)     FRAMEWORK="hono" ;;
  create-fastify)               FRAMEWORK="fastify" ;;
  create-t3-app)                FRAMEWORK="next" ;;
  create-turbo)                 FRAMEWORK="turbo" ;;
  *)                            FRAMEWORK="<framework>" ;;
esac

# Best-effort slug extraction from the first non-flag positional arg so
# the suggested scaffold_project call names a plausible slug verbatim.
SLUG_HINT=""
for arg in $ARGS; do
  case "$arg" in
    -*) continue ;;
    *)  SLUG_HINT="$arg"; break ;;
  esac
done
[ -z "$SLUG_HINT" ] && SLUG_HINT="my-app"

cat >&2 <<ERR
────────────────────────────────────────────────────────────────────────
ERROR: \`$BIN_NAME\` is disabled inside ellul.ai sandboxes.

Use the \`scaffold_project\` MCP tool instead. It hydrates a deterministic
template into the correct workspace location (apps/ inside a monorepo),
avoids the install-inside-scaffold memory spike that has OOM'd hosts,
and wires the package into the workspace config automatically.

Call the tool directly:

  scaffold_project({ framework: "$FRAMEWORK", project: "$SLUG_HINT" })

The tool is registered as a builtin in the \`ellul-platform\` MCP server
(.mcp.json / opencode.json at the sandbox root) with allow_always
permission — no confirmation gate.

If you genuinely need a framework that isn't in scaffold_project's
catalog, hand-roll it with shell, BUT land the project inside a
workspace zone (apps/, packages/) — never at the monorepo root, and
never as an empty directory.
────────────────────────────────────────────────────────────────────────
ERR
exit 1
