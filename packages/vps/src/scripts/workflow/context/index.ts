// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Context manager script — generates AI context for Claude/Codex/OpenCode.
 *
 * Pre-renders product-aware markdown at BUILD TIME using the context module,
 * then embeds it in the bash script with placeholder substitution at runtime.
 * No node -e required on the VPS — the script is fully self-contained bash.
 *
 * Product-aware: reads /etc/ellul/product to select the right pre-rendered content.
 */

import { assembleGlobalContext, assembleProjectContext } from './assemble';
import { resolveFeatures } from './features';
import type { Product, Tier, ContextMode, VpsIdentity, ProjectState } from './types';
import { ALL_LOCALES } from '@ellul.ai/i18n-consts';
import { LOCALE_DIRECTIVES } from '@ellul.ai/i18n-messages/agent-context';

// Placeholder values used at build time — replaced by bash at runtime
const PLACEHOLDERS = {
  domain: '__DOMAIN__',
  devDomain: '__DEV_DOMAIN__',
  shortId: '__SHORT_ID__',
  svcUser: '__SVC_USER__',
  homeDir: '__HOME_DIR__',
  previewPort: 4000, // Default, overridden by bash
  projectName: '__PROJECT_NAME__',
  projectDir: '__PROJECT_DIR__',
};

function makeId(product: Product, tier: Tier): VpsIdentity {
  return {
    product,
    tier,
    domain: PLACEHOLDERS.domain,
    devDomain: PLACEHOLDERS.devDomain,
    shortId: PLACEHOLDERS.shortId,
    svcUser: PLACEHOLDERS.svcUser,
    homeDir: PLACEHOLDERS.homeDir,
  };
}

function makeProject(): ProjectState {
  return {
    name: PLACEHOLDERS.projectName,
    dir: PLACEHOLDERS.projectDir,
    previewPort: PLACEHOLDERS.previewPort,
  };
}

/** Pre-render context for a product+tier+mode combination */
function preRender(product: Product, tier: Tier, mode: ContextMode): { global: string; project: string } {
  const id = makeId(product, tier);
  const features = resolveFeatures(product, tier);
  const project = makeProject();
  return {
    global: assembleGlobalContext(id, features, [], mode),
    project: assembleProjectContext(id, features, project, [], mode),
  };
}

// Pre-render all variants at build time.
// Preview-capable products get base + preview variants.
// Non-preview products only get base (mode makes no difference).
const VARIANTS: Record<string, { global: string; project: string }> = {
  cloud_platform_paid_base: preRender('cloud_platform', 'paid', 'base'),
  cloud_platform_paid_preview: preRender('cloud_platform', 'paid', 'preview'),
  cloud_platform_free_base: preRender('cloud_platform', 'free', 'base'),
  cloud_platform_free_preview: preRender('cloud_platform', 'free', 'preview'),
  cloud_sandbox_paid_base: preRender('cloud_sandbox', 'paid', 'base'),
  cloud_sandbox_paid_preview: preRender('cloud_sandbox', 'paid', 'preview'),
  shield_proxy_paid_base: preRender('shield_proxy', 'paid', 'base'),
};

function escapeForHeredoc(s: string): string {
  // In a quoted heredoc (<<'EOF'), no escaping is needed.
  // But we use unquoted heredocs so bash variables like $HOME are NOT expanded.
  // We use <<'CTXEOF' which prevents ALL expansion.
  return s;
}

function buildLocaleDirectiveCase(): string {
  const lines: string[] = ['resolve_locale_directive() {', '  case "$1" in'];
  for (const locale of ALL_LOCALES) {
    const directive = LOCALE_DIRECTIVES[locale];
    lines.push(`    ${locale}) echo '${directive.replace(/'/g, "'\\''")}' ;;`);
  }
  lines.push(
    `    *) echo '${LOCALE_DIRECTIVES.en}' ;;`,
    '  esac',
    '}',
  );
  return lines.join('\n');
}

export function getContextScript(): string {
  // Build the bash case blocks for each variant
  const globalCases = Object.entries(VARIANTS).map(([key, v]) =>
    `    ${key})\n      cat <<'GLOBAL_EOF'\n${escapeForHeredoc(v.global)}\nGLOBAL_EOF\n      ;;`
  ).join('\n');

  const projectCases = Object.entries(VARIANTS).map(([key, v]) =>
    `    ${key})\n      cat <<'PROJECT_EOF'\n${escapeForHeredoc(v.project)}\nPROJECT_EOF\n      ;;`
  ).join('\n');

  return `#!/bin/bash
# ── Read VPS identity ──
TIER=$(cat /etc/ellul/billing-tier 2>/dev/null || echo "paid")
PRODUCT=$(cat /etc/ellul/product 2>/dev/null || echo "cloud_platform")
USER_LOCALE=$(cat /etc/ellul/shield-data/user-locale 2>/dev/null || cat /etc/ellul/user-locale 2>/dev/null || echo "en")
if [ "$TIER" = "free" ]; then
  HOME_DIR="/home/coder"
  USER_NAME="coder"
else
  HOME_DIR="/home/dev"
  USER_NAME="dev"
fi

# ── Locale directive (resolved at runtime from /etc/ellul/user-locale) ──
${buildLocaleDirectiveCase()}
LOCALE_DIRECTIVE=$(resolve_locale_directive "$USER_LOCALE")

inject_locale_directive() {
  local CONTENT="$1"
  local FIRST_LINE
  FIRST_LINE=$(printf '%s\\n' "$CONTENT" | head -1)
  local REST
  REST=$(printf '%s\\n' "$CONTENT" | tail -n +2)
  printf '%s\\n\\n%s\\n%s\\n' "$FIRST_LINE" "$LOCALE_DIRECTIVE" "$REST"
}

TARGET_DIR="\${1:-$HOME_DIR/projects}"
TARGET_DIR="\${TARGET_DIR%/}"
CONTEXT_DIR="$HOME_DIR/.ellul/context"
GLOBAL_FILE="$CONTEXT_DIR/global.md"
CURRENT_FILE="$CONTEXT_DIR/current.md"
# PROJECT_NAME is the full path relative to ~/projects/ (e.g. "sbx-xyz/my-app")
# so nested apps render correctly in CLAUDE.md placeholders. DIR_NAME is the
# leaf (last segment) for display/port-lookup where a short label is needed.
PROJECTS_ROOT="$HOME_DIR/projects"
case "$TARGET_DIR" in
  "$PROJECTS_ROOT"/*) PROJECT_REL="\${TARGET_DIR#$PROJECTS_ROOT/}" ;;
  *) PROJECT_REL=$(basename "$TARGET_DIR") ;;
esac
DIR_NAME=$(basename "$TARGET_DIR")

mkdir -p "$CONTEXT_DIR"

# ── Context mode: passed as $2, always explicit ──
# The bridge resolves the correct mode (base/preview/deploy) based on
# project metadata and passes it here. No auto-detection in the script.
CONTEXT_MODE="\${2:-base}"
# Non-preview products always use base
case "$PRODUCT" in
  shield_proxy) CONTEXT_MODE="base" ;;
esac

# ── Read runtime values for placeholder substitution ──
DOMAIN=$(cat /etc/ellul/domain 2>/dev/null || echo "YOUR-DOMAIN")
SHORT_ID=$(echo "$DOMAIN" | grep -o '^[a-f0-9]\\{8\\}')
DEV_DOMAIN=$(cat /etc/ellul/dev-domain 2>/dev/null || echo "dev.$DOMAIN")
PREVIEW_PORT=$(node -e "try{const r=JSON.parse(require('fs').readFileSync('$HOME_DIR/.ellul/preview-ports.json','utf8'));console.log(r['$DIR_NAME']||4000)}catch{console.log(4000)}" 2>/dev/null || echo 4000)

# ── Determine variant key (product_tier_mode) ──
BASE_KEY="\${PRODUCT}_\${TIER}"
# Normalize: only cloud_platform has a free variant; all others use paid
case "$BASE_KEY" in
  cloud_platform_free|cloud_platform_paid|cloud_sandbox_paid|shield_proxy_paid) ;;
  cloud_platform_*) BASE_KEY="cloud_platform_paid" ;;
  cloud_sandbox_*) BASE_KEY="cloud_sandbox_paid" ;;
  shield_proxy_*) BASE_KEY="shield_proxy_paid" ;;
  *) BASE_KEY="cloud_platform_paid" ;;
esac
VARIANT_KEY="\${BASE_KEY}_\${CONTEXT_MODE}"
# Fallback: if no matching variant (e.g. deploy not pre-rendered), use preview
case "$VARIANT_KEY" in
  *_deploy) VARIANT_KEY="\${BASE_KEY}_preview" ;;
esac

# ── Generate global context (pre-rendered at build time, placeholders substituted here) ──
generate_global_content() {
  case "$VARIANT_KEY" in
${globalCases}
    *)
      echo "# ellul Server ($DOMAIN)"
      ;;
  esac
}

GLOBAL_BODY=$(generate_global_content | sed \\
  -e "s|${PLACEHOLDERS.domain}|$DOMAIN|g" \\
  -e "s|${PLACEHOLDERS.devDomain}|$DEV_DOMAIN|g" \\
  -e "s|${PLACEHOLDERS.shortId}|$SHORT_ID|g" \\
  -e "s|${PLACEHOLDERS.svcUser}|$USER_NAME|g" \\
  -e "s|${PLACEHOLDERS.homeDir}|$HOME_DIR|g" \\
)
inject_locale_directive "$GLOBAL_BODY" > "$GLOBAL_FILE"
inject_locale_directive "$GLOBAL_BODY" > "$HOME_DIR/CLAUDE.md"
chown $USER_NAME:$USER_NAME "$HOME_DIR/CLAUDE.md" 2>/dev/null || true

# ── Generate per-project context (CLAUDE.md, AGENTS.md) ──
generate_project_content() {
  case "$VARIANT_KEY" in
${projectCases}
    *)
      echo "<!-- ELLUL:START -->"
      echo "# ellul ($DOMAIN)"
      echo "<!-- ELLUL:END -->"
      ;;
  esac
}

PROJECT_BODY=$(generate_project_content | sed \\
  -e "s|${PLACEHOLDERS.domain}|$DOMAIN|g" \\
  -e "s|${PLACEHOLDERS.devDomain}|$DEV_DOMAIN|g" \\
  -e "s|${PLACEHOLDERS.shortId}|$SHORT_ID|g" \\
  -e "s|${PLACEHOLDERS.svcUser}|$USER_NAME|g" \\
  -e "s|${PLACEHOLDERS.homeDir}|$HOME_DIR|g" \\
  -e "s|${PLACEHOLDERS.projectName}|$PROJECT_REL|g" \\
  -e "s|${PLACEHOLDERS.projectDir}|$TARGET_DIR|g" \\
)
PROJECT_CONTENT=$(inject_locale_directive "$PROJECT_BODY")

# ── Write with marker preservation ──
write_marker_file() {
  local FILE_PATH="$1"
  local BLOCK="$2"
  local MARKER_START="<!-- ELLUL:START"
  local MARKER_END="<!-- ELLUL:END -->"

  if [ -f "$FILE_PATH" ]; then
    if grep -q "$MARKER_START" "$FILE_PATH" 2>/dev/null; then
      awk -v block="$BLOCK" '
        /<!-- ELLUL:START/ { found=1; print block; next }
        /<!-- ELLUL:END -->/ { found=0; next }
        !found { print }
      ' "$FILE_PATH" > "$FILE_PATH.tmp"
      mv "$FILE_PATH.tmp" "$FILE_PATH"
    else
      EXISTING=$(cat "$FILE_PATH")
      printf '%s\\n\\n%s\\n' "$BLOCK" "$EXISTING" > "$FILE_PATH"
    fi
  else
    printf '%s\\n' "$BLOCK" > "$FILE_PATH"
  fi
}

# ── Cross-project read access context ──
# .shared/ lives at the sandbox root (sbx-xxx/), not nested app dirs.
# Walk up from TARGET_DIR to find the sandbox root.
SANDBOX_ROOT=""
_walk="$TARGET_DIR"
while [ "$_walk" != "$PROJECTS_ROOT" ] && [ "$_walk" != "/" ]; do
  case "$(basename "$_walk")" in sbx-*) SANDBOX_ROOT="$_walk"; break ;; esac
  _walk=$(dirname "$_walk")
done
SHARED_DIR="\${SANDBOX_ROOT:-$TARGET_DIR}/.shared"
if [ -d "$SHARED_DIR" ]; then
  SHARED_SLUGS=$(find "$SHARED_DIR" -mindepth 1 -maxdepth 1 -type d -name 'sbx-*' -printf '%f\\n' 2>/dev/null | sort)
  if [ -n "$SHARED_SLUGS" ]; then
    # Compute path to .shared/ relative to TARGET_DIR (e.g. "../.shared" if nested)
    if [ "$TARGET_DIR" = "$SANDBOX_ROOT" ] || [ -z "$SANDBOX_ROOT" ]; then
      SHARED_REL=".shared"
    else
      _depth="\${TARGET_DIR#$SANDBOX_ROOT/}"
      _ups=""
      _rest="$_depth"
      while [ -n "$_rest" ]; do
        _ups="../$_ups"
        case "$_rest" in */*) _rest="\${_rest#*/}" ;; *) _rest="" ;; esac
      done
      SHARED_REL="\${_ups}.shared"
    fi
    SHARED_NOTE="
## Cross-Project Read Access

This sandbox has read-only access to source code from other sandboxes.
Shared snapshots are at \\\`$SHARED_REL/<sandbox-slug>/\\\` (relative to this directory).

Available shared sandboxes:
"
    for SLUG in $SHARED_SLUGS; do
      SHARED_NOTE="$SHARED_NOTE- \\\`$SHARED_REL/$SLUG/\\\`
"
    done
    SHARED_NOTE="$SHARED_NOTE
These are filtered snapshots (source code only — no secrets, node_modules, or .git).
Read files from \\\`$SHARED_REL/\\\` when you need context from other projects.
Do NOT request gates or credentials for shared sandboxes — they are read-only snapshots."
    PROJECT_CONTENT="\${PROJECT_CONTENT/<!-- ELLUL:END -->/$SHARED_NOTE
<!-- ELLUL:END -->}"
  fi
fi

# Both context files in the project dir — UI displays and allows editing.
# Claude reads CLAUDE.md; Codex and OpenCode read AGENTS.md.
for CTX_FILE in "CLAUDE.md" "AGENTS.md"; do
  write_marker_file "$TARGET_DIR/$CTX_FILE" "$PROJECT_CONTENT"
  chown $USER_NAME:$USER_NAME "$TARGET_DIR/$CTX_FILE" 2>/dev/null || true
done

# Projects root AGENTS.md
write_marker_file "$HOME_DIR/projects/AGENTS.md" "$PROJECT_CONTENT"
chown $USER_NAME:$USER_NAME "$HOME_DIR/projects/AGENTS.md" 2>/dev/null || true

# ── Generate current project snapshot ──
generate_current() {
  cd "$TARGET_DIR" 2>/dev/null || return
  local PROJECT_NAME
  # Full relative path from ~/projects/ so nested apps render correctly.
  PROJECT_NAME="$PROJECT_REL"
  local PROJECT_TYPE="unknown"
  local FRAMEWORK=""
  if [ -f "package.json" ]; then
    PROJECT_TYPE="node"
    grep -q '"next"' package.json 2>/dev/null && FRAMEWORK="next.js"
    grep -q '"react"' package.json 2>/dev/null && [ -z "$FRAMEWORK" ] && FRAMEWORK="react"
    grep -q '"express"' package.json 2>/dev/null && FRAMEWORK="express"
    grep -q '"hono"' package.json 2>/dev/null && FRAMEWORK="hono"
  elif [ -f "requirements.txt" ] || [ -f "pyproject.toml" ]; then
    PROJECT_TYPE="python"
    [ -f "manage.py" ] && FRAMEWORK="django"
    grep -q "fastapi" requirements.txt 2>/dev/null && FRAMEWORK="fastapi"
    grep -q "flask" requirements.txt 2>/dev/null && FRAMEWORK="flask"
  elif [ -f "go.mod" ]; then
    PROJECT_TYPE="go"
  elif [ -f "Cargo.toml" ]; then
    PROJECT_TYPE="rust"
  fi

  local GIT_BRANCH
  GIT_BRANCH=$(git branch --show-current 2>/dev/null || echo "none")
  local GIT_CHANGES
  GIT_CHANGES=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  local FILE_TREE=""
  if command -v tree &>/dev/null; then
    FILE_TREE=$(tree -L 2 -I 'node_modules|.next|.git|dist|build|__pycache__|.venv' --noreport 2>/dev/null | head -40)
  else
    FILE_TREE=$(find . -maxdepth 2 -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.next/*' 2>/dev/null | head -30)
  fi

  cat > "$CURRENT_FILE" <<CURRENT_EOF
# PROJECT: $PROJECT_NAME

Type: $PROJECT_TYPE\${FRAMEWORK:+ ($FRAMEWORK)}
Branch: $GIT_BRANCH
Changes: $GIT_CHANGES files

## Structure
\\\`\\\`\\\`
$FILE_TREE
\\\`\\\`\\\`
CURRENT_EOF

  if [ -f "package.json" ] && command -v jq &>/dev/null; then
    local NPM_SCRIPTS
    NPM_SCRIPTS=$(jq -r '.scripts | to_entries | .[] | "- \\(.key): \\(.value)"' package.json 2>/dev/null | head -10)
    if [ -n "$NPM_SCRIPTS" ]; then
      printf '\\n## Scripts\\n%s\\n' "$NPM_SCRIPTS" >> "$CURRENT_FILE"
    fi
  fi
}

generate_current

chown -R $USER_NAME:$USER_NAME "$CONTEXT_DIR" 2>/dev/null || true
echo "Context: $GLOBAL_FILE + $CURRENT_FILE + $TARGET_DIR/{CLAUDE,AGENTS}.md"`;
}

/**
 * Context system documentation README.
 */
export function getContextReadme(): string {
  return `# ellul Context System

The context system provides AI coding assistants (OpenCode, Claude, Codex) with information about your server, projects, and preferences.

## Context Hierarchy

1. **Global Context** (\`~/.ellul/context/global.md\`) — Server rules, URLs, commands. Applies to ALL projects.
2. **Custom Context** (\`~/.ellul/context/*.md\`) — Your preferences (coding style, tech stack, API guidelines).
3. **Project Context** (\`~/projects/{app}/CLAUDE.md\`) — Per-project instructions, README (first 2000 chars), package.json scripts.

## Editing

- **Dashboard**: Context tab in your ellul dashboard
- **Terminal**: \`nano ~/.ellul/context/global.md\` or \`nano ~/projects/myapp/CLAUDE.md\`
- **AI**: Ask any CLI: "Add to my global context that I prefer TypeScript"

## How It Works

Context is cached for 30 seconds. Changes take effect automatically. The system auto-generates \`CLAUDE.md\` and \`AGENTS.md\` in each project directory using marker-based blocks (\`<!-- ELLUL:START/END -->\`). Your content outside those markers is preserved.

## Product-Aware

Context is tailored to your product type (Cloud Platform, Cloud Sandbox, Shield Gateway, Agent Adapter). Each product gets only the instructions relevant to its capabilities.`;
}
