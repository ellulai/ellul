// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Watchdog Service Exports
 *
 * Provides the systemd service file and server script for deployment.
 * The server.cjs content is inlined here so it works in both:
 *   - payload.ts (API server, builds provisioning script)
 *   - rebuild-all.ts (on-VPS esbuild bundle)
 */

/**
 * Get the Watchdog server script (server.cjs) content.
 * Inlined to avoid filesystem reads that break under esbuild bundling.
 */
export function getWatchdogScript(): string {
  return WATCHDOG_SERVER_CJS;
}

/**
 * Get the Watchdog systemd service file.
 * Runs the thin HTTP server (server.cjs) for gateway health + CLI auth status.
 */
export function getWatchdogService(svcUser: string = "dev", heapCapMb?: number | null): string {
  const svcHome = `/home/${svcUser}`;
  const nodeFlags = heapCapMb ? `--max-old-space-size=${heapCapMb} ` : '';
  return `[Unit]
Description=ellul ZeroClaw Agent Wrapper
After=network-online.target local-fs.target ellul-luks-boot.service
Wants=network-online.target ellul-luks-boot.service
RequiresMountsFor=/etc/ellul /opt/ellul

[Service]
Type=simple
Slice=ellul-control-plane.slice
WorkingDirectory=/opt/ellul/src/services/daemons/watchdog
# Dynamic heap sizing — EnvironmentFile provides NODE_OPTIONS when the
# provisioning-time memory tuner has written a per-host value; the
# leading dash makes the file optional so fresh installs before the
# tuner runs don't fail service start.
EnvironmentFile=-/etc/ellul/heap-caps/watchdog.env
ExecStart=/usr/bin/node ${nodeFlags}/opt/ellul/src/services/daemons/watchdog/server.cjs
Restart=always
RestartSec=5
User=${svcUser}
Group=${svcUser}
Environment=SVC_HOME=${svcHome}
Environment=SVC_USER=${svcUser}
StandardOutput=append:/var/log/ellul-watchdog.log
StandardError=append:/var/log/ellul-watchdog.log

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
PrivateTmp=true
LimitCORE=0
ReadWritePaths=/var/log/ellul-watchdog.log ${svcHome}/.agents
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true

[Install]
WantedBy=multi-user.target`;
}

// ─── Inlined server.cjs ─────────────────────────────────────────────
// Keep in sync with server.cjs (the .cjs file is the source of truth for
// local development; this string is the deployment artifact).

const WATCHDOG_SERVER_CJS = `#!/usr/bin/env node
const http = require("http");
const { exec, spawn } = require("child_process");
const { promisify } = require("util");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const execAsync = promisify(exec);

const HOST = "127.0.0.1";
const PORT = 7710;
const SVC_HOME = process.env.SVC_HOME || "/home/dev";
const SVC_USER = process.env.SVC_USER || "dev";
const AGENTS_DIR = path.join(SVC_HOME, ".agents");

// Interactive auth sessions — one PTY-wrapped CLI invocation per entry.
// Keyed by opaque sessionId. Created by POST /agents/auth/start, consumed
// by GET /agents/auth/:id/events (SSE) and POST /agents/auth/:id/input.
// The CLIs (claude setup-token, codex login, etc.) print a URL + code to
// stdout, block for the user to paste a token back on stdin, then write
// credentials to $HOME and exit. Clients surface output, collect paste,
// and tear down on process exit.
const AUTH_SESSIONS = new Map();
const AUTH_SESSION_TTL_MS = 15 * 60 * 1000;
const AUTH_COMMANDS = {
  claude: { cmd: "claude setup-token", label: "Claude" },
  codex: { cmd: "codex login", label: "Codex" },
  cursor: { cmd: "cursor-agent login", label: "Cursor" },
  gh: { cmd: "gh auth login --web", label: "GitHub" },
  npm: { cmd: "npm login", label: "npm" },
};

function reapAuthSession(id) {
  const entry = AUTH_SESSIONS.get(id);
  if (!entry) return;
  AUTH_SESSIONS.delete(id);
  try { entry.child.kill("SIGTERM"); } catch {}
  if (entry.ttlTimer) clearTimeout(entry.ttlTimer);
  for (const listener of entry.listeners) {
    try { listener({ type: "closed", reason: "reaped" }); } catch {}
  }
  entry.listeners.clear();
}

function startAuthSession(tool) {
  const entry = AUTH_COMMANDS[tool];
  if (!entry) throw new Error("Unknown tool: " + tool);
  const id = crypto.randomBytes(12).toString("hex");
  // script(1) wraps the command in a pty (util-linux); avoids needing
  // node-pty native module. -q silences the "Script started" header, -f
  // flushes every write so stdout streams in real time, -c runs the
  // command, /dev/null discards the typescript log.
  const child = spawn("script", ["-qfc", entry.cmd, "/dev/null"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, TERM: "xterm-256color", FORCE_COLOR: "0" },
  });
  const session = {
    id,
    tool,
    label: entry.label,
    child,
    output: "",
    exitCode: null,
    listeners: new Set(),
    startedAt: Date.now(),
    ttlTimer: setTimeout(() => reapAuthSession(id), AUTH_SESSION_TTL_MS),
  };
  const emit = (event) => {
    for (const listener of session.listeners) {
      try { listener(event); } catch {}
    }
  };
  const appendOutput = (chunk) => {
    const text = chunk.toString("utf8");
    session.output += text;
    if (session.output.length > 256 * 1024) {
      session.output = session.output.slice(-128 * 1024);
    }
    emit({ type: "data", chunk: text });
  };
  child.stdout.on("data", appendOutput);
  child.stderr.on("data", appendOutput);
  child.on("error", (err) => {
    emit({ type: "error", message: err.message });
  });
  child.on("exit", (code, signal) => {
    session.exitCode = code ?? (signal ? -1 : 0);
    emit({ type: "exit", exitCode: session.exitCode, signal });
    setTimeout(() => reapAuthSession(id), 10_000);
  });
  AUTH_SESSIONS.set(id, session);
  return session;
}

function writeAuthSessionInput(id, data) {
  const session = AUTH_SESSIONS.get(id);
  if (!session) return { ok: false, reason: "not_found" };
  if (session.exitCode !== null) return { ok: false, reason: "exited" };
  try {
    session.child.stdin.write(data);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

function streamAuthSessionEvents(id, res) {
  const session = AUTH_SESSIONS.get(id);
  if (!session) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Session not found" }));
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const write = (event) => {
    try {
      res.write("data: " + JSON.stringify(event) + "\\n\\n");
    } catch {}
  };
  // Replay accumulated buffer so a late subscriber sees the URL/prompt.
  if (session.output) write({ type: "data", chunk: session.output });
  if (session.exitCode !== null) {
    write({ type: "exit", exitCode: session.exitCode });
    res.end();
    return;
  }
  const listener = (event) => {
    write(event);
    if (event.type === "exit" || event.type === "closed") {
      try { res.end(); } catch {}
    }
  };
  session.listeners.add(listener);
  const heartbeat = setInterval(() => {
    try { res.write(": keepalive\\n\\n"); } catch {}
  }, 20_000);
  res.on("close", () => {
    clearInterval(heartbeat);
    session.listeners.delete(listener);
  });
}

function log(msg) {
  console.log("[" + new Date().toISOString() + "] " + msg);
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        resolve({});
      }
    });
  });
}

async function pm2List() {
  try {
    const { stdout } = await execAsync("pm2 jlist", { timeout: 10000 });
    return JSON.parse(stdout);
  } catch {
    return [];
  }
}

async function getZeroClawStatus() {
  // Per-project daemons are managed by agent-bridge — query its health endpoint
  // for authoritative per-project stats.
  const binaryExists = fs.existsSync("/usr/local/bin/zeroclaw");
  try {
    const res = await fetch("http://127.0.0.1:7700/api/internal/daemon-health", {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json();
      const daemons = data.daemons || [];
      return {
        running: binaryExists,
        status: binaryExists ? "online" : "not_installed",
        active_daemons: daemons.length,
        daemons,
      };
    }
  } catch {}
  return {
    running: binaryExists,
    status: binaryExists ? (await isAgentBridgeUp() ? "idle" : "agent_bridge_down") : "not_installed",
    active_daemons: 0,
    daemons: [],
  };
}

async function isAgentBridgeUp() {
  try {
    const res = await fetch("http://127.0.0.1:7700/health", { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch { return false; }
}

function getAuthStatus() {
  const authDir = path.join(AGENTS_DIR, ".auth");
  const tools = { claude: "claude", gh: "gh", npm: "npm" };
  const result = {};
  for (const [tool, dir] of Object.entries(tools)) {
    const toolPath = path.join(authDir, dir);
    let configured = false;
    if (fs.existsSync(toolPath)) {
      try { configured = fs.readdirSync(toolPath).length > 0; } catch {}
    }
    result[tool] = { configured, path: toolPath };
  }
  return result;
}

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split("?")[0].replace(/\\/+$/, "") || "/";
  const method = req.method;

  try {
    if (method === "GET" && urlPath === "/health") {
      const status = await getZeroClawStatus();
      return sendJson(res, 200, { status: "ok", zeroclaw: status });
    }

    if (method === "GET" && urlPath === "/zeroclaw/status") {
      return sendJson(res, 200, await getZeroClawStatus());
    }

    if (method === "POST" && urlPath === "/agents/auth-status") {
      return sendJson(res, 200, getAuthStatus());
    }

    if (method === "POST" && urlPath === "/agents/interactive-setup") {
      const body = await readBody(req);
      const tool = body.tool;
      const cmds = { claude: "claude login", gh: "gh auth login --web", npm: "npm login" };
      if (!cmds[tool]) return sendJson(res, 400, { error: "Unknown tool: " + tool });
      try {
        const { stdout, stderr } = await execAsync(cmds[tool], { timeout: 30000 });
        return sendJson(res, 200, { success: true, output: stdout + (stderr || ""), exitCode: 0 });
      } catch (e) {
        return sendJson(res, 200, { success: false, output: e.message, exitCode: 1 });
      }
    }

    if (method === "POST" && urlPath === "/agents/auth/start") {
      const body = await readBody(req);
      try {
        const session = startAuthSession(body.tool);
        return sendJson(res, 200, { sessionId: session.id, tool: session.tool, label: session.label });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    const authEventsMatch = urlPath.match(/^\\/agents\\/auth\\/([a-f0-9]{24})\\/events$/);
    if (method === "GET" && authEventsMatch) {
      streamAuthSessionEvents(authEventsMatch[1], res);
      return;
    }

    const authInputMatch = urlPath.match(/^\\/agents\\/auth\\/([a-f0-9]{24})\\/input$/);
    if (method === "POST" && authInputMatch) {
      const body = await readBody(req);
      const raw = typeof body.data === "string" ? body.data : "";
      const result = writeAuthSessionInput(authInputMatch[1], raw);
      if (!result.ok) return sendJson(res, 400, { error: result.reason });
      return sendJson(res, 200, { ok: true });
    }

    const authCancelMatch = urlPath.match(/^\\/agents\\/auth\\/([a-f0-9]{24})\\/cancel$/);
    if (method === "POST" && authCancelMatch) {
      reapAuthSession(authCancelMatch[1]);
      return sendJson(res, 200, { ok: true });
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (e) {
    log("ERROR: " + e.message);
    sendJson(res, 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  log("Agent wrapper listening on " + HOST + ":" + PORT);
});

process.on("SIGTERM", () => {
  log("Shutting down...");
  server.close();
  process.exit(0);
});

process.on("SIGINT", () => {
  log("Shutting down...");
  server.close();
  process.exit(0);
});
`;
