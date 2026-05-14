// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// ZeroClaw — per-project workspace files, namespace lifecycle, CLI context
// generation (CLAUDE.md/AGENTS.md/GEMINI.md). No multi-agent concept; isolation
// is entirely via the ns-shell wrapper.

import { isSandboxId } from '@ellul.ai/types';
import { join, relative, sep, isAbsolute } from 'path';
import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync, rmSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { execFileSync } from 'child_process';
import { PROJECTS_DIR } from '../../config';
import { getZeroClawIdentity, getZeroClawUser, getZeroClawSoul, getZeroClawTools } from '@vps/configs/zeroclaw';
import { setupNamespace, teardownNamespace, getHostVethIp, computeMcpToken } from '../namespace/NamespaceSpawn';
import { MCP_ENDPOINT_PORT } from '../../config';
import { prewarmZeroClawDaemon } from '../../adapters/runtime';
import { resolveActiveAppPath } from '@vps/shared/app-workspace';
import { db } from '../../database';

// Root-owned, mode 0755. Service user can exec but not modify — defense against
// a compromised agent rewriting its own MCP relay. No dev-writable fallback.
const MCP_RELAY_PATH = '/usr/local/bin/ellul-mcp-relay';

// Legacy dev-writable path; shredded on reconcile.
const MCP_RELAY_LEGACY_PATH = join(homedir(), '.local', 'bin', 'ellul-mcp-relay');

const CONTEXT_SCRIPT = '/usr/local/bin/ellul-ctx';

// Single decision point for context mode: user override (DB) > previewable auto.
export function resolveContextMode(projectName: string): string {
  try {
    const row = db.prepare(
      'SELECT context_mode FROM project_settings WHERE project = ?',
    ).get(projectName) as { context_mode: string } | undefined;
    if (row && row.context_mode !== 'base') return row.context_mode;
  } catch {}

  const metaPath = join(PROJECTS_DIR, projectName, 'ellul.json');
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    if (meta.previewable === true) return 'preview';
  } catch {}

  return 'base';
}

const VALID_MODES = new Set(['base', 'preview', 'deploy']);

/**
 * Refresh CLI context files (CLAUDE.md, AGENTS.md, GEMINI.md) for a project.
 *
 * Runs ellul-ctx with the resolved mode. The script is a pure renderer —
 * all mode decisions are made here in the bridge (single owner).
 *
 * `projectDir` is the absolute filesystem path to the target directory and
 * may be a sandbox root, an app root, or a deeper monorepo package path. The
 * project NAME passed to the context script (and used for mode lookup) is the
 * relative path from PROJECTS_DIR — so nested apps like "sbx-xyz/my-app" are
 * preserved rather than collapsed to their leaf via `split('/').pop()`.
 */
export function refreshProjectContext(projectDir: string, mode?: string): void {
  try {
    if (!existsSync(CONTEXT_SCRIPT)) {
      return; // Script not deployed yet (pre-provisioning or old VPS)
    }

    // Derive a project name relative to PROJECTS_DIR (keeps nested paths intact).
    const rel = relative(PROJECTS_DIR, projectDir);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return;
    // Reject shell metacharacters per segment — this value is interpolated below.
    const relParts = rel.split(sep);
    for (const seg of relParts) {
      if (!/^[a-zA-Z0-9._-]+$/.test(seg)) return;
    }
    const projectName = rel;
    const resolved = mode ?? resolveContextMode(projectName);

    if (!VALID_MODES.has(resolved)) return;
    const realDir = join(PROJECTS_DIR, projectName);
    if (projectDir !== realDir) return;

    const sandboxId = relParts[0]!;
    if (!isSandboxId(sandboxId)) return;
    const contextTargetDir = join(PROJECTS_DIR, sandboxId);

    sweepStaleContextFiles(contextTargetDir);

    // Write context to the active app dir when nested, otherwise sandbox root.
    // Single location prevents duplicate entries in the settings UI.
    if (projectDir !== contextTargetDir) {
      for (const f of ['CLAUDE.md', 'AGENTS.md']) {
        try { unlinkSync(join(contextTargetDir, f)); } catch { /* ok */ }
      }
      execFileSync(CONTEXT_SCRIPT, [projectDir, resolved], { timeout: 10000, stdio: 'ignore' });
    } else {
      execFileSync(CONTEXT_SCRIPT, [contextTargetDir, resolved], { timeout: 10000, stdio: 'ignore' });
    }
    console.log(`[AgentService] Context refresh: ${projectName} → ${resolved} (at ${sandboxId})`);
  } catch (err) {
    console.warn(`[AgentService] Failed to refresh CLI context:`, (err as Error).message);
  }
}

// Deduplicates concurrent ensureProject() calls for the same project.
const pendingCreations = new Map<string, Promise<boolean>>();

// Remove app-level context files left over from older scaffolds.
// MCP files at the active app root are preserved — CLI tools walk up to
// `.git` and need the config there, not at the sandbox root.
function sweepStaleContextFiles(sandboxDir: string): void {
  const activeAppPath = resolveActiveAppPath(sandboxDir);
  try {
    for (const entry of readdirSync(sandboxDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      const appDir = join(sandboxDir, entry.name);

      for (const name of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) {
        const file = join(appDir, name);
        try {
          if (existsSync(file)) unlinkSync(file);
        } catch { /* best-effort */ }
      }

      // Skip MCP file cleanup for the active app — that's where CLIs
      // discover the relay (walk-up stops at .git).
      if (activeAppPath && appDir === activeAppPath) continue;

      for (const name of ['opencode.json', '.mcp.json', '.cursor/mcp.json']) {
        const file = join(appDir, name);
        try {
          if (!existsSync(file)) continue;
          const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
          if (!isPlatformOnlyMcpFile(parsed)) continue;
          unlinkSync(file);
        } catch { /* best-effort */ }
      }
    }
  } catch { /* unreadable sandbox — nothing to sweep */ }
}

// True if the parsed MCP file contains ONLY our `ellul-platform` entry.
function isPlatformOnlyMcpFile(parsed: Record<string, unknown>): boolean {
  const platformKey = 'ellul-platform';
  const knownWrappers = new Set(['mcpServers', 'mcp', '$schema']);
  for (const key of Object.keys(parsed)) {
    if (!knownWrappers.has(key)) return false;
  }
  for (const wrapper of ['mcpServers', 'mcp']) {
    const inner = parsed[wrapper];
    if (inner == null) continue;
    if (typeof inner !== 'object') return false;
    const keys = Object.keys(inner as Record<string, unknown>);
    if (keys.length !== 1 || keys[0] !== platformKey) return false;
  }
  return true;
}

// Writes to active app root (.zeroclaw/ next to .git/). Returns false pre-scaffold.
function writeWorkspaceFiles(sandboxDir: string): boolean {
  const appPath = resolveActiveAppPath(sandboxDir);
  if (!appPath) {
    return false;
  }

  const workspaceDir = join(appPath, '.zeroclaw');
  if (!existsSync(workspaceDir)) {
    mkdirSync(workspaceDir, { recursive: true });
  }

  const files: Record<string, string> = {
    'IDENTITY.md': getZeroClawIdentity(),
    'SOUL.md': getZeroClawSoul(),
    'USER.md': getZeroClawUser(),
    'TOOLS.md': getZeroClawTools(),
  };

  for (const [name, content] of Object.entries(files)) {
    const filePath = join(workspaceDir, name);
    try {
      const existing = existsSync(filePath)
        ? readFileSync(filePath, 'utf8')
        : null;
      if (existing !== content) {
        writeFileSync(filePath, content, 'utf8');
        console.log(`[AgentService] Wrote ${name} for ${appPath.split('/').slice(-2).join('/')}`);
      }
    } catch {
      writeFileSync(filePath, content, 'utf8');
    }
  }
  return true;
}

// Per-project relay params (veth IP + HMAC MCP token) fanned out to every CLI config.
export interface McpRelayInfo {
  hostIp: string;
  token: string;
  mcpUrl: string;
  relayBin: string;
  projectName: string;
}

export function getMcpRelayInfo(projectName: string): McpRelayInfo | null {
  const hostIp = getHostVethIp(projectName);
  const token = computeMcpToken(projectName);
  if (!hostIp || !token) return null;
  // Hard gate: no dev-writable fallback — tamperable relay defeats the gateway.
  if (!existsSync(MCP_RELAY_PATH)) {
    console.warn(
      `[AgentService] ${MCP_RELAY_PATH} missing — refusing to write MCP configs. ` +
        `Re-run provisioning or apply the latest core-runtime manifest.`,
    );
    return null;
  }
  return {
    hostIp,
    token,
    mcpUrl: `http://${hostIp}:${MCP_ENDPOINT_PORT}/mcp`,
    relayBin: MCP_RELAY_PATH,
    projectName,
  };
}

/**
 * Shred any legacy dev-writable relay drop left by ellul-env ≤ 0.1.10.
 *
 * The old codepath wrote the relay to $HOME/.local/bin/ellul-mcp-relay,
 * which was dev-owned and therefore tamperable by a compromised agent.
 * v0.1.11+ deploys the relay exclusively to /usr/local/bin as root. On
 * reconcile we unlink the old drop so no stale tamperable copy survives
 * in the agent's search path.
 */
function shredLegacyMcpRelay(): void {
  try {
    if (existsSync(MCP_RELAY_LEGACY_PATH)) {
      rmSync(MCP_RELAY_LEGACY_PATH, { force: true });
      console.log(`[AgentService] Shredded legacy MCP relay at ${MCP_RELAY_LEGACY_PATH}`);
    }
  } catch (err) {
    console.warn(`[AgentService] Failed to shred legacy MCP relay:`, (err as Error).message);
  }
}

/**
 * Write a file only if its content differs from what's on disk.
 * Avoids spurious mtime churn and cheap enough to run every reconcile.
 */
function writeIfChanged(filePath: string, content: string, mode = 0o644): void {
  try {
    if (existsSync(filePath)) {
      const current = readFileSync(filePath, 'utf8');
      if (current === content) return;
    }
  } catch {}
  try {
    writeFileSync(filePath, content, { mode });
  } catch (err) {
    console.warn(`[AgentService] Failed to write ${filePath}:`, (err as Error).message);
  }
}

// ── Unified per-CLI MCP emitter ──────────────────────────────────────
//
// Every CLI we support (Claude Code, OpenCode) uses a slightly
// different config file layout for declaring MCP servers. Previously
// each had its own hand-written writer function which meant four
// near-identical copies of "read existing JSON, merge, write back" —
// easy to drift, easy to forget one when adding a new CLI.
//
// Instead: describe each CLI as an `McpEmitter` with (a) where its
// file lives relative to the project dir, (b) how to place the
// ellul-platform entry into the JSON tree, and (c) the server entry
// shape. A single `emitAll` function drives every emitter.
//
// Codex is not in this table because it doesn't have a project-scoped
// config file — its MCP server is injected via `-c mcp_servers.*`
// spawn flags in cli-streaming.service.ts (see buildCodexMcpOverrides).
//
// Adding a new CLI is now one ~20-line entry.

interface McpEmitter {
  /** Human name for logs. */
  readonly cliName: string;
  /** Path of the config file, relative to the project directory. */
  readonly relativePath: string;
  /**
   * Produce the full config file contents given any existing parsed
   * JSON (or `{}` on first write) and the relay info for this project.
   */
  buildConfig(existing: Record<string, unknown>, info: McpRelayInfo): Record<string, unknown>;
}

function claudeMcpEmitter(): McpEmitter {
  return {
    cliName: 'Claude Code',
    relativePath: '.mcp.json',
    buildConfig(existing, info) {
      const mcpServers = (existing.mcpServers as Record<string, unknown>) || {};
      mcpServers['ellul-platform'] = {
        command: info.relayBin,
        args: [],
        env: {
          ELLUL_MCP_URL: info.mcpUrl,
          ELLUL_MCP_TOKEN: info.token,
          ELLUL_MCP_PROJECT: info.projectName,
        },
      };
      return { ...existing, mcpServers };
    },
  };
}

function cursorMcpEmitter(): McpEmitter {
  return {
    cliName: 'Cursor Agent',
    // Cursor looks for .cursor/mcp.json at the project root (same
    // walk-up semantics as Claude's .mcp.json). Shape matches the
    // Anthropic MCP contract 1:1: mcpServers[name] = {command,args,env}.
    relativePath: '.cursor/mcp.json',
    buildConfig(existing, info) {
      const mcpServers = (existing.mcpServers as Record<string, unknown>) || {};
      mcpServers['ellul-platform'] = {
        command: info.relayBin,
        args: [],
        env: {
          ELLUL_MCP_URL: info.mcpUrl,
          ELLUL_MCP_TOKEN: info.token,
          ELLUL_MCP_PROJECT: info.projectName,
        },
      };
      return { ...existing, mcpServers };
    },
  };
}

function openCodeMcpEmitter(): McpEmitter {
  return {
    cliName: 'OpenCode',
    relativePath: 'opencode.json',
    buildConfig(existing, info) {
      const mcp = (existing.mcp as Record<string, unknown>) || {};
      mcp['ellul-platform'] = {
        type: 'local',
        command: [info.relayBin],
        environment: {
          ELLUL_MCP_URL: info.mcpUrl,
          ELLUL_MCP_TOKEN: info.token,
          ELLUL_MCP_PROJECT: info.projectName,
        },
        enabled: true,
      };
      // OpenCode wants `$schema` at the top of the file, so pre-seed
      // it if the user didn't already put one there.
      return {
        $schema: 'https://opencode.ai/config.json',
        ...existing,
        mcp,
      };
    },
  };
}

/**
 * All project-scoped MCP emitters in the order they should fire.
 *
 * Exposed as a function (not a const) so tests can stub individual
 * entries and so new CLIs added in the future don't have to touch
 * writeMcpConfigs's call site — add the entry here and it lights up
 * in both ensureProject and reconcileProjects automatically.
 */
function getAllMcpEmitters(): readonly McpEmitter[] {
  return [claudeMcpEmitter(), cursorMcpEmitter(), openCodeMcpEmitter()];
}

/**
 * Apply a single emitter's config file write. Reads the existing JSON
 * (or defaults to `{}`), runs the emitter, writes only if the output
 * differs. Creates any missing parent directory as needed.
 */
function applyMcpEmitter(projectDir: string, emitter: McpEmitter, info: McpRelayInfo): void {
  const filePath = join(projectDir, emitter.relativePath);
  const parentDir = join(filePath, '..');

  if (!existsSync(parentDir)) {
    try {
      mkdirSync(parentDir, { recursive: true });
    } catch (err) {
      console.warn(
        `[AgentService] Failed to mkdir ${parentDir} for ${emitter.cliName}:`,
        (err as Error).message,
      );
      return;
    }
  }

  let existing: Record<string, unknown> = {};
  try {
    if (existsSync(filePath)) {
      existing = JSON.parse(readFileSync(filePath, 'utf8'));
    }
  } catch {
    existing = {};
  }

  const updated = emitter.buildConfig(existing, info);
  writeIfChanged(filePath, JSON.stringify(updated, null, 2) + '\n');
}

/**
 * Fan out the project's MCP config to every registered CLI emitter.
 *
 * Writes to both the sandbox root AND the active app root (when it
 * differs). CLI tools walk up from CWD and stop at `.git` — monorepo
 * apps with their own `.git` can't reach the sandbox-root copy without
 * the app-root copy sitting alongside the `.git` directory.
 *
 * Codex is not in the emitter list because it has no project-scoped
 * config file — its MCP server is injected via `-c mcp_servers.*`
 * spawn flags in cli-streaming.service.ts (see buildCodexMcpOverrides).
 *
 * Hard-fails silently if the root-owned relay binary is missing —
 * getMcpRelayInfo returns null in that case and we write no configs.
 * Happy path or failure, never a degraded path with a tamperable relay.
 */
export function writeMcpConfigs(projectDir: string, projectName: string): void {
  const info = getMcpRelayInfo(projectName);
  if (!info) return;

  // Sandbox root — baseline for single-app sandboxes and pre-scaffold chat.
  for (const emitter of getAllMcpEmitters()) {
    applyMcpEmitter(projectDir, emitter, info);
  }

  // Active app root — needed when the app has its own `.git` (monorepo
  // scaffolds, cloned repos). Walk-up from any package inside the app
  // stops at `.git` and finds the config here.
  const activeAppPath = resolveActiveAppPath(projectDir);
  if (activeAppPath && activeAppPath !== projectDir) {
    for (const emitter of getAllMcpEmitters()) {
      applyMcpEmitter(activeAppPath, emitter, info);
    }
  }
}

/**
 * Ensure a project is set up with workspace files and namespace.
 * Idempotent — safe to call multiple times.
 *
 * Accepts either a bare sandbox slug (`sbx-xyz`) or a nested app/package
 * path (`sbx-xyz/my-app`, `sbx-xyz/my-turbo/packages/web`). Platform files
 * and namespaces are **always** scoped to the sandbox root — nested input
 * is normalized to the first path segment before any write.
 *
 * This keeps user project folders clean (no `.zeroclaw/`, `.mcp.json`,
 * `opencode.json`, or context files inside the nested app) and prevents
 * accidental duplicate namespaces when two apps in the same sandbox both
 * fire `ensureProject`.
 *
 * @returns true if the sandbox was newly set up, false if already existed
 */
export async function ensureProject(projectName: string): Promise<boolean> {
  const sandboxId = projectName.split('/')[0] ?? '';
  if (!isSandboxId(sandboxId)) {
    console.warn(`[AgentService] Invalid project name (no sandbox slug): ${projectName}`);
    return false;
  }

  // Dedup per sandbox — if two apps inside the same sandbox call
  // ensureProject in parallel, one setup serves both.
  const pending = pendingCreations.get(sandboxId);
  if (pending) return pending;

  const promise = (async () => {
    try {
      const sandboxDir = join(PROJECTS_DIR, sandboxId);
      if (!existsSync(sandboxDir)) {
        console.warn(`[AgentService] Sandbox directory not found: ${sandboxDir}`);
        return false;
      }

      // Per-app `.zeroclaw/` workspace files. Writes to the active app's root
      // when the sandbox has one; no-op when empty (scaffold/clone path will
      // seed it instead).
      writeWorkspaceFiles(sandboxDir);

      // CLI context files (CLAUDE.md / AGENTS.md / GEMINI.md) live at the
      // active app's root. Fall back to sandbox root pre-scaffold for the
      // empty-sandbox chat case (the agent needs *some* cwd to receive
      // "scaffold a next project").
      const activeAppForContext = resolveActiveAppPath(sandboxDir) || sandboxDir;
      refreshProjectContext(activeAppForContext);

      // Clean up any legacy dev-writable relay drop before writing configs.
      shredLegacyMcpRelay();

      // Namespace is scoped per sandbox (the isolation unit). Using the
      // sandbox slug as the key means every app in the same sandbox
      // shares one namespace — matches the security boundary.
      //
      // MCP configs MUST be written AFTER namespace setup because
      // getHostVethIp() checks /run/.ns-{project}/anchor.pid which
      // only exists after setupNamespace() completes.
      setupNamespace(sandboxId).then(() => {
        writeMcpConfigs(sandboxDir, sandboxId);
        // Re-run context after namespace setup so .shared/ cross-project
        // snapshots (created by rsync during setup) are detected.
        refreshProjectContext(activeAppForContext);
        prewarmZeroClawDaemon({ project: sandboxId, cwd: sandboxDir }).catch(() => {
          /* pre-warm is best-effort — pool spawns lazily on first acquire */
        });
      }).catch((err) => {
        console.warn(`[AgentService] Namespace setup failed for ${sandboxId}:`, (err as Error).message);
      });

      return true;
    } finally {
      pendingCreations.delete(sandboxId);
    }
  })();

  pendingCreations.set(sandboxId, promise);
  return promise;
}

/**
 * Clean up a project — teardown namespace and remove workspace files.
 * The whole sandbox dir (including the active app's `.zeroclaw/`) is
 * typically rm'd by the caller; we only remove the workspace here if it
 * still exists. `.zeroclaw/` now lives inside the active app folder so
 * this resolver has to look one level deeper than the old layout.
 */
export async function deleteProject(projectName: string): Promise<void> {
  try {
    await teardownNamespace(projectName);
  } catch (err) {
    console.warn(`[AgentService] Namespace teardown failed for ${projectName}:`, (err as Error).message);
  }

  const sandboxDir = join(PROJECTS_DIR, projectName);
  const appPath = resolveActiveAppPath(sandboxDir);
  const workspaceDir = appPath ? join(appPath, '.zeroclaw') : null;
  if (workspaceDir && existsSync(workspaceDir)) {
    try {
      rmSync(workspaceDir, { recursive: true });
      console.log(`[AgentService] Removed workspace for ${projectName}`);
    } catch (err) {
      console.warn(`[AgentService] Failed to remove workspace:`, (err as Error).message);
    }
  }
}

/**
 * Reconcile projects — ensure all projects have workspace files.
 * Called at agent-bridge startup.
 */
export async function reconcileProjects(): Promise<void> {
  try {
    // Remove any stale legacy relay drop from $HOME/.local/bin (old
    // ellul-env ≤ 0.1.10 path). The canonical relay lives at
    // /usr/local/bin/ellul-mcp-relay owned by root — written by
    // cloud-init provisioning and refreshed by enforcer agent-sync,
    // never by this process.
    shredLegacyMcpRelay();

    if (!existsSync(PROJECTS_DIR)) return;

    const entries = readdirSync(PROJECTS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;

      const projectDir = join(PROJECTS_DIR, entry.name);

      // Sweep any orphaned scaffold scratch dirs left behind if agent-bridge
      // crashed or got SIGKILL'd mid-scaffold. The scratch dirs are named
      // `.scaffold-tmp-*` and live inside the sandbox root. Removing them
      // is safe — the atomic scaffold writes its result via rename(2) so
      // a leftover scratch dir is always incomplete.
      try {
        for (const child of readdirSync(projectDir, { withFileTypes: true })) {
          if (child.isDirectory() && child.name.startsWith('.scaffold-tmp-')) {
            const orphan = join(projectDir, child.name);
            console.warn(`[AgentService] Removing orphaned scaffold scratch: ${orphan}`);
            try { rmSync(orphan, { recursive: true, force: true }); } catch { /* best effort */ }
          }
        }
      } catch { /* unreadable dir — skip */ }

      // Per-app ZeroClaw workspace. If the sandbox is empty, skip — no app
      // to attach to yet (first scaffold / clone seeds it via the shared
      // `writeZeroClawWorkspace` helper in @vps/shared/app-workspace).
      //
      // A malformed `ellul.json` in one sandbox shouldn't kill the whole
      // reconcile pass — log and continue so the rest of the fleet's
      // sandboxes still reconcile cleanly. The error will resurface when
      // that specific sandbox is touched by a chat or scaffold call.
      try {
        const activeAppPath = resolveActiveAppPath(projectDir);
        if (activeAppPath) {
          const workspaceDir = join(activeAppPath, '.zeroclaw');
          if (!existsSync(workspaceDir)) {
            console.log(`[AgentService] Reconciling workspace for ${entry.name}`);
            writeWorkspaceFiles(projectDir);
          }
          refreshProjectContext(activeAppPath);
        }
      } catch (err) {
        console.warn(`[AgentService] Skipping reconcile for ${entry.name}: ${(err as Error).message}`);
      }

      // Always reconcile per-CLI MCP configs (token or host IP may have changed).
      // MCP configs live at the sandbox root — CLIs walk up from cwd to find them.
      writeMcpConfigs(projectDir, entry.name);
    }

    // Auto-start daemons for projects with active channel configs (Discord, Telegram, etc.)
    // so channel bots are live immediately on boot without waiting for a console message.
    const sidecarPath = join(homedir(), '.zeroclaw', 'ellul.json');
    if (existsSync(sidecarPath)) {
      try {
        const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'));
        const channels = sidecar.channels as Record<string, Record<string, unknown>> | undefined;
        if (channels) {
          const projectsWithChannels = new Set<string>();
          for (const channelData of Object.values(channels)) {
            const accounts = (channelData as Record<string, unknown>).accounts as Record<string, unknown> | undefined;
            if (accounts) {
              for (const projectName of Object.keys(accounts)) {
                if (existsSync(join(PROJECTS_DIR, projectName))) {
                  projectsWithChannels.add(projectName);
                }
              }
            }
          }
          for (const project of projectsWithChannels) {
            console.log(`[AgentService] Auto-starting daemon for ${project} (has channel configs)`);
            prewarmZeroClawDaemon({
              project,
              cwd: join(PROJECTS_DIR, project),
            }).catch(() => {
              /* best-effort — daemon will spawn lazily on first user message */
            });
          }
        }
      } catch (err) {
        console.warn('[AgentService] Channel auto-start failed:', (err as Error).message);
      }
    }
  } catch (err) {
    console.error('[AgentService] Failed to reconcile projects:', (err as Error).message);
  }
}
