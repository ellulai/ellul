// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.
//
// ZeroClaw runtime — stateless spawn + WS dialog. The per-project
// lifecycle (acquire / release / sweep / crash recovery) lives in
// `./server-pool.ts`. This module knows nothing about pooling — every
// `startDaemon` call returns a fresh process whose lifetime is owned
// by the caller-supplied Scope. Closing the scope kills the daemon.
//
// Mirror of `../opencode/runtime.ts`'s shape, with the extra concerns
// zeroclaw needs:
//   - Per-project config.toml + sidecar channel section.
//   - Append-only log at `/var/log/ellul/zeroclaw-{project}.log` with
//     a per-spawn header marker so cross-respawn history is preserved
//     and grep-correlatable to a generation. file-api tails this exact
//     path for the WhatsApp QR-code stream, so the path is canonical.
//   - HTTP /health probe as the definitive ready signal — the daemon
//     prints a "started" line BEFORE its gateway component actually
//     binds the socket, so stdout-based ready detection alone is
//     insufficient.
//   - Channel-readiness retry on the channel-broker side: handled by
//     the pool, not here.

import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  Cause,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate as P,
  Ref,
  Scope,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import WebSocket from "ws";

import { logEvent } from "../../shared/event-log";
import {
  NAMESPACE_ADAPTER_ENV,
  NAMESPACE_PROJECT_ENV,
  NAMESPACE_SCOPE_ID_ENV,
  NAMESPACE_SOFT_HINT_MB_ENV,
} from "../../shared/namespace-spawner";
import { computeWorkloadSliceBudget as _computeBudget } from "@vps/shared/memory-budget";
import * as _os from "node:os";
const _ZC_SOFT_HINT_MB = _computeBudget(Math.max(512, Math.round(_os.totalmem() / (1024 * 1024)))).perSandboxSoftHintMB;
let _zcScopeGen = 0;
import { PROJECTS_DIR } from "../../config";

// `resolveActiveAppPath` turns a sandbox dir like `/home/dev/projects/sbx-xxx`
// into the active per-project app dir (handles nested appRoots). Falls back
// to the sandbox dir if no app config is present.
import { resolveActiveAppPath } from "@vps/shared/app-workspace";

// ─── Constants ─────────────────────────────────────────────────────────

const ZEROCLAW_BINARY = "zeroclaw";
const HEALTH_TIMEOUT_MS = 20_000;
const HEALTH_POLL_INTERVAL_MS = 500;
const HEALTH_PROBE_TIMEOUT_MS = 2_000;
const REQUEST_TIMEOUT_MS = 300_000;
const LOG_DIR = "/var/log/ellul";

export const ZEROCLAW_PORT_BASE = 18800;
export const ZEROCLAW_PORT_MAX = 18899;

// Env keys forwarded from the bridge process into the daemon. Anything
// not on this list is dropped — the daemon shouldn't inherit the
// bridge's secrets, just the platform basics.
const DAEMON_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  "PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "LC_ALL", "TMPDIR", "TZ",
  "NODE_OPTIONS", "NODE_ENV", "NO_COLOR", "FORCE_COLOR",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
]);

// BYOK keys (loaded from ~/.zeroclaw/.env if present) — passed through
// verbatim so users can use their own API keys.
const BYOK_KEY_ALLOWLIST: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY",
  "GROQ_API_KEY", "MISTRAL_API_KEY", "DEEPSEEK_API_KEY", "TOGETHER_API_KEY",
  "FIREWORKS_API_KEY", "OPENROUTER_API_KEY", "PERPLEXITY_API_KEY",
  "XAI_API_KEY", "COHERE_API_KEY", "REPLICATE_API_TOKEN",
  "ZEROCLAW_MODEL", "ZEROCLAW_PROVIDER",
]);

// Patterns scrubbed from daemon stdout/stderr before writing to the
// per-generation log file. Defense-in-depth — the daemon shouldn't
// be logging tokens, but if it does, we don't echo them to /var/log.
const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /sk-[a-zA-Z0-9]{20,}/g,
  /sk-ant-[a-zA-Z0-9-]{40,}/g,
  /AIzaSy[a-zA-Z0-9_-]{33}/g,
  /ghp_[a-zA-Z0-9]{36}/g,
  /github_pat_[a-zA-Z0-9_]{22,}/g,
  /gho_[a-zA-Z0-9]{36}/g,
  /glpat-[a-zA-Z0-9_-]{20,}/g,
  /xoxb-[0-9]+-[a-zA-Z0-9]+/g,
  /xoxp-[0-9]+-[a-zA-Z0-9]+/g,
  /(?<=ANTHROPIC_API_KEY=)[^\s\n]+/g,
  /(?<=OPENAI_API_KEY=)[^\s\n]+/g,
  /(?<=GOOGLE_API_KEY=)[^\s\n]+/g,
];

// ─── Types ─────────────────────────────────────────────────────────────

export interface ZeroClawAgentChunk {
  readonly type:
    | "text"
    | "tool_use"
    | "tool_result"
    | "file_edit"
    | "status"
    | "error"
    | "reasoning";
  readonly content?: string;
  readonly tool?: string;
  readonly input?: unknown;
  readonly output?: string;
  readonly success?: boolean;
  readonly path?: string;
  readonly diff?: string;
  readonly status?: "thinking" | "idle";
  readonly message?: string;
}

export interface ZeroClawAgentResponse {
  readonly text: string;
  readonly tools: ReadonlyArray<string>;
  readonly reasoning: ReadonlyArray<string>;
}

export interface ZeroClawDaemonHealthEntry {
  readonly project: string;
  readonly port: number;
  readonly hostAddress: string;
  readonly pid: number | null;
  readonly ready: boolean;
  readonly hasChannels: boolean;
  readonly lastActivity: number;
  readonly idleMs: number;
}

export interface ZeroClawDaemonProcess {
  /** Daemon's HTTP/WS base URL: `http://<host>:<port>`. */
  readonly url: string;
  readonly hostAddress: string;
  readonly port: number;
  readonly pid: number | null;
  readonly hasChannels: boolean;
  readonly generation: number;
  readonly project: string;
  /** Resolves with the OS exit code when the daemon exits. */
  readonly exitCode: Effect.Effect<number, never>;
}

const ZEROCLAW_RUNTIME_ERROR_TAG = "ZeroClawRuntimeError";

export class ZeroClawRuntimeError extends Data.TaggedError(
  ZEROCLAW_RUNTIME_ERROR_TAG,
)<{
  readonly operation: string;
  readonly detail: string;
  readonly cause?: unknown;
}> {
  static readonly is = (u: unknown): u is ZeroClawRuntimeError =>
    P.isTagged(u, ZEROCLAW_RUNTIME_ERROR_TAG);
}

export function zeroClawRuntimeErrorDetail(cause: unknown): string {
  if (ZeroClawRuntimeError.is(cause)) return cause.detail;
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message.trim();
  }
  return String(cause);
}

export interface ZeroClawRuntimeShape {
  /**
   * Spawn one ZeroClaw daemon for a project. Caller supplies a Scope
   * via `Effect.provideService(Scope.Scope, scope)`. Closing the scope
   * kills the daemon's process group (SIGTERM, then SIGKILL).
   *
   * Returns a {@link ZeroClawDaemonProcess} once `/health` returns 200
   * OR fails with {@link ZeroClawRuntimeError} on any of:
   *   - process exits before /health passes
   *   - /health doesn't pass within HEALTH_TIMEOUT_MS
   *   - spawn itself fails (binary missing, namespace error, ...)
   */
  readonly startDaemon: (input: {
    readonly project: string;
    readonly cwd: string;
    readonly port: number;
    readonly hostAddress: string;
    readonly bindAddress: string;
    readonly generation: number;
  }) => Effect.Effect<ZeroClawDaemonProcess, ZeroClawRuntimeError, Scope.Scope>;

  /**
   * Run one chat turn: open a WebSocket to the daemon, send the
   * message, drain the response, close the WS. Daemon-emitted error
   * events flow through `onChunk` as `{type:"error", message}` so the
   * adapter can surface them as structured `runtime.error` events —
   * NOT swallowed into a generic "Something went wrong" string.
   */
  readonly sendOnSession: (input: {
    readonly daemon: ZeroClawDaemonProcess;
    readonly threadId: string;
    readonly message: string;
    readonly systemPrompt?: string | null;
    readonly onChunk: (chunk: ZeroClawAgentChunk) => void;
  }) => Effect.Effect<ZeroClawAgentResponse, ZeroClawRuntimeError>;

  /**
   * `zeroclaw --version` probe. Used by manifests / health endpoints
   * to confirm the binary is installed and runnable. Does not check
   * any running daemon.
   */
  readonly checkBinaryHealth: Effect.Effect<boolean>;
}

export class ZeroClawRuntime extends Context.Service<
  ZeroClawRuntime,
  ZeroClawRuntimeShape
>()("ellul/adapters/ZeroClawRuntime") {}

// ─── Internal helpers ──────────────────────────────────────────────────

function redactSecrets(data: Buffer): Buffer {
  let text = data.toString();
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "[REDACTED]");
  return Buffer.from(text);
}

function projectLogPath(project: string): string {
  return join(LOG_DIR, `zeroclaw-${project}.log`);
}

function ensureLogDir(): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    /* logrotate may have already created it; ignore */
  }
}

/**
 * Append a per-spawn header marker to the project log so cross-respawn
 * history stays grep-correlatable to a generation. The fix for the
 * original bug: the legacy `attachLogTee` truncated this same file on
 * each spawn (`writeFileSync(file, "")`), so the predecessor's tail —
 * exactly the data you'd need to debug an orphan or EADDRINUSE loop —
 * vanished. We now append-only; logrotate handles disk-bound retention.
 */
function writeSpawnHeader(input: {
  readonly project: string;
  readonly generation: number;
  readonly pid: number | null;
  readonly port: number;
  readonly hostAddress: string;
}): void {
  const header = `\n===== zeroclaw spawn: project=${input.project} generation=${input.generation} pid=${input.pid ?? "?"} port=${input.port} host=${input.hostAddress} startedAt=${new Date().toISOString()} =====\n`;
  try {
    appendFileSync(projectLogPath(input.project), header);
  } catch {
    /* best-effort — never fail spawn over a log write */
  }
}

function appendToProjectLog(project: string, data: Buffer): void {
  const path = projectLogPath(project);
  try {
    appendFileSync(path, redactSecrets(data));
  } catch {
    /* best-effort logging; never fail the spawn over a log write */
  }
}

// ─── Project config generation ────────────────────────────────────────

function renderChannelSection(
  name: string,
  data: Record<string, unknown>,
): string {
  const token = data.token || data.botToken || data.bot_token;
  if (!token) return "";

  let section = `\n[channels_config.${name}]\nbot_token = "${token}"\n`;

  const allowedUsers =
    (data.allowed_users as string[] | undefined) ??
    (data.allowFrom as string[] | undefined) ??
    ["*"];
  section += `allowed_users = [${allowedUsers.map((v) => `"${v}"`).join(", ")}]\n`;

  const guildId = data.guildId || data.guild_id;
  if (guildId) section += `guild_id = "${guildId}"\n`;

  if (name === "discord") section += `stream_mode = "multi_message"\n`;
  else if (name === "telegram") section += `stream_mode = "off"\n`;

  return section;
}

function renderChannelToml(project: string): string {
  const sidecarPath = join(homedir(), ".zeroclaw", "ellul.json");
  if (!existsSync(sidecarPath)) return "";

  let sidecar: Record<string, unknown>;
  try {
    sidecar = JSON.parse(readFileSync(sidecarPath, "utf8"));
  } catch {
    return "";
  }
  const channels = sidecar.channels as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!channels) return "";

  let out = "";
  for (const [channelName, channelData] of Object.entries(channels)) {
    const accounts = channelData.accounts as
      | Record<string, Record<string, unknown>>
      | undefined;
    const acct = accounts?.[project];
    if (acct) {
      out += renderChannelSection(channelName, acct);
    } else if (!accounts) {
      // Global channel config (no per-project accounts).
      out += renderChannelSection(channelName, channelData);
    }
  }
  return out;
}

export function sidecarExpectsChannels(project: string): boolean {
  const sidecarPath = join(homedir(), ".zeroclaw", "ellul.json");
  if (!existsSync(sidecarPath)) return false;
  try {
    const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8")) as Record<
      string,
      unknown
    >;
    const channels = sidecar.channels as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (!channels) return false;
    for (const channelData of Object.values(channels)) {
      const accounts = channelData.accounts as
        | Record<string, unknown>
        | undefined;
      if (accounts?.[project]) return true;
    }
  } catch {
    /* ignore — treat as no channels */
  }
  return false;
}

/**
 * Write/refresh `<appDir>/.zeroclaw/config.toml` and mirror to
 * `~/.zeroclaw/config.toml`. Returns true when channel sections were
 * injected (the pool uses this to decide whether channel readiness
 * needs to be re-verified after spawn).
 *
 * The config is rewritten on every spawn so sidecar-driven channel
 * changes are picked up without a separate reload step.
 */
export function getPlatformAiProxyUrl(): string {
  try {
    const z = readFileSync('/etc/ellul/platform-zone', 'utf8').trim();
    return `custom:https://api.${z}/api/ai`;
  } catch {
    return '';
  }
}

const BYOK_PROVIDERS = new Set(['anthropic', 'openai', 'google', 'openrouter']);

export function ensureProjectConfig(appDir: string, project: string): boolean {
  const clawDir = join(appDir, ".zeroclaw");
  mkdirSync(clawDir, { recursive: true });
  const configPath = join(clawDir, "config.toml");

  const platformProvider = getPlatformAiProxyUrl();
  let provider = platformProvider;
  let apiKey = process.env.AI_PROXY_TOKEN?.trim() || "";
  const globalConfigPath = join(homedir(), ".zeroclaw", "config.toml");
  if (existsSync(globalConfigPath)) {
    const content = readFileSync(globalConfigPath, "utf8");
    const providerMatch = content.match(/^default_provider\s*=\s*"([^"]+)"/m);
    const gp = providerMatch?.[1];
    if (gp && (BYOK_PROVIDERS.has(gp) || gp.startsWith('custom:'))) {
      provider = gp;
    }
    if (!apiKey) {
      const keyMatch = content.match(/^api_key\s*=\s*"([^"]+)"/m);
      if (keyMatch?.[1]) apiKey = keyMatch[1];
    }
  }

  const channelToml = renderChannelToml(project);

  writeFileSync(
    configPath,
    `default_provider = "${provider}"
api_key = "${apiKey}"
default_model = "default"
default_temperature = 0.7

[gateway]
host = "127.0.0.1"
port = 0
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

[channels_config]
ack_reactions = false
${channelToml}
`,
    { mode: 0o600 },
  );

  // Mirror to ~/.zeroclaw/config.toml — daemon reads from here regardless
  // of --config-dir flag. Per-project copy stays for reference.
  const globalDir = join(homedir(), ".zeroclaw");
  mkdirSync(globalDir, { recursive: true });
  try {
    copyFileSync(configPath, join(globalDir, "config.toml"));
  } catch {
    /* mirror is best-effort */
  }

  // Pin the daemon's internal workspace dir inside `.zeroclaw/runtime/` so
  // the code view + git stay clean.
  try {
    const runtimeDir = join(appDir, ".zeroclaw", "runtime");
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(globalDir, "active_workspace.toml"), `path = "${runtimeDir}"\n`, {
      mode: 0o644,
    });
  } catch {
    /* runtime dir is best-effort; daemon will create it */
  }

  return channelToml.includes("[channels_config.");
}

// ─── Env construction ──────────────────────────────────────────────────

function buildDaemonEnv(input: {
  readonly appDir: string;
  readonly runtimeDir: string;
  readonly project: string;
}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of DAEMON_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.ZEROCLAW_CONFIG_DIR = join(input.appDir, ".zeroclaw");
  env.ZEROCLAW_WORKSPACE = input.runtimeDir;
  env.HOME = homedir();
  // The namespace spawner reads this and wraps the command in
  // `sudo ellul-agent-namespace enter <project>`.
  env[NAMESPACE_PROJECT_ENV] = input.project;
  // resource-v2: route into per-sandbox transient slice via ellul-spawn-scope.
  env[NAMESPACE_ADAPTER_ENV] = "codex";
  env[NAMESPACE_SCOPE_ID_ENV] = `zc${++_zcScopeGen}`;
  env[NAMESPACE_SOFT_HINT_MB_ENV] = String(_ZC_SOFT_HINT_MB);

  const envFile = join(homedir(), ".zeroclaw", ".env");
  if (existsSync(envFile)) {
    try {
      for (const line of readFileSync(envFile, "utf8").split("\n")) {
        const eq = line.indexOf("=");
        if (eq > 0) {
          const key = line.substring(0, eq).trim();
          const val = line.substring(eq + 1).trim();
          if (key && val && BYOK_KEY_ALLOWLIST.has(key)) env[key] = val;
        }
      }
    } catch {
      /* BYOK is optional; never fail startup if .env can't be read */
    }
  }
  return env;
}

// ─── HTTP /health probe ────────────────────────────────────────────────

async function probeHealth(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ─── WS dialog helpers ─────────────────────────────────────────────────

function stripToolXml(text: string): string {
  return text
    .replace(/<tool_call>\s*[\s\S]*?\s*<\/tool_call>/g, "")
    .replace(/<tool_result>\s*[\s\S]*?\s*<\/tool_result>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseAndEmitToolXml(
  chunk: string,
  tools: string[],
  onChunk: (chunk: ZeroClawAgentChunk) => void,
): string {
  let cleaned = chunk;
  const toolCallRegex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let match: RegExpExecArray | null;
  while ((match = toolCallRegex.exec(chunk)) !== null) {
    try {
      const parsed = JSON.parse(match[1]!);
      const toolName = String(parsed.name ?? "unknown");
      if (!tools.includes(toolName)) tools.push(toolName);
      onChunk({ type: "tool_use", tool: toolName, input: parsed.arguments });
    } catch {
      /* malformed tool_call XML — drop, keep cleaned text */
    }
    cleaned = cleaned.replace(match[0], "");
  }
  const toolResultRegex = /<tool_result>\s*([\s\S]*?)\s*<\/tool_result>/g;
  while ((match = toolResultRegex.exec(chunk)) !== null) {
    const output = match[1]!.trim();
    const lastTool = tools[tools.length - 1] ?? "unknown";
    onChunk({ type: "tool_result", tool: lastTool, output });
    cleaned = cleaned.replace(match[0], "");
  }
  return cleaned.trim() ? cleaned : "";
}

// ─── WS dialog implementation ──────────────────────────────────────────

function sendViaWebSocket(
  daemon: ZeroClawDaemonProcess,
  threadId: string,
  content: string,
  onChunk: (chunk: ZeroClawAgentChunk) => void,
): Promise<ZeroClawAgentResponse> {
  return new Promise((resolve, reject) => {
    const sessionId = `bridge_${threadId}`;
    const wsUrl = `${daemon.url.replace(/^http/, "ws")}/ws/chat?session_id=${encodeURIComponent(sessionId)}`;

    const responseText: string[] = [];
    const tools: string[] = [];
    const reasoning: string[] = [];
    let settled = false;
    let messageSent = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      settle(() => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error("WebSocket request timeout"));
      });
    }, REQUEST_TIMEOUT_MS);

    const ws = new WebSocket(wsUrl, ["zeroclaw.v1"]);

    ws.on("message", (data: Buffer | string) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      const type = msg.type as string;

      switch (type) {
        case "session_start":
        case "connected":
          if (!messageSent) {
            messageSent = true;
            ws.send(JSON.stringify({ type: "message", content }));
            onChunk({ type: "status", status: "thinking" });
          }
          break;

        case "chunk": {
          if (typeof msg.content !== "string") break;
          const cleaned = parseAndEmitToolXml(msg.content, tools, onChunk);
          if (cleaned) {
            responseText.push(cleaned);
            onChunk({ type: "text", content: cleaned });
          }
          break;
        }

        case "thinking":
          if (typeof msg.content === "string") {
            reasoning.push(msg.content);
            onChunk({ type: "reasoning", content: msg.content });
          }
          break;

        case "tool_call": {
          const toolName = (msg.name as string) || "unknown";
          if (!tools.includes(toolName)) tools.push(toolName);
          onChunk({ type: "tool_use", tool: toolName, input: msg.args });
          break;
        }

        case "tool_result":
          onChunk({
            type: "tool_result",
            tool: msg.name as string,
            output: msg.output as string,
          });
          break;

        case "done": {
          let finalText = responseText.join("");
          if (typeof msg.full_response === "string") {
            finalText = stripToolXml(msg.full_response);
          }
          onChunk({ type: "status", status: "idle" });
          settle(() => {
            try {
              ws.close();
            } catch {
              /* ignore */
            }
            resolve({ text: finalText, tools, reasoning });
          });
          break;
        }

        case "error": {
          // CRITICAL: route the daemon-emitted error through onChunk so
          // the adapter's `error` chunk handler can emit a structured
          // `runtime.error` event with class:"provider_error". Do NOT
          // reject — that's how the legacy code path collapsed every
          // upstream failure into a generic "Something went wrong"
          // string. See adapter.ts handleChunk case "error".
          const message =
            typeof msg.message === "string" && msg.message.trim().length > 0
              ? msg.message
              : "ZeroClaw daemon error";
          onChunk({ type: "error", message });
          onChunk({ type: "status", status: "idle" });
          settle(() => {
            try {
              ws.close();
            } catch {
              /* ignore */
            }
            // Resolve with an empty-text response — the error chunk
            // already informed the adapter, and the turn finalizer
            // marks it failed. Surfacing this as a promise rejection
            // would short-circuit the `done` path AND lose the error
            // class context.
            resolve({ text: "", tools, reasoning });
          });
          break;
        }
      }
    });

    ws.on("error", (err: Error) => {
      settle(() => reject(err));
    });

    ws.on("close", () => {
      settle(() => {
        const text = responseText.join("");
        if (!text.trim()) {
          reject(new Error("WebSocket connection closed before response"));
        } else {
          resolve({ text, tools, reasoning });
        }
      });
    });
  });
}

// ─── Main implementation ───────────────────────────────────────────────

const makeZeroClawRuntime = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const startDaemon: ZeroClawRuntimeShape["startDaemon"] = (input) =>
    Effect.gen(function* () {
      const sandboxDir = join(PROJECTS_DIR, input.project);
      const appDir = resolveActiveAppPath(sandboxDir) || sandboxDir;
      const runtimeDir = join(appDir, ".zeroclaw", "runtime");
      mkdirSync(runtimeDir, { recursive: true });
      ensureLogDir();
      ensureProjectConfig(appDir, input.project);

      const env = buildDaemonEnv({
        appDir,
        runtimeDir,
        project: input.project,
      });

      const startedAt = Date.now();
      logEvent("zeroclaw.spawn.begin", {
        project: input.project,
        generation: input.generation,
        port: input.port,
        bindAddress: input.bindAddress,
        hostAddress: input.hostAddress,
      });

      // `runuser -l` in the namespace wrapper strips ZEROCLAW_CONFIG_DIR;
      // pass it as a CLI flag so it survives.
      const configDir = join(appDir, ".zeroclaw");
      const command = ChildProcess.make(
        "/usr/bin/env",
        [
          `ZEROCLAW_WORKSPACE=${runtimeDir}`,
          ZEROCLAW_BINARY,
          "daemon",
          "--config-dir",
          configDir,
          "--port",
          String(input.port),
          "--host",
          input.bindAddress,
        ],
        { env, cwd: appDir },
      );

      const runtimeScope = yield* Scope.Scope;

      const child = yield* spawner.spawn(command).pipe(
        Effect.mapError(
          (cause) =>
            new ZeroClawRuntimeError({
              operation: "startDaemon",
              detail: `Failed to spawn ZeroClaw daemon: ${zeroClawRuntimeErrorDetail(cause)}`,
              cause,
            }),
        ),
      );

      // Tee stdout/stderr to the project log file. APPEND ONLY — we
      // dropped the legacy `writeFileSync(file, "")` truncate-on-spawn
      // that destroyed every predecessor's history. Pre-spawn header
      // marker (above) lets you grep `===== zeroclaw spawn` to walk
      // generation boundaries.
      writeSpawnHeader({
        project: input.project,
        generation: input.generation,
        pid: typeof child.pid === "number" ? child.pid : null,
        port: input.port,
        hostAddress: input.hostAddress,
      });
      const stdoutFiber = yield* child.stdout.pipe(
        Stream.runForEach((bytes) =>
          Effect.sync(() => appendToProjectLog(input.project, Buffer.from(bytes))),
        ),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );
      const stderrFiber = yield* child.stderr.pipe(
        Stream.runForEach((bytes) =>
          Effect.sync(() => appendToProjectLog(input.project, Buffer.from(bytes))),
        ),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );

      const baseUrl = `http://${input.hostAddress}:${input.port}`;
      const readyDeferred = yield* Deferred.make<void, ZeroClawRuntimeError>();

      // Health-poll fiber — succeed readyDeferred when /health returns 2xx.
      const healthFiber = yield* Effect.gen(function* () {
        const start = Date.now();
        while (Date.now() - start < HEALTH_TIMEOUT_MS) {
          if (yield* Effect.promise(() => probeHealth(baseUrl))) {
            yield* Deferred.succeed(readyDeferred, undefined).pipe(Effect.ignore);
            return;
          }
          yield* Effect.sleep(`${HEALTH_POLL_INTERVAL_MS} millis`);
        }
        yield* Deferred.fail(
          readyDeferred,
          new ZeroClawRuntimeError({
            operation: "startDaemon",
            detail: `ZeroClaw daemon /health did not respond within ${HEALTH_TIMEOUT_MS}ms (project=${input.project}, generation=${input.generation}).`,
          }),
        ).pipe(Effect.ignore);
      }).pipe(Effect.forkIn(runtimeScope));

      // Process-exit watcher — fail readyDeferred if the daemon dies
      // before /health passes. This is the critical race: opencode-style
      // stdout-based ready detection alone would be fooled by the daemon
      // printing "ZeroClaw daemon started" before its gateway component
      // actually binds (we observed this exact pattern in production).
      const exitWatcherFiber = yield* child.exitCode.pipe(
        Effect.flatMap((code) =>
          Deferred.fail(
            readyDeferred,
            new ZeroClawRuntimeError({
              operation: "startDaemon",
              detail: `ZeroClaw daemon exited with code ${String(code)} before /health responded (project=${input.project}, generation=${input.generation}).`,
            }),
          ).pipe(Effect.ignore),
        ),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );

      const readyExit = yield* Effect.exit(Deferred.await(readyDeferred));

      // Health/exit watchers have done their job — interrupt them so
      // they don't keep the scope busy.
      yield* Fiber.interrupt(healthFiber).pipe(Effect.ignore);
      yield* Fiber.interrupt(exitWatcherFiber).pipe(Effect.ignore);

      if (Exit.isFailure(readyExit)) {
        yield* Fiber.interrupt(stdoutFiber).pipe(Effect.ignore);
        yield* Fiber.interrupt(stderrFiber).pipe(Effect.ignore);
        const squashed = Cause.squash(readyExit.cause);
        if (ZeroClawRuntimeError.is(squashed)) {
          logEvent("zeroclaw.spawn.fail", {
            project: input.project,
            generation: input.generation,
            durationMs: Date.now() - startedAt,
            detail: squashed.detail,
          });
          return yield* Effect.fail(squashed);
        }
        const detail = zeroClawRuntimeErrorDetail(squashed);
        logEvent("zeroclaw.spawn.fail", {
          project: input.project,
          generation: input.generation,
          durationMs: Date.now() - startedAt,
          detail,
        });
        return yield* Effect.fail(
          new ZeroClawRuntimeError({
            operation: "startDaemon",
            detail,
            cause: squashed,
          }),
        );
      }

      logEvent("zeroclaw.spawn.success", {
        project: input.project,
        generation: input.generation,
        port: input.port,
        pid: typeof child.pid === "number" ? child.pid : null,
        durationMs: Date.now() - startedAt,
      });

      return {
        url: baseUrl,
        hostAddress: input.hostAddress,
        port: input.port,
        pid: typeof child.pid === "number" ? child.pid : null,
        // hasChannels is determined by the caller (pool) by polling
        // /health.runtime.components — we don't need to do it twice.
        hasChannels: false,
        generation: input.generation,
        project: input.project,
        exitCode: child.exitCode.pipe(
          Effect.map(Number),
          Effect.orElseSucceed(() => 0),
        ),
      } satisfies ZeroClawDaemonProcess;
    });

  const sendOnSession: ZeroClawRuntimeShape["sendOnSession"] = (input) =>
    Effect.tryPromise({
      try: () => {
        const content = input.systemPrompt
          ? `${input.systemPrompt}\n\n---\n\n${input.message}`
          : input.message;
        return sendViaWebSocket(
          input.daemon,
          input.threadId,
          content,
          input.onChunk,
        );
      },
      catch: (cause) =>
        new ZeroClawRuntimeError({
          operation: "sendOnSession",
          detail: zeroClawRuntimeErrorDetail(cause),
          cause,
        }),
    });

  const checkBinaryHealth: ZeroClawRuntimeShape["checkBinaryHealth"] = Effect.tryPromise({
    try: async () => {
      const { execFileSync } = await import("node:child_process");
      execFileSync(ZEROCLAW_BINARY, ["--version"], {
        timeout: 5_000,
        stdio: "pipe",
      });
      return true;
    },
    catch: () =>
      new ZeroClawRuntimeError({
        operation: "checkBinaryHealth",
        detail: "zeroclaw --version failed",
      }),
  }).pipe(Effect.orElseSucceed(() => false));

  return {
    startDaemon,
    sendOnSession,
    checkBinaryHealth,
  } satisfies ZeroClawRuntimeShape;
});

export const ZeroClawRuntimeLive = Layer.effect(
  ZeroClawRuntime,
  makeZeroClawRuntime,
);

/**
 * Probe a running daemon's `/health` endpoint and return whether it
 * has any registered channels. The pool uses this to decide whether
 * to retry the spawn when the sidecar configures channels (Discord,
 * Telegram) but the daemon's first-boot didn't pick them up.
 *
 * Best-effort — returns false on any error.
 */
export async function probeChannelReadiness(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const health = (await res.json()) as Record<string, unknown>;
    const runtime = health.runtime as Record<string, unknown> | undefined;
    const components = runtime?.components as Record<string, unknown> | undefined;
    if (!components) return false;
    return Object.keys(components).some((k) => k.startsWith("channel:"));
  } catch {
    return false;
  }
}
