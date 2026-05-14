// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * ZeroClaw Configs
 *
 * TOML configuration for the ZeroClaw daemon and workspace identity files.
 *
 * The workspace files live in the PROJECT directory (.zeroclaw/) and are
 * read by ZeroClaw when it processes messages for that project. They define
 * the agent's identity, personality, and workspace context.
 *
 * NOTE: Sub-CLI tools (opencode, claude, codex, cursor) also run in
 * these project directories. Keep content general-purpose and useful
 * for any AI tool — avoid ZeroClaw-specific instructions here.
 * Use the system prompt (context.service.ts) for relay-specific behavior.
 */

/**
 * Generate the ZeroClaw TOML config file.
 *
 * This is written to ~/.zeroclaw/config.toml at provisioning time.
 * Placeholders __API_URL__ and __AI_PROXY_TOKEN__ are replaced by
 * boot-config at server startup.
 */
export function getZeroClawConfigToml(apiUrl: string, aiProxyToken: string): string {
  return `# ZeroClaw configuration — managed by ellul provisioning
# Do not edit manually unless you know what you're doing.
#
# Provider: OpenAI-compatible custom endpoint via ellul AI proxy.
# Docs: https://github.com/zeroclaw-labs/zeroclaw/blob/master/docs/reference/api/providers-reference.md

default_provider = "custom:${apiUrl}/api/ai"
api_key = "${aiProxyToken}"
default_model = "default"
default_temperature = 0.7

[gateway]
host = "127.0.0.1"
port = 18790
require_pairing = false
allow_public_bind = true

[agent]
max_tool_iterations = 25
max_history_messages = 50

[autonomy]
level = "full"
workspace_only = true
allowed_commands = ["*"]
max_actions_per_hour = 100
require_approval_for_medium_risk = false
block_high_risk_commands = false

[memory]
backend = "sqlite"
auto_save = true
`;
}

/**
 * Generate a config.toml with placeholder tokens for boot-config substitution.
 */
export function getZeroClawConfigTomlWithPlaceholders(): string {
  return getZeroClawConfigToml('__API_URL__', '__AI_PROXY_TOKEN__');
}

// ── Workspace Identity Files ─────────────────────────────────

/**
 * IDENTITY.md — Agent identity.
 */
export function getZeroClawIdentity(): string {
  return `# Identity

- **Name:** ellul
- **Emoji:** ⚡
- **Role:** Full-stack coding assistant
- **Platform:** ellul
`;
}

/**
 * SOUL.md — Agent personality and behavior guidelines.
 */
export function getZeroClawSoul(): string {
  return `# ellul — ellul coding agent

You are a helpful coding assistant on the ellul cloud platform. You help users build websites, apps, APIs, and other software projects.

## Guidelines

- Be concise and direct. Avoid unnecessary preamble.
- Write clean, working code. Prefer simplicity over cleverness.
- When making changes, explain what you did and why in 1-2 sentences.
- If something is ambiguous, ask for clarification rather than guessing.
- Always work within the current project directory.
`;
}

/**
 * USER.md — User and platform context.
 */
export function getZeroClawUser(): string {
  return `# User

- **Platform:** ellul cloud coding environment
- **Interface:** Web chat UI
- **Projects:** Located in ~/projects/
- **Dev Preview:** Apps on their assigned preview port (4000-4099) are served via HTTPS reverse proxy
`;
}

/**
 * TOOLS.md — Available tools and capabilities.
 */
export function getZeroClawTools(): string {
  return `# Tools

Standard development tools are available: git, node, npm, python, etc.

## CLI Tools

The following AI coding CLI tools may be available:
- **opencode** — OpenCode CLI (free models via OpenCode Zen)
- **claude** — Claude Code (requires Anthropic auth)
- **codex** — Codex CLI (requires OpenAI auth)
- **cursor-agent** — Cursor Agent CLI (requires Cursor auth)
`;
}

/**
 * AGENTS.md — Workspace rules and conventions.
 */
export function getZeroClawAgents(): string {
  return `# Workspace

This is an ellul cloud workspace. Each project has its own directory under ~/projects/.

## Rules

- All files MUST be created directly in this project's root directory. NEVER create project subdirectories (e.g., 'my-app/', 'hello/'). When using scaffolding CLIs (create-next-app, npm create vite, etc.), always target '.' (current directory). If a tool creates a subdirectory, flatten immediately: mv subdir/* . && rmdir subdir.
- Do not create new projects or re-scaffold existing ones.
- Do not modify the "name" field in ellul.json or package.json.
- Preview is platform-managed. Just write code — do not run dev servers, install deps, or verify/restart the preview.
- Tailwind CSS is preconfigured by \`scaffold_project\` for every frontend framework — do not reinstall it. Just use Tailwind utility classes for styling; avoid custom CSS unless necessary. NEVER import from next/document in Next.js App Router — layout.tsx IS the document.
`;
}

/**
 * Get all workspace files as a map for provisioning.
 */
export function getZeroClawWorkspaceFiles(): Record<string, string> {
  return {
    'IDENTITY.md': getZeroClawIdentity(),
    'SOUL.md': getZeroClawSoul(),
    'USER.md': getZeroClawUser(),
    'AGENTS.md': getZeroClawAgents(),
    'TOOLS.md': getZeroClawTools(),
  };
}
