#!/usr/bin/env node
// Android proot engine — starts VPS services without systemd.
// Entry point: /usr/local/bin/ellul-engine-android → this file.

const { spawn, execSync: execSyncRaw } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const net = require("net");

const VAULT = "/root/ellul-vault";
const SERVICES_DIR = "/opt/ellul/releases";
const NODE = process.execPath;

const SYMLINKS = [
  [path.join(VAULT, "etc/ellul"), "/etc/ellul"],
  [path.join(VAULT, "etc/caddy"), "/etc/caddy"],
  [path.join(VAULT, "var/log/ellul"), "/var/log/ellul"],
  [path.join(VAULT, "var/log/caddy"), "/var/log/caddy"],
  [path.join(VAULT, "var/lib/ellul-shielded"), "/var/lib/ellul-shielded"],
  [path.join(VAULT, "var/lib/postgresql"), "/var/lib/postgresql"],
];

const ENSURE_DIRS = [
  "/run/shield",
  "/run/caddy",
  "/etc/ellul-bootstrap",
  "/var/log/ellul",
  "/var/log/caddy",
  "/tmp",
  "/etc/ellul/agent-bridge",
  "/home/dev/projects",
  "/home/dev/.ellul",
  "/home/dev/.local/share",
  "/home/dev/.cache/opencode-bun",
];


const CADDY_BIN = "/usr/local/bin/caddy";
const CADDYFILE_PATH = path.join(VAULT, "etc/caddy/Caddyfile");
const CADDY_DIRS = [
  path.join(VAULT, "etc/caddy"),
  path.join(VAULT, "etc/caddy/agents.d"),
  path.join(VAULT, "etc/caddy/app-routes.d"),
  path.join(VAULT, "var/log/caddy"),
];

const SERVICES = [
  {
    name: "sovereign-shield",
    bundle: "sovereign-shield.js",
    port: 3005,
    healthPath: "/_auth/health",
    pipeVaultKey: true,
  },
  {
    name: "file-api",
    bundle: "file-api.js",
    port: 3002,
    healthPath: "/health",
  },
  {
    name: "agent-bridge",
    bundle: "agent-bridge.js",
    port: 7700,
  },
  {
    name: "caddy",
    command: CADDY_BIN,
    args: ["run", "--config", CADDYFILE_PATH],
    port: 8443,
  },
];

const children = new Map();
let shuttingDown = false;

function log(msg) {
  console.log(`[engine] ${msg}`);
}

const CONSOLE_UPSTREAM = process.env.ELLUL_CONSOLE_ORIGIN || "https://console.ellul.ai";
const CONSOLE_ORIGIN = "http://localhost:8443";

const CLI_VERSIONS = {
  opencode: "1.14.29",
  claudeCode: "2.1.116",
  codex: "0.133.0",
  cursorAgent: "2026.04.17-787b533",
  lazygit: "0.60.0",
};

function run(cmd, opts = {}) {
  return execSyncRaw(cmd, { stdio: "pipe", timeout: 120_000, ...opts }).toString().trim();
}

function generateCaddyfile() {
  for (const dir of CADDY_DIRS) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (fs.existsSync(CADDYFILE_PATH)) {
    log("overwriting existing caddyfile (engine owns port config)");
  }
  const SHIELD = "127.0.0.1:3005";
  const FILE_API = "127.0.0.1:3002";
  const BRIDGE = "127.0.0.1:7700";
  const TERM = "127.0.0.1:7701";
  // Delete stale autosave that can override admin config
  const autosavePath = "/home/dev/.config/caddy/autosave.json";
  try { fs.unlinkSync(autosavePath); log("deleted caddy autosave.json"); } catch {}

  const content = `{
    admin 127.0.0.1:2019
    auto_https off
    persist_config off
}

import ${path.join(VAULT, "etc/caddy/app-routes.d/*.caddy")}

(auth_gate) {
    forward_auth ${SHIELD} {
        uri /api/auth/session
        header_up Cookie {http.request.header.Cookie}
        header_up Authorization {http.request.header.Authorization}
        header_up Accept {http.request.header.Accept}
        header_up X-PoP-Signature {http.request.header.X-PoP-Signature}
        header_up X-PoP-Timestamp {http.request.header.X-PoP-Timestamp}
        header_up X-PoP-Nonce {http.request.header.X-PoP-Nonce}
        header_up X-PoP-BodyHash {http.request.header.X-PoP-BodyHash}
        header_up X-Forwarded-Method {method}
        header_up User-Agent {http.request.header.User-Agent}
        header_up X-Forwarded-Uri {uri}
        header_up -X-Auth-User
        header_up -X-Auth-Tier
        header_up -X-Auth-Session
        copy_headers X-Auth-User X-Auth-Tier X-Auth-Session X-Auth-Timestamp X-Auth-HMAC
    }
}

http://localhost:8443, http://127.0.0.1:8443 {
    @options method OPTIONS
    handle @options {
        header Access-Control-Allow-Origin "*"
        header Access-Control-Allow-Methods "GET, POST, PUT, DELETE, OPTIONS"
        header Access-Control-Allow-Headers "Content-Type, Authorization, Cookie, X-Code-Token, X-PoP-Signature, X-PoP-Timestamp, X-PoP-Nonce, X-STS-Token"
        header Access-Control-Allow-Credentials "true"
        respond "" 204
    }

    handle /vps-config.js {
        header Content-Type "application/javascript"
        header Cache-Control "no-store"
        respond ${"`"}window.__ELLUL_CONFIG__=${JSON.stringify({platformZone:"localhost",appZone:"ellul.app",consoleOrigin:CONSOLE_ORIGIN,wsOrigin:"http://localhost:8443",codeWsOrigin:"http://localhost:8443",codeWsPath:"/code-ws",platform:"android",disabledSessions:["claw"]})};${"`"} 200
    }

    @shieldDirect path /_auth/login* /_auth/register* /_auth/recovery* /_auth/standard-upgrade* /_auth/bridge /_auth/bridge/tier /_auth/bridge/session /_auth/code/redirect /_auth/code/session /_auth/code/establish /_auth/terminal/authorize /_auth/agent/authorize /_auth/code/authorize /_auth/pop/* /_auth/static/* /_auth/capabilities /_auth/verify-confirmation /_auth/git/verify-link-token /_auth/git/verify-unlink-token /_auth/wake-enforcer /_auth/tauri/token-login /_auth/byos/token /_auth/chat /_auth/upgrade-to-web-locked /_auth/upgrade-to-web-locked/verify /health /_auth/health
    handle @shieldDirect {
        reverse_proxy ${SHIELD}
    }

    handle /_auth/* {
        import auth_gate
        reverse_proxy ${SHIELD} {
            flush_interval -1
        }
    }

    handle /ws {
        reverse_proxy ${BRIDGE} {
            flush_interval -1
        }
    }

    handle /code-ws {
        rewrite * /ws
        reverse_proxy ${FILE_API} {
            flush_interval -1
        }
    }

    handle /browser {
        import auth_gate
        reverse_proxy ${FILE_API}
    }

    handle /browser/* {
        import auth_gate
        reverse_proxy ${FILE_API}
    }

    handle /api/internal/* {
        reverse_proxy ${BRIDGE}
    }

    handle /api/* {
        import auth_gate
        reverse_proxy ${FILE_API}
    }

    handle /terminal/* {
        import auth_gate
        reverse_proxy ${TERM}
    }

    handle /term/* {
        import auth_gate
        reverse_proxy ${TERM}
    }

    handle /agent/* {
        reverse_proxy ${BRIDGE}
    }

    handle {
        reverse_proxy 127.0.0.1:${CONSOLE_PROXY_PORT}
    }

    log {
        output file /var/log/caddy/access.log
        format json
    }
}
`;
  fs.writeFileSync(CADDYFILE_PATH, content);
  log("generated caddyfile (high ports, localhost)");
}

function setupFilesystem() {
  for (const dir of ENSURE_DIRS) {
    fs.mkdirSync(dir, { recursive: true });
  }

  for (const [target, link] of SYMLINKS) {
    if (!fs.existsSync(target)) continue;
    try {
      const existing = fs.lstatSync(link);
      if (existing.isSymbolicLink()) {
        fs.unlinkSync(link);
      } else if (existing.isDirectory()) {
        // Non-empty directory from rootfs — remove it so symlink can be created
        fs.rmSync(link, { recursive: true, force: true });
      }
    } catch {}
    try {
      fs.symlinkSync(target, link, "dir");
      log(`symlink ${link} → ${target}`);
    } catch (e) {
      log(`symlink failed ${link}: ${e.message}`);
    }
  }

  // DNS — rootfs built in Docker ships with Docker's DNS (192.168.x.x) which doesn't exist on Android
  fs.writeFileSync("/etc/resolv.conf", "nameserver 8.8.8.8\nnameserver 8.8.4.4\n");
  log("wrote /etc/resolv.conf");

  // Ensure bootstrap files exist (dummy values for local)
  const bootstrap = "/etc/ellul-bootstrap";
  if (!fs.existsSync(path.join(bootstrap, "server-id"))) {
    fs.writeFileSync(path.join(bootstrap, "server-id"), "android-local");
  }

  const nodeKeyPath = path.join(bootstrap, "node.key");
  const nodePubPath = path.join(bootstrap, "node.pub");
  let needsPqcKeygen = true;
  if (fs.existsSync(nodePubPath)) {
    try {
      const pub = JSON.parse(fs.readFileSync(nodePubPath, "utf8"));
      if (pub.version === 3 && pub.algorithm === "X25519+ML-KEM-1024") needsPqcKeygen = false;
    } catch {}
  }
  if (needsPqcKeygen) {
    const keygenSrc = `
import { x25519 } from "@noble/curves/ed25519.js";
import { ml_kem1024 } from "@noble/post-quantum/ml-kem.js";
import { writeFileSync } from "node:fs";
const sk = x25519.utils.randomSecretKey();
const pk = x25519.getPublicKey(sk);
const { publicKey: ek, secretKey: dk } = ml_kem1024.keygen();
const ts = new Date().toISOString();
const b = (a) => Buffer.from(a).toString("base64");
writeFileSync(process.argv[2], JSON.stringify({ version: 3, algorithm: "X25519+ML-KEM-1024", x25519_sk: b(sk), mlkem_dk: b(dk), created_at: ts }), { mode: 0o600 });
writeFileSync(process.argv[3], JSON.stringify({ version: 3, algorithm: "X25519+ML-KEM-1024", x25519_pk: b(pk), mlkem_ek: b(ek), created_at: ts }), { mode: 0o644 });
`;
    const tmpKeygen = "/usr/lib/.ellul-pqc-keygen.mjs";
    fs.writeFileSync(tmpKeygen, keygenSrc);
    try {
      execSyncRaw(`${NODE} "${tmpKeygen}" "${nodeKeyPath}" "${nodePubPath}"`, {
        stdio: "pipe",
        env: { ...process.env, NODE_PATH: "/usr/lib/node_modules" },
      });
      log("generated PQC keypair (X25519+ML-KEM-1024)");
    } catch (e) {
      log(`WARN: PQC keygen failed: ${e.message}`);
    } finally {
      try { fs.unlinkSync(tmpKeygen); } catch {}
    }
  }

  const jwtDir = path.join(VAULT, "etc/ellul");
  fs.mkdirSync(jwtDir, { recursive: true });
  const jwtPath = path.join(jwtDir, "jwt-secret");
  if (fs.existsSync(jwtPath) && fs.readFileSync(jwtPath, "utf8").trim().length >= 32) {
    log(`jwt-secret exists`);
  } else {
    const secret = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(jwtPath, secret);
    log(`jwt-secret provisioned (set LIMA_JWT_SECRET=${secret} in console .env.local)`);
  }

  fs.writeFileSync(path.join(jwtDir, "product"), "byos");
  fs.writeFileSync(path.join(jwtDir, "deployment-model"), "localhost");
  fs.writeFileSync(path.join(jwtDir, "dev-domain"), "localhost");

  const requiredDefaults = {
    "rp-id": "localhost",
    "domain": "localhost",
    "platform-zone": "localhost",
    "app-zone": "ellul.app",
    "security-tier": "standard",
    "billing-tier": "paid",
    "api-url": "https://api.ellul.ai",
    "origin-tag": "android-local",
    "firewall-mode": "direct",
  };
  for (const [file, value] of Object.entries(requiredDefaults)) {
    const p = path.join(jwtDir, file);
    if (!fs.existsSync(p)) fs.writeFileSync(p, value);
  }
  fs.mkdirSync(path.join(jwtDir, "shield-data"), { recursive: true });
  fs.mkdirSync(path.join(jwtDir, "secrets"), { recursive: true });

  const PREVIEW_GATEWAY_PORT = 4443;
  const allOrigins = [...new Set([CONSOLE_ORIGIN, CONSOLE_UPSTREAM, "http://localhost:8443", `http://localhost:${PREVIEW_GATEWAY_PORT}`])];
  const originFiles = {
    "console-origin": CONSOLE_ORIGIN,
    "allowed-origins": allOrigins.join("\n"),
    "preview-origins.json": JSON.stringify({ origins: allOrigins, patterns: [] }),
  };
  for (const [file, value] of Object.entries(originFiles)) {
    const p = path.join(jwtDir, file);
    // Engine owns origin/port config — always overwrite to stay in sync
    // with port constants (e.g. PREVIEW_GATEWAY_PORT changes).
    fs.writeFileSync(p, value);
  }

  // Clear stale preview routes from previous sessions so the console proxy catch-all isn't blocked
  const appRoutesDir = path.join(VAULT, "etc/caddy/app-routes.d");
  try {
    for (const f of fs.readdirSync(appRoutesDir)) {
      if (f.endsWith(".caddy")) {
        fs.unlinkSync(path.join(appRoutesDir, f));
        log(`cleared stale preview route: ${f}`);
      }
    }
  } catch {}

  fs.writeFileSync(CWD_SHIM_PATH, CWD_SHIM);
  log("wrote node cwd shim");

  generateCaddyfile();
}

function readVaultKey() {
  const keyPath = path.join(VAULT, "run/shield/vault-key");
  try {
    const key = fs.readFileSync(keyPath, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(key)) return key;
  } catch {}
  const generated = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, generated, { mode: 0o600 });
  log("generated fallback vault key");
  return generated;
}

// ── Service restart budget ──────────────────────────────────────────
const serviceHealth = new Map();
const RESTART_WINDOW_MS = 120_000;
const MAX_RESTARTS_IN_WINDOW = 5;
const BACKOFF_SCHEDULE = [2000, 5000, 10000, 30000, 60000];

function getServiceHealth(name) {
  if (!serviceHealth.has(name)) {
    serviceHealth.set(name, { restarts: [], lastExitCode: null, lastSignal: null, startedAt: 0, stable: true });
  }
  return serviceHealth.get(name);
}

function startService(svc) {
  let cmd, cmdArgs, bundlePath;
  if (svc.command) {
    if (!fs.existsSync(svc.command)) {
      log(`SKIP ${svc.name}: binary not found at ${svc.command}`);
      return null;
    }
    cmd = svc.command;
    cmdArgs = svc.args || [];
  } else {
    bundlePath = path.join(SERVICES_DIR, svc.name, "current", svc.bundle);
    if (!fs.existsSync(bundlePath)) {
      log(`SKIP ${svc.name}: bundle not found at ${bundlePath}`);
      return null;
    }
    cmd = NODE;
    cmdArgs = [CWD_SHIM_PATH];
  }

  const env = {
    ...process.env,
    HOME: "/home/dev",
    USER: "dev",
    NODE_ENV: "production",
    ELLUL_PLATFORM: "android",
    ELLUL_HIGH_PORTS: "1",
    MSGPACKR_NATIVE_ACCELERATION_DISABLED: "true",
    ELLUL_DISABLE_SESSION_VAULT: "1",
  };

  // Pass GitHub App client ID to shield for device flow auth.
  // Read from config file (written by rootfs build or provisioning).
  if (!env.GITHUB_APP_CLIENT_ID) {
    try {
      const ghClientId = fs.readFileSync(path.join(VAULT, "etc/ellul/github-app-client-id"), "utf8").trim();
      if (ghClientId) env.GITHUB_APP_CLIENT_ID = ghClientId;
    } catch {}
  }

  if (!svc.command) {
    env._ELLUL_ENTRY = bundlePath;
    const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
    if (svc.name === "agent-bridge" && nodeMajor < 22 && fs.existsSync("/usr/lib/node-sqlite-polyfill.js")) {
      env.NODE_OPTIONS = (env.NODE_OPTIONS ? env.NODE_OPTIONS + " " : "") + "--require /usr/lib/node-sqlite-polyfill.js";
    }
  }

  const health = getServiceHealth(svc.name);
  health.startedAt = Date.now();

  if (svc.pipeVaultKey) {
    const vaultKey = readVaultKey();
    if (vaultKey) {
      env.ELLUL_VAULT_KEY = vaultKey;
      log(`${svc.name}: vault key via env`);
    }
  }

  log(`starting ${svc.name} on port ${svc.port}`);
  let child;
  try {
    child = spawn(cmd, cmdArgs, {
      env,
      stdio: "inherit",
      // No cwd option — Android's seccomp-bpf filter (inherited from zygote) blocks
      // fork(), which libuv falls back to when cwd is set (posix_spawn can't chdir
      // without glibc's posix_spawn_file_actions_addchdir_np). Engine chdir's at startup.
      // stdio must be "inherit" (not mixed pipe/inherit) to guarantee posix_spawn path.
    });
  } catch (e) {
    log(`ERROR: ${svc.name} spawn failed: ${e.message}`);
    return null;
  }

  child.on("error", (err) => {
    log(`ERROR: ${svc.name} spawn error: ${err.message}`);
  });

  child.on("exit", (code, signal) => {
    const uptime = Date.now() - health.startedAt;
    health.lastExitCode = code;
    health.lastSignal = signal;
    log(`${svc.name} exited code=${code} signal=${signal} uptime=${Math.round(uptime / 1000)}s`);
    children.delete(svc.name);

    if (shuttingDown) return;

    const now = Date.now();
    health.restarts = health.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
    health.restarts.push(now);

    if (health.restarts.length > MAX_RESTARTS_IN_WINDOW) {
      health.stable = false;
      log(`ERROR: ${svc.name} crash loop — ${health.restarts.length} restarts in ${RESTART_WINDOW_MS / 1000}s, stopping restarts`);
      writeServiceEvent(svc.name, "crash_loop", { exitCode: code, signal, restartsInWindow: health.restarts.length });
      return;
    }

    const backoffIdx = Math.min(health.restarts.length - 1, BACKOFF_SCHEDULE.length - 1);
    const delay = BACKOFF_SCHEDULE[backoffIdx];
    log(`restarting ${svc.name} in ${delay}ms (attempt ${health.restarts.length}/${MAX_RESTARTS_IN_WINDOW})`);
    setTimeout(() => startService(svc), delay);
  });

  children.set(svc.name, child);
  return child;
}

function writeServiceEvent(svcName, eventType, details) {
  try {
    const logDir = "/var/log/ellul";
    fs.mkdirSync(logDir, { recursive: true });
    const entry = JSON.stringify({ ts: new Date().toISOString(), svc: svcName, event: eventType, ...details }) + "\n";
    fs.appendFileSync(path.join(logDir, "engine-events.jsonl"), entry);
  } catch {}
}

function checkPort(port) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(2000);
    sock.on("connect", () => { sock.destroy(); resolve(true); });
    sock.on("error", () => { sock.destroy(); resolve(false); });
    sock.on("timeout", () => { sock.destroy(); resolve(false); });
    sock.connect(port, "127.0.0.1");
  });
}

async function waitForHealth(maxWait = 120) {
  const start = Date.now();
  while (Date.now() - start < maxWait * 1000) {
    const results = await Promise.all(
      SERVICES.filter((s) => children.has(s.name)).map(async (s) => ({
        name: s.name,
        healthy: await checkPort(s.port),
      }))
    );
    const healthy = results.filter((r) => r.healthy);
    const unhealthy = results.filter((r) => !r.healthy);

    if (unhealthy.length === 0 && healthy.length > 0) {
      log(`all ${healthy.length} services healthy after ${Math.round((Date.now() - start) / 1000)}s`);
      return true;
    }

    const elapsed = Math.round((Date.now() - start) / 1000);
    if (elapsed % 10 === 0 && elapsed > 0) {
      log(`waiting... ${healthy.length}/${results.length} healthy (${elapsed}s)`);
    }

    await new Promise((r) => setTimeout(r, 1000));
  }
  log("health check timed out");
  return false;
}

function writeHealthMarker() {
  fs.writeFileSync("/tmp/health-ready", "ready\n");
  log("health marker written");
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutting down");
  for (const [name, child] of children) {
    log(`stopping ${name}`);
    child.kill("SIGTERM");
  }
  setTimeout(() => {
    for (const [name, child] of children) {
      log(`force-killing ${name}`);
      child.kill("SIGKILL");
    }
    setTimeout(() => process.exit(0), 1000);
  }, 5000);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

const CONSOLE_PROXY_PORT = 3010;

function startConsoleProxy() {
  const upstream = new URL(CONSOLE_UPSTREAM);
  const server = http.createServer((clientReq, clientRes) => {
    const hdrs = { ...clientReq.headers, host: upstream.hostname };
    delete hdrs["connection"];
    delete hdrs["transfer-encoding"];

    const proxyReq = https.request(
      { hostname: upstream.hostname, port: 443, path: clientReq.url, method: clientReq.method, headers: hdrs },
      (proxyRes) => {
        const rh = { ...proxyRes.headers };
        if (rh.location) {
          rh.location = rh.location.replace(
            new RegExp(`https?://${upstream.hostname.replace(/\./g, "\\.")}`, "g"),
            "http://localhost:8443",
          );
        }
        delete rh["strict-transport-security"];
        if (rh["set-cookie"]) {
          const cookies = Array.isArray(rh["set-cookie"]) ? rh["set-cookie"] : [rh["set-cookie"]];
          rh["set-cookie"] = cookies.map((c) =>
            c.replace(/;\s*Domain=[^;]*/gi, "").replace(/;\s*Secure/gi, ""),
          );
        }
        clientRes.writeHead(proxyRes.statusCode, rh);
        proxyRes.pipe(clientRes);
      },
    );
    proxyReq.on("error", (err) => {
      log(`console-proxy error: ${err.message}`);
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { "Content-Type": "text/html; charset=utf-8" });
        clientRes.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ellul.ai — Offline</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,-apple-system,sans-serif;background:#0a0a0a;color:#e8e5e0;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
.card{max-width:400px;text-align:center}.title{font-size:20px;font-weight:600;margin-bottom:12px}.msg{font-size:14px;color:#a8a4a0;line-height:1.5;margin-bottom:20px}
button{padding:10px 24px;border-radius:8px;border:none;background:#e8e5e0;color:#0a0a0a;font-size:14px;font-weight:600;cursor:pointer}button:active{opacity:.8}</style></head>
<body><div class="card"><div class="title">Unable to connect</div><p class="msg">Cannot reach console.ellul.ai. Check your network connection and try again.</p>
<button onclick="location.reload()">Retry</button></div></body></html>`);
      }
    });
    clientReq.pipe(proxyReq);
  });
  server.listen(CONSOLE_PROXY_PORT, "127.0.0.1", () => {
    log(`console-proxy listening on 127.0.0.1:${CONSOLE_PROXY_PORT}`);
  });
  return server;
}

const CWD_SHIM_PATH = "/usr/lib/ellul-node-shims.js";
const CWD_SHIM = `'use strict';
(function() {
  var _cwd = process.cwd;
  var _chdir = process.chdir;
  var fallback = process.env.HOME || '/home/dev';
  process.cwd = function cwd() { try { return _cwd.call(process); } catch(e) { return fallback; } };
  process.chdir = function chdir(d) { try { _chdir.call(process, d); } catch(e) { fallback = require('path').resolve(fallback, d); } };
})();
if (process.env._ELLUL_ENTRY) require(process.env._ELLUL_ENTRY);
`;

const OPENCODE_WRAPPER = `#!/bin/bash
set -euo pipefail
REAL_OPENCODE="/usr/local/libexec/ellul/opencode"
[ -x "$REAL_OPENCODE" ] || { echo "opencode: binary not found at $REAL_OPENCODE" >&2; exit 127; }
PARENT_TMPDIR="\${TMPDIR:-/tmp}"
RUN_TMPDIR="$(mktemp -d "\${PARENT_TMPDIR%/}/opencode-run.XXXXXXXXXX")"
chmod 700 "$RUN_TMPDIR"
BUN_INSTALL_DIR="\${HOME:-/root}/.cache/opencode-bun"
mkdir -p "$BUN_INSTALL_DIR"
WRAPPER_SHA="$(sha256sum "$0" 2>/dev/null | cut -c1-12)"
cleanup() { rm -rf "$RUN_TMPDIR" 2>/dev/null || true; }
trap cleanup EXIT
GLIBC_LD="/lib/ld-linux-aarch64.so.1"
GLIBC_LIBPATH="/lib/aarch64-linux-gnu"
if [ "\${ELLUL_PLATFORM:-}" = "android" ] && [ -x "$GLIBC_LD" ]; then
  TMPDIR="$RUN_TMPDIR" BUN_TMPDIR="$RUN_TMPDIR" BUN_INSTALL="$BUN_INSTALL_DIR" ELLUL_OPENCODE_WRAPPER_SHA="$WRAPPER_SHA" "$GLIBC_LD" --library-path "$GLIBC_LIBPATH" "$REAL_OPENCODE" "$@" &
else
  TMPDIR="$RUN_TMPDIR" BUN_TMPDIR="$RUN_TMPDIR" BUN_INSTALL="$BUN_INSTALL_DIR" ELLUL_OPENCODE_WRAPPER_SHA="$WRAPPER_SHA" "$REAL_OPENCODE" "$@" &
fi
CHILD_PID=$!
trap 'kill -TERM "$CHILD_PID" 2>/dev/null || true' INT TERM
wait "$CHILD_PID"
EXIT_CODE=$?
while [ "$EXIT_CODE" -ge 128 ] && kill -0 "$CHILD_PID" 2>/dev/null; do
  wait "$CHILD_PID"
  EXIT_CODE=$?
done
trap - INT TERM
exit "$EXIT_CODE"
`;

function ensureOpencodeWrapper() {
  const p = "/usr/local/bin/opencode";
  try {
    if (fs.existsSync(p) && fs.readFileSync(p, "utf8").includes("REAL_OPENCODE")) return;
  } catch {}
  fs.writeFileSync(p, OPENCODE_WRAPPER, { mode: 0o755 });
  log("cli: wrote opencode wrapper");
}

function canExecSync() {
  try { execSyncRaw("true", { stdio: "pipe", timeout: 3000 }); return true; } catch { return false; }
}

function ensureCliTools() {
  if (!canExecSync()) {
    log("cli: execSync unavailable (fork blocked), skipping tool install");
    ensureOpencodeWrapper();
    return;
  }
  const tools = [
    {
      name: "opencode",
      check: "/usr/local/libexec/ellul/opencode",
      install() {
        const url = `https://github.com/anomalyco/opencode/releases/download/v${CLI_VERSIONS.opencode}/opencode-linux-arm64.tar.gz`;
        run("mkdir -p /usr/local/libexec/ellul");
        run(`curl -fsSL --retry 3 --connect-timeout 15 --max-time 120 "${url}" -o /tmp/opencode.tar.gz`);
        run("tar -xzf /tmp/opencode.tar.gz -C /usr/local/libexec/ellul");
        fs.chmodSync("/usr/local/libexec/ellul/opencode", 0o755);
        try { fs.unlinkSync("/tmp/opencode.tar.gz"); } catch {}
        ensureOpencodeWrapper();
      },
    },
    {
      name: "lazygit",
      check: "/usr/local/bin/lazygit",
      install() {
        const url = `https://github.com/jesseduffield/lazygit/releases/download/v${CLI_VERSIONS.lazygit}/lazygit_${CLI_VERSIONS.lazygit}_Linux_arm64.tar.gz`;
        run(`curl -fsSL --retry 3 --connect-timeout 15 --max-time 60 "${url}" -o /tmp/lazygit.tar.gz`);
        run("tar -xzf /tmp/lazygit.tar.gz -C /tmp lazygit");
        fs.copyFileSync("/tmp/lazygit", "/usr/local/bin/lazygit");
        fs.chmodSync("/usr/local/bin/lazygit", 0o755);
        try { fs.unlinkSync("/tmp/lazygit.tar.gz"); fs.unlinkSync("/tmp/lazygit"); } catch {}
      },
    },
    {
      name: "cursor-agent",
      check: "/usr/local/bin/cursor-agent",
      install() {
        const url = `https://downloads.cursor.com/lab/${CLI_VERSIONS.cursorAgent}/linux/arm64/agent-cli-package.tar.gz`;
        run(`curl -fsSL --retry 3 --connect-timeout 15 --max-time 120 "${url}" -o /tmp/cursor.tar.gz`);
        run("mkdir -p /usr/local/lib/cursor-agent");
        run("tar -xzf /tmp/cursor.tar.gz -C /usr/local/lib/cursor-agent --strip-components=1");
        fs.chmodSync("/usr/local/lib/cursor-agent/cursor-agent", 0o755);
        try { fs.symlinkSync("/usr/local/lib/cursor-agent/cursor-agent", "/usr/local/bin/cursor-agent"); } catch {}
        try { fs.unlinkSync("/tmp/cursor.tar.gz"); } catch {}
      },
    },
    {
      name: "claude-code",
      check: "/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
      install() {
        run(`npm install -g --no-audit --no-fund @anthropic-ai/claude-code@${CLI_VERSIONS.claudeCode}`, {
          timeout: 300_000,
          env: { ...process.env, HOME: "/root" },
        });
      },
    },
    {
      name: "codex",
      check: "/usr/lib/node_modules/@openai/codex",
      install() {
        run(`npm install -g --no-audit --no-fund @openai/codex@${CLI_VERSIONS.codex}`, {
          timeout: 300_000,
          env: { ...process.env, HOME: "/root" },
        });
      },
    },
    {
      name: "grok",
      check: "/home/dev/.grok/bin/grok",
      install() {
        run("curl -fsSL https://x.ai/cli/install.sh | bash", {
          env: { ...process.env, HOME: "/home/dev" },
        });
      },
    },
  ];

  ensureOpencodeWrapper();

  let installed = 0;
  for (const tool of tools) {
    if (fs.existsSync(tool.check)) continue;
    log(`cli: ${tool.name} missing, installing...`);
    try {
      tool.install();
      installed++;
      log(`cli: ${tool.name} installed`);
    } catch (e) {
      log(`cli: ${tool.name} install failed (non-fatal): ${e.message}`);
    }
  }
  if (installed > 0) log(`cli: installed ${installed} missing tool(s)`);
  else log("cli: all tools present");
}

function prepareCliTools() {
  const CACHE = "/tmp/.ellul-cli-cache";
  fs.mkdirSync(CACHE, { recursive: true });
  const elfs = [
    { name: "claude", src: "/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe" },
    { name: "codex", src: "/usr/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex" },
    { name: "cursor-agent", src: "/usr/local/bin/cursor-agent" },
    { name: "grok", src: "/home/dev/.grok/bin/grok" },
  ];
  for (const { name, src } of elfs) {
    const dst = path.join(CACHE, name);
    try {
      if (!fs.existsSync(src)) continue;
      const srcMtime = fs.statSync(src).mtimeMs;
      if (fs.existsSync(dst) && fs.statSync(dst).mtimeMs >= srcMtime) continue;
      fs.copyFileSync(src, dst);
      fs.chmodSync(dst, 0o755);
      log(`cli-cache: ${src} -> ${dst}`);
    } catch (e) {
      log(`cli-cache failed ${name}: ${e.message}`);
    }
  }
}

const RPC_PORT = 7710;
const rpcSecret = crypto.randomBytes(32).toString("hex");

function startRpcServer() {
  fs.writeFileSync("/tmp/ellul-engine-secret", rpcSecret, { mode: 0o600 });
  const server = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const req = JSON.parse(line);
          if (req.auth !== rpcSecret) {
            sock.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32600, message: "unauthorized" } }) + "\n");
            return;
          }
          const result = handleRpc(req.method, req.params || {});
          sock.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) + "\n");
        } catch (e) {
          sock.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: e.message } }) + "\n");
        }
      }
    });
    sock.on("error", () => {});
  });
  server.listen(RPC_PORT, "127.0.0.1", () => {
    log(`rpc server on 127.0.0.1:${RPC_PORT}`);
  });
}

function handleRpc(method, params) {
  switch (method) {
    case "tunnel.start":
    case "tunnel.stop":
    case "tunnel.reconnect":
      return { ok: true };
    case "health": {
      const status = {};
      for (const [name, child] of children) {
        const health = getServiceHealth(name);
        status[name] = {
          alive: child && !child.killed,
          stable: health.stable,
          restarts: health.restarts.length,
          lastExitCode: health.lastExitCode,
          uptimeMs: health.startedAt ? Date.now() - health.startedAt : 0,
        };
      }
      return status;
    }
    case "health.reset": {
      const name = params.service;
      if (name && serviceHealth.has(name)) {
        const health = getServiceHealth(name);
        health.restarts = [];
        health.stable = true;
        const svc = SERVICES.find((s) => s.name === name);
        if (svc && !children.has(name)) startService(svc);
        return { ok: true, restarted: !!svc };
      }
      return { ok: false, error: "unknown service" };
    }
    default:
      throw new Error(`unknown method: ${method}`);
  }
}

async function killStaleListeners() {
  const ports = SERVICES.map((s) => s.port).concat([CONSOLE_PROXY_PORT, RPC_PORT]);
  const inUse = [];
  for (const port of ports) {
    if (await checkPort(port)) inUse.push(port);
  }
  if (inUse.length === 0) return;
  log(`stale listeners on ports: ${inUse.join(", ")}`);
  try {
    const pids = fs.readdirSync("/proc")
      .filter((e) => /^\d+$/.test(e))
      .map(Number)
      .filter((p) => p !== process.pid);
    for (const pid of pids) {
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
    log(`sent SIGTERM to ${pids.length} processes`);
  } catch {}
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    let stillBlocked = false;
    for (const port of inUse) {
      if (await checkPort(port)) { stillBlocked = true; break; }
    }
    if (!stillBlocked) { log("stale listeners cleared"); return; }
    await new Promise((r) => setTimeout(r, 300));
  }
  log("WARN: some stale listeners remain");
}

async function main() {
  log(`Starting ellul-engine-android on ${process.arch}`);
  log(`User: uid=${process.getuid()} gid=${process.getgid()}`);

  setupFilesystem();
  prepareCliTools();
  await killStaleListeners();
  startConsoleProxy();

  for (const svc of SERVICES) {
    startService(svc);
  }

  const healthy = await waitForHealth();
  if (healthy) {
    writeHealthMarker();
    log("services ready");
  } else {
    log("WARNING: not all services healthy, writing marker anyway");
    writeHealthMarker();
  }

  startRpcServer();

  // CLI tools are not critical for service startup — install in background.
  // execSync uses fork() which may ENOSYS on Android; failures are non-fatal.
  setTimeout(() => {
    try { ensureCliTools(); } catch (e) { log(`cli install failed: ${e.message}`); }
  }, 5000);

  // Keep alive
  setInterval(() => {}, 60000);
}

process.on("uncaughtException", (err) => {
  log(`uncaught: ${err.message}`);
});
process.on("unhandledRejection", (reason) => {
  log(`unhandled rejection: ${reason}`);
});

main().catch((e) => {
  log(`fatal: ${e.message}`);
  process.exit(1);
});
