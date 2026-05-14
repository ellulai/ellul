// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Scaffold CLI Shims — PATH-level enforcement for scaffold_project.
 *
 * Installs identical shim binaries at `/usr/local/bin/create-*` paths.
 * When an agent runs `npx create-next-app`, Node's npx resolves the binary
 * from PATH before fetching from the registry — our shim wins, the agent
 * gets an actionable error pointing at the MCP `scaffold_project` tool,
 * and on the next turn it invokes the tool correctly.
 *
 * ## Post-mortem (2026-04-20)
 *
 * The AgentDispatcher correctly injects the dynamic primer (MONOREPO
 * layout, NEVER-mkdir rule, drift warnings) into CLAUDE.md / AGENTS.md /
 * GEMINI.md before every CLI turn. Observed behavior: the primer reaches
 * the agent, the agent correctly infers `apps/web` / `apps/api` as target
 * paths, BUT its trained "Next.js → npx create-next-app" reflex overrides
 * the scaffold_project instruction. Reasoning logs over 24 steps showed
 * the tool was never once considered — the model jumped straight to
 * `npx create-next-app` as step 1 and spent 20+ retries fighting EROFS /
 * ENOSPC / permission errors instead of reconsidering its approach.
 *
 * Prose cannot reliably override a trained shell habit. Enforcement at
 * the PATH boundary is the only layer that reliably works.
 *
 * ## Distribution
 *
 * - **New sandboxes**: provisioning payload writes all shims at install.
 * - **Existing sandboxes**: enforcer's agent-sync picks up the manifest
 *   entries on next heartbeat, synced to disk alongside other security
 *   scripts.
 *
 * Each shim is an identical file (not a symlink) so file-based manifests
 * can distribute them without requiring a post-install hook.
 */

import content from '@vps/shell/security/scaffold-shim-body.sh';

/**
 * Intercepted CLI names. Each gets an identical copy of the shim body
 * installed at `/usr/local/bin/<name>`. The shim inspects `$0` at runtime
 * to decide which `framework` id to suggest in its error message, so the
 * body is single-sourced — only this list needs to change when adding
 * another scaffolder to intercept.
 */
export const SCAFFOLD_SHIM_NAMES: readonly string[] = [
  // Frontend / full-stack
  'create-next-app',
  'create-react-app',
  'create-vite',
  'create-vite-app',
  'create-nuxt',
  'create-nuxt-app',
  'create-remix',
  'create-svelte',
  'create-astro',
  'create-expo',
  'create-expo-app',
  'create-qwik',
  'create-gatsby',
  'create-t3-app',
  // Backend
  'create-hono',
  'create-honox',
  'create-fastify',
  // Monorepo
  'create-turbo',
] as const;

/**
 * Return the shim body that gets installed at every intercepted path.
 * The body uses `$0` to identify which CLI it was invoked as and picks
 * the right framework id in its error message.
 */
export function getScaffoldShimBody(): string {
  return content;
}
