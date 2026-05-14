// SPDX-License-Identifier: BUSL-1.1
//
// Single source of truth for platform tool instructions injected into
// every adapter's system prompt. Each adapter imports from here and
// wraps in its format (OpenCode `system`, Codex `developer_instructions`,
// Claude `--append-system-prompt`, Zeroclaw `systemPrompt` prepend).

import { mcpGateway } from '../application/mcp-tool/governance/McpGateway';
import { GBRAIN_CONNECTION_ID } from '../application/mcp-providers';

export const PLATFORM_TOOLS_INSTRUCTIONS = `\
You have MCP tools from the ellul-platform server. Two are critical for project setup:

1. **scaffold_project** — MANDATORY for creating any new app, package, or framework project.
   Call this tool FIRST when the user asks to add/create/scaffold/build any framework.
   Do NOT create project files manually (mkdir, package.json, tsconfig, etc.) — the platform
   write-guard rejects scaffold-shaped writes and you will lose the round-trip. The scaffold
   templates are the source of truth; your training data for boilerplate is wrong here.

2. **install_deps** — call ONCE after all scaffold_project calls. Returns immediately;
   the preview service waits for deps before launching. Then end your turn.

Shell commands remain available for editing existing files, running builds, git, debugging —
anything that is NOT creating a new project skeleton.
Git push/pull will trigger a user-approval modal in the console (git gate).`;

const GBRAIN_INSTRUCTIONS = `\

## Persistent memory (gbrain)

You have access to gbrain, a persistent knowledge layer shared across all agent sessions on this server.
Use it actively throughout every conversation:

**On session start:** Call \`search\` or \`get_page\` to retrieve prior context about the current project,
architecture decisions, user preferences, and patterns learned in past sessions. Do this before starting work.

**During the session:** When you learn something worth preserving (architecture decisions, user preferences,
important patterns, debugging insights, project conventions), call \`put_page\` to store it. Write concise,
searchable pages with clear titles. Prefer updating existing pages over creating duplicates.

**Key tools:** \`search\` (hybrid keyword + vector), \`get_page\` / \`put_page\` (CRUD), \`get_links\` /
\`get_backlinks\` (knowledge graph), \`create_take\` (synthesis), \`think\` (scratchpad).

Write-path tools (put_page, sync_brain, create_take) require gate approval. Read-path tools are auto-allowed.
Never store secrets, API keys, tokens, or credentials in gbrain — the scrub layer will redact them.`;

export const PLAN_MODE_PREAMBLE = `\
You are in PLAN MODE. The user wants to discuss, analyze, and design — NOT implement.

- Surface your thinking openly and ask clarifying questions when intent is ambiguous.
- Propose options with tradeoffs.
- DO NOT execute shell commands, edit files, or make any changes to disk.
- Draft a plan in prose that the user can approve.`;

export const DEFAULT_MODE_PREAMBLE = `\
You are in DEFAULT MODE. The user has asked for a change; implement it.

- Read relevant context before editing.
- Prefer small, focused edits over large rewrites.
- Run tests / typecheck if the project supports them and the change is non-trivial.
- Report concisely what you did.`;

function isGbrainConnected(): boolean {
  try {
    return mcpGateway.getConnectionStatus(GBRAIN_CONNECTION_ID) === 'connected';
  } catch {
    return false;
  }
}

export function buildSystemInstructions(mode: "plan" | "default"): string {
  const preamble = mode === "plan" ? PLAN_MODE_PREAMBLE : DEFAULT_MODE_PREAMBLE;
  const gbrain = isGbrainConnected() ? GBRAIN_INSTRUCTIONS : '';
  return `${preamble}\n\n## Platform tools — read before acting\n\n${PLATFORM_TOOLS_INSTRUCTIONS}${gbrain}`;
}
