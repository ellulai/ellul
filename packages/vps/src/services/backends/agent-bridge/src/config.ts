// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Agent Bridge Configuration
 *
 * Constants and configuration for the Workbench WebSocket server.
 */

import * as os from 'os';
import * as fs from 'fs';

// Import ports from the central registry — see
// packages/vps/src/services/shared/ports.ts. Do NOT hard-code port
// numbers anywhere else in the agent-bridge package; a collision
// (the way MCP_ENDPOINT_PORT and TERM_PROXY's PORT both claimed 7701)
// would silently break one of the services until runtime.
import {
  PORT_REGISTRY,
  FILE_API_PORT as _FILE_API_PORT,
  OPENCODE_API_PORT as _OPENCODE_API_PORT,
  AGENT_BRIDGE_PORT as _AGENT_BRIDGE_PORT,
  MCP_ENDPOINT_PORT as _MCP_ENDPOINT_PORT,
} from '@vps/services/shared/ports';

const HOME = os.homedir();

// Dev preview domain (written by provisioning to /etc/ellul/dev-domain)
let _devDomain = '';
try {
  _devDomain = fs.readFileSync('/etc/ellul/dev-domain', 'utf8').trim();
} catch {}
export const DEV_DOMAIN = _devDomain;

// All port numbers come from the central registry. Edit
// packages/vps/src/services/shared/ports.ts to change an allocation.
export const PORT = _AGENT_BRIDGE_PORT;
export const MCP_ENDPOINT_PORT = _MCP_ENDPOINT_PORT;
export const CHAT_DB_PATH = '/etc/ellul/agent-bridge/chat.db';
export const ORCHESTRATION_DB_PATH = '/etc/ellul/agent-bridge/orchestration.db';
export const OPENCODE_API_PORT = _OPENCODE_API_PORT;
// /usr/local/bin/opencode is the TMPDIR-isolation wrapper; the real
// bun-compiled binary lives off-PATH at /usr/local/libexec/ellul/opencode
// and is invoked only by the wrapper. Without isolation, bun's embedded
// dylib extraction at "$TMPDIR/.<hash>-00000000.so" per spawn (never
// unlinked) accumulates until the namespace's /tmp tmpfs fills.
export const OPENCODE_BIN = '/usr/local/bin/opencode';
export const DEFAULT_SESSION = 'opencode';
export const PROJECTS_DIR = `${HOME}/projects`;
/** Validates project directory names (sbx-xxxxxxx format, no path traversal). */
export const PROJECT_NAME_RE = /^sbx-[a-z0-9]{7}$/;
export const CONTEXT_DIR = `${HOME}/.ellul/context`;
export const CLI_ENV_FILE = `${HOME}/.ellul-cli-env`;

export const VALID_SESSIONS = ['main', 'opencode', 'claude', 'codex', 'cursor', 'claw', 'grok'] as const;
export type SessionType = (typeof VALID_SESSIONS)[number];

// ── Timeout architecture ──────────────────────────────────────────────────────
//
// PRINCIPLE: The bridge NEVER auto-kills execution. Only the user can stop it.
//
// CLI tools (Claude, Codex, Cursor, OpenCode, ZeroClaw, Grok) run until natural
// completion — just like on a laptop. The ONLY ways to stop execution early:
//   1. User clicks abort → killProcessTree() / controller.abort()
//   2. User sends a new message on the same thread → old process killed
//
// No inactivity timers. No hard limits. No observation timeouts.
//
// REQUEST_TIMEOUT_MS / CLI_TIMEOUT_MS are for HTTP requests to local APIs
// (OpenCode REST, health checks) — network protection, not execution control.
//
export const REQUEST_TIMEOUT_MS = 300_000;
export const CLI_TIMEOUT_MS = 300_000;
export const INTERACTIVE_TIMEOUT_MS = 180000; // 3 min timeout for interactive sessions
export const MAX_BUFFER_SIZE = 64 * 1024; // stdout buffer limit
export const DEBOUNCE_MS = 1200; // Wait for TUI to finish writing full frames
export const CONTEXT_CACHE_MS = 30000; // Refresh context every 30 seconds

// Relay agent UX — progress updates & stale detection
export const PROGRESS_INTERVAL_MS = 25000; // 25s between progress updates when user has no output
export const STALE_POLL_THRESHOLD = 10; // consecutive empty polls before warning user

// CLI environment variable mapping
export const CLI_KEY_MAP: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

// Allowed interactive commands (whitelist only - prevents command injection)
export const ALLOWED_INTERACTIVE_COMMANDS: Record<string, string[]> = {
  claude: ['claude', 'claude login'],
  codex: ['codex', 'codex login', 'codex login --device-auth'],
  cursor: ['cursor-agent', 'cursor-agent login'],
};

// Default interactive commands for each CLI
export const DEFAULT_INTERACTIVE_COMMANDS: Record<string, string> = {
  claude: 'claude login',
  codex: 'codex login',
  cursor: 'cursor-agent login',
};

// Preview health gate (agent-bridge polls file-api for preview readiness)
export const FILE_API_PORT = _FILE_API_PORT;

// Metadata re-exported so callers that need full allocation info (e.g.,
// logging or documentation) can reach it without importing from shared.
export { PORT_REGISTRY };
export const HEALTH_GATE_TOTAL_MS = 45_000;
export const HEALTH_GATE_INITIAL_DELAY_MS = 2_000;
export const HEALTH_GATE_MAX_INTERVAL_MS = 6_000;
export const HEALTH_GATE_BACKOFF_FACTOR = 1.5;

// Zen model discovery
export const ZEN_MODELS_URL = 'https://opencode.ai/zen/v1/models';
export const ZEN_REFRESH_MS = 30 * 60 * 1000; // 30 minutes
