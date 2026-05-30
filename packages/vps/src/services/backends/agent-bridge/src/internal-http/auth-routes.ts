// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.
//
// Interactive CLI auth sessions. The UI calls these via the sovereign-
// shield proxy (/_auth/bridge/agents/auth/*) to run `claude setup-token`
// / `codex login` / `cursor-agent login` in a real pty on the server,
// stream stdout/stderr back as SSE, and forward paste-prompts via POST.
//
// Anthropic's official setup docs[1] for headless / CI environments
// recommend exactly two auth methods:
//   1. ANTHROPIC_API_KEY (direct API key)
//   2. CLAUDE_CODE_OAUTH_TOKEN obtained via `claude setup-token`
// Both are long-lived secrets pasted into a secret store. The doc does
// NOT specify a programmatic OAuth/PKCE flow — it expects an interactive
// pty for `claude setup-token`. We mirror that on the server: spawn the
// same CLI in a pty, scrape the printed token, persist it to the same
// ~/.claude.json field the SDK reads. Functionally identical to running
// it on a laptop and pasting the result, just automated.
//
// We use `script -qfc "<cmd>" /dev/null` (util-linux) as a pty wrapper
// so there's no node-pty native-module dependency. Ink-based CLIs
// (claude) require a real tty for setRawMode; `script` gives them one.
//
// The agent-bridge process runs as `dev`, so spawned CLIs resolve to
// /home/dev/.node/bin/claude and write credentials to /home/dev/.claude
// — the same home that agent-bridge re-spawns `claude -p` from when
// generating thread titles or running turns.
//
// [1] github.com/anthropics/claude-code-action/blob/main/docs/setup.md

import type { IncomingMessage, ServerResponse } from "http";
import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "child_process";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";

import { claudeLaunchTrace } from "../../../../shared/claude-launch-trace";
import { getClaudeOatBridgeModule } from "../credentials/claude-oat/public";
import { IS_ANDROID } from "@vps/shared/platform";

function triggerProviderRefresh(): void {
  fetch('http://127.0.0.1:7700/api/internal/providers/refresh', { method: 'POST' }).catch(() => {});
}

const SESSION_TTL_MS = 15 * 60 * 1000;
const OUTPUT_BUFFER_BYTES = 256 * 1024;
const OUTPUT_TRIM_BYTES = 128 * 1024;

const DEBUG_LOG = "/tmp/ellul-auth-debug.log";
function dlog(event: string, data?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const safe = data ? JSON.stringify(data, (_k, v) => {
    if (typeof v === "string" && /sk-ant-[a-z0-9]+-/.test(v)) {
      return v.slice(0, 20) + "…[redacted]";
    }
    return v;
  }) : "";
  try {
    fs.appendFileSync(DEBUG_LOG, `${ts} [auth] ${event} ${safe}\n`);
  } catch {}
}

type AuthTool = "claude" | "codex" | "cursor" | "grok" | "gh" | "npm";

// `script` spawns a fresh pty with its own winsize (default 80×24) and
// ignores COLUMNS/LINES on the parent env. The OAuth URLs these CLIs
// emit are ~380+ chars and WILL wrap at 80 cols, which gives users a
// truncated URL → "Missing redirect_uri parameter" on Anthropic's
// side. Setting winsize INSIDE the pty via `stty cols` before exec
// guarantees the child sees a wide terminal and emits URLs on a
// single line.
const STTY_WIDE = "stty cols 400 rows 30 2>/dev/null";

// `claude setup-token` is Anthropic's documented headless / CI auth
// flow for Pro and Max subscribers (see file header for citation).
// codex login --device-auth switches it to the headless device-code
// flow; the default uses a loopback callback that won't reach the user's
// laptop from a remote VPS.
const AUTH_COMMANDS: Record<AuthTool, { readonly cmd: string; readonly label: string }> = {
  claude: { cmd: `${STTY_WIDE}; exec claude setup-token`, label: "Claude" },
  codex: { cmd: `${STTY_WIDE}; exec codex login --device-auth`, label: "Codex" },
  cursor: { cmd: `${STTY_WIDE}; exec cursor-agent login`, label: "Cursor" },
  grok: { cmd: `${STTY_WIDE}; exec grok login --device-auth`, label: "Grok Build" },
  gh: { cmd: `${STTY_WIDE}; exec gh auth login --web`, label: "GitHub" },
  npm: { cmd: `${STTY_WIDE}; exec npm login`, label: "npm" },
};

// Android proot: externally-installed CLI binaries get wrong SELinux
// context (shell_data_file vs app_data_file), causing EPERM on execve.
// Bypass: node-based CLIs invoke via `node /path/to/entry.js` (read,
// not execute). ELF binaries use engine-cached copies at
// /tmp/.ellul-cli-cache/ (created by app process → correct context).
const AUTH_COMMANDS_ANDROID: Record<AuthTool, { readonly cmd: string; readonly label: string }> = {
  claude: { cmd: `${STTY_WIDE}; /tmp/.ellul-cli-cache/claude setup-token`, label: "Claude" },
  codex: { cmd: `/tmp/.ellul-cli-cache/codex login --device-auth`, label: "Codex" },
  cursor: { cmd: `${STTY_WIDE}; /tmp/.ellul-cli-cache/cursor-agent login`, label: "Cursor" },
  grok: { cmd: `/tmp/.ellul-cli-cache/grok login --device-auth`, label: "Grok Build" },
  gh: { cmd: `gh auth login --web`, label: "GitHub" },
  npm: { cmd: `npm login`, label: "npm" },
};

type StreamEvent =
  | { readonly type: "data"; readonly chunk: string }
  | { readonly type: "exit"; readonly exitCode: number; readonly signal?: string | null }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "closed"; readonly reason: string };

interface AuthSession {
  readonly id: string;
  readonly tool: AuthTool;
  readonly label: string;
  readonly child: ChildProcessWithoutNullStreams;
  output: string;
  exitCode: number | null;
  exitEmitted: boolean;
  readonly listeners: Set<(event: StreamEvent) => void>;
  readonly startedAt: number;
  /** mtime (ms) of the tool's credential file at session start, or 0 if
   *  absent. Success requires a NEWER write (real login), so a stale
   *  credential file can't trigger a false success. */
  readonly authBaselineMtime: number;
  ttlTimer: NodeJS.Timeout | null;
  authPollTimer: NodeJS.Timeout | null;
  /** Set once the PTY scrape extracts the OAT from `claude setup-token`
   *  stdout and forwards it to shield's /save endpoint. */
  capturedOat: string | null;
  /** Tracks the in-flight save so the exit handler can avoid racing
   *  the cache TTL: pending = save in progress, ok = shield 200, failed = save error. */
  oatSaveStatus: "pending" | "ok" | "failed" | null;
}

// Phrase-anchored — matches the OAT only when it appears in the position
// `claude setup-token` actually prints it. Resilient to ANSI/whitespace
// noise around the token; resilient to spurious `sk-ant-oat01-…` strings
// elsewhere in the buffer (e.g. echoed back as part of help text).
const OAT_ANCHORED_REGEX =
  /OAuth token \(valid for [^)]+\):\s*(sk-ant-oat01-[A-Za-z0-9_-]{60,200})/;
// Unanchored fallback for output-format drift. Same shape as the strict
// pattern; accepted only when the match passes OAT_STRICT_REGEX below.
const OAT_FALLBACK_REGEX = /sk-ant-oat01-[A-Za-z0-9_-]{60,200}/;
// Final validation — every scrape match must round-trip through this
// before we forward to shield, regardless of which regex caught it.
const OAT_STRICT_REGEX = /^sk-ant-oat01-[A-Za-z0-9_-]{60,200}$/;
// ESC-bracket sequences emitted by Ink/claude's TUI.
const ANSI_STRIP_REGEX = /\x1B\[[0-?]*[ -\/]*[@-~]/g;

const sessions = new Map<string, AuthSession>();

const SAVE_RESOLUTION_TIMEOUT_MS = 5_000;

// If the scrape kicked off a save before the CLI exited, wait for it to
// resolve before deciding the exit code. Without this, a save that
// returns 200 just after the CLI exits would surface as `exit code 2`
// (cache-stale race) — we already saw that fail mode in production.
async function waitForSaveResolution(session: AuthSession): Promise<void> {
  if (session.tool !== "claude") return;
  if (session.oatSaveStatus !== "pending") return;
  const start = Date.now();
  await new Promise<void>((resolve) => {
    const tick = setInterval(() => {
      if (
        session.oatSaveStatus !== "pending" ||
        session.exitEmitted ||
        Date.now() - start > SAVE_RESOLUTION_TIMEOUT_MS
      ) {
        clearInterval(tick);
        resolve();
      }
    }, 50);
  });
}

async function handleChildExit(
  session: AuthSession,
  id: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  emit: (event: StreamEvent) => void,
): Promise<void> {
  dlog("child.exit", {
    id,
    code,
    signal,
    exitEmitted: session.exitEmitted,
    outputLen: session.output.length,
    oatSaveStatus: session.oatSaveStatus,
  });
  await waitForSaveResolution(session);
  if (session.exitEmitted) {
    // Scrape callback emitted success while we were waiting (or already had).
    setTimeout(() => reapSession(id, "exit"), 10_000);
    return;
  }
  const probe = AUTH_PROBES[session.tool];
  const authed =
    (session.tool === "claude" && session.oatSaveStatus === "ok") ||
    (probe ? probe(session) : false) ||
    (code === 0 && !NEEDS_PTY.has(session.tool));
  dlog("child.exit.probed", {
    id,
    authed,
    oatSaveStatus: session.oatSaveStatus,
    outputTail: session.output.slice(-500),
  });
  let resolved: number;
  if (signal) resolved = -1;
  else if (code === 0 && !authed) resolved = 2;
  else resolved = code ?? 0;
  session.exitCode = resolved;
  session.exitEmitted = true;
  if (authed) triggerProviderRefresh();
  dlog("child.exit.emit", { id, resolvedCode: resolved });
  emit({ type: "exit", exitCode: resolved, signal: signal ?? null });
  setTimeout(() => reapSession(id, "exit"), 10_000);
}

function reapSession(id: string, reason: string): void {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  try {
    session.child.kill("SIGTERM");
  } catch {}
  if (session.ttlTimer) clearTimeout(session.ttlTimer);
  if (session.authPollTimer) clearInterval(session.authPollTimer);
  for (const listener of session.listeners) {
    try {
      listener({ type: "closed", reason });
    } catch {}
  }
  session.listeners.clear();
}

// Device-code tools don't need a pty — spawning without `script` avoids
// the pty session cleanup that can prematurely kill the polling process.
const NEEDS_PTY: ReadonlySet<AuthTool> = new Set(["claude", "cursor"]);

function startSession(tool: AuthTool): AuthSession {
  const commands = IS_ANDROID ? AUTH_COMMANDS_ANDROID : AUTH_COMMANDS;
  const entry = commands[tool];
  const id = randomBytes(12).toString("hex");
  const usePty = !IS_ANDROID || NEEDS_PTY.has(tool);
  // Snapshot the credential file's mtime BEFORE the login spawns, so a stale
  // file can't trigger a false success — only a newer write counts (see
  // freshAuthWritten / AUTH_PROBES).
  const authBaselineMtime = authFileMtime(tool);
  dlog("startSession.spawn", { id, tool, cmd: entry.cmd, android: IS_ANDROID, usePty, authBaselineMtime });
  const spawnEnv = {
    ...process.env,
    TERM: "xterm-256color",
    FORCE_COLOR: "0",
    COLUMNS: "2000",
    LINES: "30",
  };
  const child = usePty
    ? spawn("script", ["-qfc", entry.cmd, "/dev/null"], {
        stdio: ["pipe", "pipe", "pipe"],
        detached: !IS_ANDROID,
        env: spawnEnv,
      })
    : spawn("sh", ["-c", entry.cmd], {
        stdio: ["pipe", "pipe", "pipe"],
        env: spawnEnv,
      });
  dlog("startSession.spawned", { id, pid: child.pid, usePty });
  const session: AuthSession = {
    id,
    tool,
    label: entry.label,
    child,
    output: "",
    exitCode: null,
    exitEmitted: false,
    listeners: new Set(),
    startedAt: Date.now(),
    authBaselineMtime,
    ttlTimer: null,
    authPollTimer: null,
    capturedOat: null,
    oatSaveStatus: null,
  };
  session.ttlTimer = setTimeout(() => reapSession(id, "ttl"), SESSION_TTL_MS);

  const emit = (event: StreamEvent): void => {
    for (const listener of session.listeners) {
      try {
        listener(event);
      } catch {}
    }
  };
  const appendOutput = (chunk: Buffer): void => {
    const text = chunk.toString("utf8");
    session.output += text;
    if (session.output.length > OUTPUT_BUFFER_BYTES) {
      session.output = session.output.slice(-OUTPUT_TRIM_BYTES);
    }
    emit({ type: "data", chunk: text });
    // Auto-capture the OAT printed by `claude setup-token` and forward
    // it to shield. The earlier comment said this scrape was removed;
    // without it the user gets a token printed but nothing stores it,
    // every subsequent claude turn fails with shield's 423
    // credential-not-active. Restored: ANSI-strip the buffer, drop
    // whitespace (terminal wrap can split the token), match once.
    if (session.tool === "claude" && !session.capturedOat) {
      // ANSI-strip but preserve whitespace — whitespace is the only reliable
      // boundary between the printed OAT and the surrounding "Store this
      // token securely…" prose. Try the phrase-anchored pattern first;
      // fall back to bare format only if the anchor changes upstream.
      const cleaned = session.output.replace(ANSI_STRIP_REGEX, "");
      const anchored = OAT_ANCHORED_REGEX.exec(cleaned);
      const fallback = anchored ? null : OAT_FALLBACK_REGEX.exec(cleaned);
      const match = anchored ? anchored[1] : fallback?.[0];
      const matchSource: "anchored" | "fallback" | null = anchored
        ? "anchored"
        : fallback
          ? "fallback"
          : null;
      if (match && OAT_STRICT_REGEX.test(match)) {
        const oat = match;
        session.capturedOat = oat;
        session.oatSaveStatus = "pending";
        const tr = `auth:${id}`;
        claudeLaunchTrace("bridge", tr, "oat-scrape-found", {
          sessionId: id,
          tokenLen: oat.length,
          tokenPrefix: oat.slice(0, 20),
          matchSource,
        });
        dlog("oat-auto-captured", { id, tokenPrefix: oat.slice(0, 20) });
        void getClaudeOatBridgeModule()
          .proxySaveToken({ token: oat, sessionId: id })
          .then((res) => {
            session.oatSaveStatus = res.ok ? "ok" : "failed";
            claudeLaunchTrace("bridge", tr, "oat-scrape-saved", {
              ok: res.ok,
              status: "status" in res ? res.status : null,
            });
            dlog("oat-auto-saved", { id, ok: res.ok });
            // Drive success directly. The 1Hz auth poll's `isAuthed()` reads
            // a 1s-TTL cache that may still be stale; the CLI also exits
            // within ms of printing the token, racing the poll. Emitting
            // exit:0 here cuts both races out — we know we captured the
            // token AND shield accepted it.
            if (res.ok && !session.exitEmitted) {
              session.exitCode = 0;
              session.exitEmitted = true;
              triggerProviderRefresh();
              claudeLaunchTrace("bridge", tr, "oat-scrape-emit-success", {
                sessionId: id,
              });
              for (const listener of session.listeners) {
                try {
                  listener({ type: "exit", exitCode: 0, signal: null });
                } catch {}
              }
              try {
                session.child.kill("SIGTERM");
              } catch {}
              setTimeout(() => reapSession(session.id, "oat-scrape-saved"), 1000);
            }
          })
          .catch((err) => {
            session.oatSaveStatus = "failed";
            claudeLaunchTrace("bridge", tr, "oat-scrape-save-failed", {
              error: (err as Error).message,
            });
            dlog("oat-auto-save-failed", { id, error: (err as Error).message });
          });
      }
    }
  };
  child.stdout.on("data", appendOutput);
  child.stderr.on("data", appendOutput);
  child.on("error", (err) => emit({ type: "error", message: err.message }));
  child.on("exit", (code, signal) => {
    void handleChildExit(session, id, code, signal, emit);
  });

  sessions.set(id, session);
  // Start polling immediately — device-code flows (codex, grok) complete
  // via browser auth, so writeSessionInput is never called and the poll
  // that lived there never started.
  startAuthFilePolling(session);
  return session;
}

// Ink (claude) + other TUI CLIs read keystrokes one-at-a-time in raw
// mode. Writing a long paste in a single `stdin.write` call dumps every
// byte into the pty master's buffer; the kernel delivers them to the
// child faster than Ink's React reducer can consume them, and the
// following CR (Enter) races the tail of the input. The CLI commits a
// truncated code, then the trailing bytes land on the *next* prompt as
// literal text.
const INTER_CHAR_MS = 15;
const COMMIT_DELAY_MS = 250;

function writeSessionInput(id: string, data: string): { ok: boolean; reason?: string } {
  const session = sessions.get(id);
  if (!session) return { ok: false, reason: "not_found" };
  if (session.exitCode !== null) return { ok: false, reason: "exited" };
  const trimmed = data.replace(/[\r\n]+$/g, "");
  const child = session.child;

  let i = 0;
  const typeNext = (): void => {
    if (session.exitCode !== null) return;
    if (i >= trimmed.length) {
      setTimeout(() => {
        if (session.exitCode !== null) return;
        try {
          child.stdin.write("\r");
        } catch {}
      }, COMMIT_DELAY_MS);
      return;
    }
    try {
      child.stdin.write(trimmed.charAt(i));
    } catch {}
    i += 1;
    setTimeout(typeNext, INTER_CHAR_MS);
  };
  typeNext();
  startAuthFilePolling(session);
  return { ok: true };
}

// Greenfield: claude OAT no longer lives in ~/.claude.json. The credential
// subsystem (sovereign-shield owns it) is the sole source of truth; bridge
// proxies user save/revoke to shield's HTTP API. The PTY scrape (in
// `appendOutput` above) auto-forwards the token printed by `claude
// setup-token` to shield's /save endpoint so users don't have to copy-
// paste it back into the modal manually.
//
// AUTH_PROBES.claude consults the bounded-context's auth-state cache,
// which keeps a 1s-TTL view of shield's /peek response. Once the scrape
// saves the token, the cache flips authed → poll succeeds → session
// terminates with synthetic exit:0 → modal fires onSuccess.

// Relative path (under $HOME) of the credential file each CLI writes on a
// successful login. null = not file-based (claude scrapes the OAT instead).
const AUTH_FILE_BY_TOOL: Record<AuthTool, string | null> = {
  claude: null,
  codex: ".codex/auth.json",
  cursor: ".config/cursor/auth.json",
  grok: ".grok/auth.json",
  gh: ".config/gh/hosts.yml",
  npm: ".npmrc",
};

function authFileMtime(tool: AuthTool): number {
  const rel = AUTH_FILE_BY_TOOL[tool];
  if (!rel) return 0;
  const home = process.env.HOME ?? "/home/dev";
  try {
    return fs.statSync(path.join(home, rel)).mtimeMs;
  } catch {
    return 0;
  }
}

// Require a FRESH credential write, not mere existence. A stale auth.json
// from a prior (now-invalid) login persists on disk — codex even reports it
// with `requiresOpenaiAuth: true`. existsSync() fired a false success the
// instant `codex login` started, SIGTERM-ing it before it could print the
// device code (the user never got to authenticate). Comparing against the
// mtime captured at session start means the poll only succeeds once the CLI
// actually rewrites the file as part of a real login.
function freshAuthWritten(session: AuthSession | undefined, tool: AuthTool): boolean {
  if (!session) return false;
  return authFileMtime(tool) > session.authBaselineMtime;
}

const AUTH_PROBES: Record<AuthTool, (session?: AuthSession) => boolean> = {
  claude: () => getClaudeOatBridgeModule().authStateCache.isAuthed(),
  codex: (s) => freshAuthWritten(s, "codex"),
  cursor: (s) => freshAuthWritten(s, "cursor"),
  grok: (s) => freshAuthWritten(s, "grok"),
  gh: (s) => freshAuthWritten(s, "gh"),
  npm: (s) => freshAuthWritten(s, "npm"),
};

function startAuthFilePolling(session: AuthSession): void {
  if (session.authPollTimer || session.exitCode !== null) return;
  const probe = AUTH_PROBES[session.tool];
  if (!probe) return;
  let tick = 0;
  session.authPollTimer = setInterval(() => {
    tick += 1;
    if (tick > 45 || session.exitCode !== null) {
      if (session.authPollTimer) {
        clearInterval(session.authPollTimer);
        session.authPollTimer = null;
      }
      return;
    }
    if (probe(session)) {
      if (session.authPollTimer) {
        clearInterval(session.authPollTimer);
        session.authPollTimer = null;
      }
      session.exitCode = 0;
      session.exitEmitted = true;
      triggerProviderRefresh();
      for (const listener of session.listeners) {
        try {
          listener({ type: "exit", exitCode: 0, signal: null });
        } catch {}
      }
      try {
        session.child.kill("SIGTERM");
      } catch {}
      setTimeout(() => reapSession(session.id, "auth-detected"), 1000);
    }
  }, 1000);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
    if (chunks.reduce((sum, c) => sum + c.length, 0) > 32 * 1024) break;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (!res.headersSent) {
    res.writeHead(status, { "Content-Type": "application/json" });
  }
  res.end(JSON.stringify(body));
}

export async function handleAuthStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const tool = body.tool as string | undefined;
  if (!tool || !(tool in AUTH_COMMANDS)) {
    sendJson(res, 400, { error: "Unknown tool" });
    return;
  }
  const session = startSession(tool as AuthTool);
  sendJson(res, 200, { sessionId: session.id, tool: session.tool, label: session.label });
}

export async function handleAuthEvents(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const id = url.searchParams.get("id");
  if (!id || !sessions.has(id)) {
    sendJson(res, 404, { error: "Session not found" });
    return;
  }
  const session = sessions.get(id)!;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const write = (event: StreamEvent): void => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {}
  };
  if (session.output) write({ type: "data", chunk: session.output });
  if (session.exitCode !== null) {
    write({ type: "exit", exitCode: session.exitCode });
    res.end();
    return;
  }
  const listener = (event: StreamEvent): void => {
    write(event);
    if (event.type === "exit" || event.type === "closed") {
      try {
        res.end();
      } catch {}
    }
  };
  session.listeners.add(listener);
  const heartbeat = setInterval(() => {
    try {
      res.write(": keepalive\n\n");
    } catch {}
  }, 20_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    session.listeners.delete(listener);
  });
}

export async function handleAuthInput(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const id = url.searchParams.get("id");
  if (!id) {
    sendJson(res, 400, { error: "id required" });
    return;
  }
  const body = await readJsonBody(req);
  const data = typeof body.data === "string" ? body.data : "";
  const result = writeSessionInput(id, data);
  if (!result.ok) {
    sendJson(res, 400, { error: result.reason });
    return;
  }
  sendJson(res, 200, { ok: true });
}

export async function handleAuthCancel(
  _req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const id = url.searchParams.get("id");
  if (!id) {
    sendJson(res, 400, { error: "id required" });
    return;
  }
  reapSession(id, "cancel");
  sendJson(res, 200, { ok: true });
}

// Direct OAT-token install + user logout.
//
// Both handlers are thin re-exports of the bounded-context's interface
// layer. The route registration in internal-http/index.ts wires them via
// the shared module instance.
export const handleAuthClaudeToken = (() => {
  let cached: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | null = null;
  return (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!cached) {
      // Lazy: the bounded-context module is built on first reference at
      // bridge startup. Importing the handler factory here keeps the
      // route table in internal-http/index.ts unchanged in shape.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { makeClaudeTokenHandler } = require("../credentials/claude-oat/public") as
        typeof import("../credentials/claude-oat/public");
      cached = makeClaudeTokenHandler(getClaudeOatBridgeModule());
    }
    return cached(req, res);
  };
})();

export const handleAuthClaudeLogout = (() => {
  let cached: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | null = null;
  return (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!cached) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { makeClaudeLogoutHandler } = require("../credentials/claude-oat/public") as
        typeof import("../credentials/claude-oat/public");
      cached = makeClaudeLogoutHandler(getClaudeOatBridgeModule());
    }
    return cached(req, res);
  };
})();
