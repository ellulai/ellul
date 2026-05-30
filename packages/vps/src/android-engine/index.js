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

// heapMB: hard V8 old-space ceiling per service. Android devices are
// RAM-constrained (~1.5GB shared with the OS + Chromium WebView). Capping
// each service keeps total node RSS bounded so no single service can balloon
// into the kernel OOM killer (which would take down the WebView renderer).
const SERVICES = [
  {
    name: "sovereign-shield",
    bundle: "sovereign-shield.js",
    port: 3005,
    healthPath: "/_auth/health",
    pipeVaultKey: true,
    heapMB: 96,
  },
  {
    name: "file-api",
    bundle: "file-api.js",
    port: 3002,
    healthPath: "/health",
    heapMB: 128,
  },
  {
    name: "agent-bridge",
    bundle: "agent-bridge.js",
    port: 7700,
    heapMB: 256,
  },
  {
    // OpenCode runs as an engine-managed Bun server (the bridge can't fork it
    // as a grandchild, but the engine — PID 1's direct child — can). Bun.serve
    // works in proot; the binary is the rootfs-installed one (the /usr/local/bin
    // wrapper points at a path the engine never populates). Port must be free —
    // killStaleListeners covers :4100 since it's in SERVICES.
    name: "opencode",
    // Launch via the #!node wrapper (runs the Bun binary through the ld-linux
    // loader — Bun's JSC needs it in proot). startService shebang-resolves the
    // wrapper to NODE since proot can't exec /usr/bin/env directly.
    command: "/usr/local/bin/opencode",
    args: ["serve", "--port", "4100", "--hostname", "127.0.0.1"],
    port: 4100,
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
  fs.writeFileSync(NODE_LAUNCH_PATH, NODE_LAUNCH);
  log("wrote node cwd shim + launcher");

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
    if (svc.requiresBinary && !fs.existsSync(svc.requiresBinary)) {
      log(`SKIP ${svc.name}: required binary not found at ${svc.requiresBinary}`);
      return null;
    }
    cmd = svc.command;
    cmdArgs = svc.args || [];
    // proot can't exec `/usr/bin/env`, so a shebang service script (the opencode
    // bash wrapper) fails with exit 126 if spawned directly. Resolve the shebang
    // to its interpreter — the same thing adapter.spawn does. Both bash and node
    // run fine in proot.
    try {
      const _fd = fs.openSync(cmd, "r");
      const _hb = Buffer.alloc(64);
      const _n = fs.readSync(_fd, _hb, 0, 64, 0);
      fs.closeSync(_fd);
      const _head = _hb.subarray(0, _n).toString("utf8");
      if (_head.startsWith("#!/usr/bin/env node") || _head.startsWith("#!/usr/bin/node")) {
        cmdArgs = [cmd, ...cmdArgs];
        cmd = NODE;
      } else if (_head.startsWith("#!/bin/bash") || _head.startsWith("#!/usr/bin/env bash") || _head.startsWith("#!/bin/sh")) {
        cmdArgs = [cmd, ...cmdArgs];
        cmd = "/bin/bash";
      }
    } catch {}
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

  // Bound the V8 heap on RAM-constrained Android. --max-semi-space-size keeps
  // the young generation small so GC runs more often and peak RSS stays low.
  if (svc.heapMB) {
    const heapOpts = `--max-old-space-size=${svc.heapMB} --max-semi-space-size=16`;
    env.NODE_OPTIONS = env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ${heapOpts}` : heapOpts;
  }

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
    // Android proot: grandchild spawns are handled by the bridge's
    // AndroidEngineChildProcessSpawner which delegates to the engine's
    // adapter.spawn RPC. No preload injection needed.
    //
    // OpenCode runs as an engine-managed `opencode serve` on :4100 (see
    // SERVICES). Point the bridge at it as an external server.
    if (svc.name === "agent-bridge") {
      env.OPENCODE_EXTERNAL_SERVER_URL = "http://127.0.0.1:4100";
    }
  }

  if (svc.extraEnv) Object.assign(env, svc.extraEnv);

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

// Generic node-CLI launcher for proot. Adapter CLIs (cursor, grok, claude, and
// any #!node tool) call process.cwd() during startup; proot's getcwd is broken
// in the app's seccomp context (uv_cwd ENOSYS), which crashes them. We can't fix
// it with NODE_OPTIONS=--require because node resolves the require path via
// cwd() during loadPreloadModules — BEFORE the shim loads. The only reliable fix
// is to make the shim the ABSOLUTE main module (bootstrap of an absolute main
// makes no cwd call), patch process.cwd, then hand off to the real entry. This
// is exactly how the engine's own services launch (CWD_SHIM + _ELLUL_ENTRY); the
// launcher generalizes it to adapter CLIs whose real entry is in _ELLUL_LAUNCH_MAIN.
const NODE_LAUNCH_PATH = "/usr/lib/ellul-node-launch.js";
const NODE_LAUNCH = `'use strict';
require('${CWD_SHIM_PATH}');
var main = process.env._ELLUL_LAUNCH_MAIN;
if (!main) { process.stderr.write('ellul-node-launch: _ELLUL_LAUNCH_MAIN unset\\n'); process.exit(2); }
// ELLUL_FAKE_CWD: a dev server (next/vite) must see process.cwd() === the PROJECT
// dir, not the HOME fallback. The engine spawns from /home/dev (no chdir — fork/
// chdir are ENOSYS under proot), so override cwd at the Node layer to the project.
// Unset (cursor/grok/claude) → keep CWD_SHIM's existing _cwd-or-HOME behavior.
if (process.env.ELLUL_FAKE_CWD) {
  var _fakeCwd = process.env.ELLUL_FAKE_CWD;
  process.cwd = function cwd() { return _fakeCwd; };
}
// _ELLUL_LAUNCH_REQUIRE: colon-separated ABSOLUTE module paths — the cwd-SAFE
// replacement for NODE_OPTIONS=--require. node resolves --require paths via cwd()
// inside loadPreloadModules BEFORE any user code runs (uv_cwd ENOSYS → crash);
// requiring them HERE runs after process.cwd is patched, so it never calls uv_cwd.
if (process.env._ELLUL_LAUNCH_REQUIRE) {
  var _reqs = process.env._ELLUL_LAUNCH_REQUIRE.split(':');
  for (var _i = 0; _i < _reqs.length; _i++) {
    var _r = _reqs[_i];
    if (!_r) continue;
    try { require(_r); } catch (e) { process.stderr.write('ellul-node-launch: require failed: ' + _r + ': ' + (e && e.message) + '\\n'); }
  }
}
// Re-shape argv so the launched program sees argv[1]=its own entry (not the launcher).
process.argv = [process.argv[0], main].concat(process.argv.slice(2));
require(main);
`;

// OpenCode (Bun) wrapper. Node, not bash: shell mkdir/mktemp are ENOSYS under
// this proot ("mkdir: cannot create directory: Function not implemented"), but
// fs.mkdirSync/fs.mkdtempSync work. The two things Bun actually needs (learned
// from the original working bash wrapper that served for 14+ min on 2026-05-29):
//   (1) a FRESH, private per-run TMPDIR (a shared /tmp gave Bun "unknown error");
//       created here via fs.mkdtempSync (no shell).
//   (2) run through the rootfs glibc ld-linux loader on Android so the kernel
//       execs Bun natively (proot's ptrace breaks Bun's JSC signal handlers).
// REAL is probed across install locations so a path rename never breaks it.
const OPENCODE_WRAPPER = `#!/usr/bin/env node
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const LD = "/lib/ld-linux-aarch64.so.1";
const LIBPATH = "/lib/aarch64-linux-gnu";
let REAL = ["/usr/local/libexec/ellul/opencode", "/opt/ellul/bin/opencode"].find((p) => { try { return fs.existsSync(p); } catch { return false; } });
if (!REAL) { try { const vs = fs.readdirSync("/opt/ellul/bin").filter((f) => f.startsWith("opencode-v")).sort(); if (vs.length) REAL = "/opt/ellul/bin/" + vs[vs.length - 1]; } catch {} }
if (!REAL) { process.stderr.write("opencode: binary not found (libexec / /opt/ellul/bin)\\n"); process.exit(127); }
const home = process.env.HOME || "/home/dev";
const bunInstall = home + "/.cache/opencode-bun";
try { fs.mkdirSync(bunInstall, { recursive: true }); } catch {}
const parentTmp = process.env.TMPDIR || "/tmp";
try { fs.mkdirSync(parentTmp, { recursive: true }); } catch {}
let runTmp;
try { runTmp = fs.mkdtempSync(path.join(parentTmp, "opencode-run.")); } catch { runTmp = parentTmp; }
const env = Object.assign({}, process.env, {
  HOME: home,
  TMPDIR: runTmp,
  BUN_TMPDIR: runTmp,
  BUN_INSTALL: bunInstall,
});
const useLD = process.env.ELLUL_PLATFORM === "android" && fs.existsSync(LD);
const cmd = useLD ? LD : REAL;
const fullArgs = useLD ? ["--library-path", LIBPATH, REAL, ...process.argv.slice(2)] : process.argv.slice(2);
const child = spawn(cmd, fullArgs, { stdio: "inherit", env });
const cleanup = () => { try { fs.rmSync(runTmp, { recursive: true, force: true }); } catch {} };
child.on("close", (code) => { cleanup(); process.exit(code == null ? 0 : code); });
child.on("error", (e) => { cleanup(); process.stderr.write("opencode wrapper: " + e.message + "\\n"); process.exit(1); });
process.on("SIGTERM", () => { try { child.kill("SIGTERM"); } catch {} });
process.on("SIGINT", () => { try { child.kill("SIGINT"); } catch {} });
`;

function ensureOpencodeWrapper() {
  // Pre-create dirs the wrapper/binary needs (fs.mkdirSync works in proot,
  // shell mkdir does not).
  for (const d of ["/tmp", "/root/.cache/opencode-bun", "/home/dev/.cache/opencode-bun"]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch {}
  }
  const p = "/usr/local/bin/opencode";
  try {
    if (fs.existsSync(p) && fs.readFileSync(p, "utf8") === OPENCODE_WRAPPER) return;
  } catch {}
  fs.writeFileSync(p, OPENCODE_WRAPPER, { mode: 0o755 });
  log("cli: wrote opencode wrapper");
}

// Download a file using Node.js https/http (no curl dependency).
function download(url, dest, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const get = (u, remaining) => {
      mod.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && remaining > 0) {
          res.resume();
          return get(res.headers.location, remaining - 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
        }
        const ws = fs.createWriteStream(dest);
        res.pipe(ws);
        ws.on("finish", () => ws.close(resolve));
        ws.on("error", reject);
      }).on("error", reject);
    };
    get(url, maxRedirects);
  });
}

// Async spawn — uses child_process.spawn (works in proot, unlike spawnSync).
function spawnAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const { timeout = 120_000, env } = opts;
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: env || process.env });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString().slice(-500); });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${cmd} timed out after ${timeout}ms`)); }, timeout);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${cmd} exited ${code}: ${stderr.trim().slice(-200)}`));
      else resolve();
    });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

// Pure Node.js tar.gz extraction — no external binaries (proot ENOSYS).
function extractTarGz(archive, destDir, opts = {}) {
  const zlib = require("zlib");
  const buf = zlib.gunzipSync(fs.readFileSync(archive));
  const strip = opts.stripComponents || 0;
  const only = opts.files ? new Set(opts.files) : null;
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    let name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    if (prefix) name = prefix + "/" + name;
    const sizeOctal = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = parseInt(sizeOctal, 8) || 0;
    const typeFlag = String.fromCharCode(header[156]);
    offset += 512;
    if (strip > 0) {
      const parts = name.split("/");
      name = parts.slice(strip).join("/");
    }
    if (!name || name === "./" || name === "/") { offset += Math.ceil(size / 512) * 512; continue; }
    if (only && !only.has(name.replace(/\/$/, ""))) { offset += Math.ceil(size / 512) * 512; continue; }
    const dest = path.join(destDir, name);
    if (typeFlag === "5" || name.endsWith("/")) {
      fs.mkdirSync(dest, { recursive: true });
    } else if (typeFlag === "0" || typeFlag === "\0" || typeFlag === "") {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf.subarray(offset, offset + size));
      fs.chmodSync(dest, 0o755);
    }
    offset += Math.ceil(size / 512) * 512;
  }
}

function ensureCliTools() {
  const tools = [
    {
      name: "opencode",
      check: "/opt/ellul/bin/opencode",
      async install() {
        const url = `https://github.com/anomalyco/opencode/releases/download/v${CLI_VERSIONS.opencode}/opencode-linux-arm64.tar.gz`;
        const dest = "/opt/ellul/bin";
        fs.mkdirSync(dest, { recursive: true });
        await download(url, "/tmp/opencode.tar.gz");
        extractTarGz("/tmp/opencode.tar.gz", dest);
        fs.chmodSync(path.join(dest, "opencode"), 0o755);
        try { fs.unlinkSync("/tmp/opencode.tar.gz"); } catch {}
        ensureOpencodeWrapper();
      },
    },
    {
      name: "lazygit",
      check: "/usr/local/bin/lazygit",
      async install() {
        const url = `https://github.com/jesseduffield/lazygit/releases/download/v${CLI_VERSIONS.lazygit}/lazygit_${CLI_VERSIONS.lazygit}_Linux_arm64.tar.gz`;
        await download(url, "/tmp/lazygit.tar.gz");
        extractTarGz("/tmp/lazygit.tar.gz", "/tmp", { files: ["lazygit"] });
        fs.copyFileSync("/tmp/lazygit", "/usr/local/bin/lazygit");
        fs.chmodSync("/usr/local/bin/lazygit", 0o755);
        try { fs.unlinkSync("/tmp/lazygit.tar.gz"); fs.unlinkSync("/tmp/lazygit"); } catch {}
      },
    },
    {
      name: "cursor-agent",
      check: "/usr/local/bin/cursor-agent",
      async install() {
        const url = `https://downloads.cursor.com/lab/${CLI_VERSIONS.cursorAgent}/linux/arm64/agent-cli-package.tar.gz`;
        fs.mkdirSync("/usr/local/lib/cursor-agent", { recursive: true });
        await download(url, "/tmp/cursor.tar.gz");
        extractTarGz("/tmp/cursor.tar.gz", "/usr/local/lib/cursor-agent", { stripComponents: 1 });
        fs.chmodSync("/usr/local/lib/cursor-agent/cursor-agent", 0o755);
        try { fs.symlinkSync("/usr/local/lib/cursor-agent/cursor-agent", "/usr/local/bin/cursor-agent"); } catch {}
        try { fs.unlinkSync("/tmp/cursor.tar.gz"); } catch {}
      },
    },
    {
      name: "claude-code",
      check: "/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
      install() {
        return spawnAsync(process.execPath, ["/usr/lib/node_modules/npm/bin/npm-cli.js", "install", "-g", "--no-audit", "--no-fund", `@anthropic-ai/claude-code@${CLI_VERSIONS.claudeCode}`], {
          timeout: 300_000, env: { ...process.env, HOME: "/root" },
        });
      },
    },
    {
      name: "codex",
      check: "/usr/lib/node_modules/@openai/codex",
      install() {
        return spawnAsync(process.execPath, ["/usr/lib/node_modules/npm/bin/npm-cli.js", "install", "-g", "--no-audit", "--no-fund", `@openai/codex@${CLI_VERSIONS.codex}`], {
          timeout: 300_000, env: { ...process.env, HOME: "/root" },
        });
      },
    },
    {
      name: "grok",
      check: "/home/dev/.grok/bin/grok",
      async install() {
        const url = "https://github.com/xai-org/grok-cli/releases/latest/download/grok-linux-arm64.tar.gz";
        const grokDir = "/home/dev/.grok/bin";
        fs.mkdirSync(grokDir, { recursive: true });
        await download(url, "/tmp/grok.tar.gz");
        extractTarGz("/tmp/grok.tar.gz", grokDir);
        const grokBin = path.join(grokDir, "grok");
        if (fs.existsSync(grokBin)) fs.chmodSync(grokBin, 0o755);
        try { fs.unlinkSync("/tmp/grok.tar.gz"); } catch {}
      },
    },
  ];

  ensureOpencodeWrapper();

  let installed = 0;
  const pending = [];
  for (const tool of tools) {
    if (fs.existsSync(tool.check)) continue;
    log(`cli: ${tool.name} missing, installing...`);
    pending.push(
      tool.install().then(() => { installed++; log(`cli: ${tool.name} installed`); })
        .catch((e) => { log(`cli: ${tool.name} install failed (non-fatal): ${e.message}`); })
    );
  }
  if (pending.length === 0) { log("cli: all tools present"); return Promise.resolve(); }
  return Promise.all(pending).then(() => {
    if (installed > 0) log(`cli: installed ${installed} missing tool(s)`);
  });
}

function prepareCliTools() {
  const CACHE = "/tmp/.ellul-cli-cache";
  fs.mkdirSync(CACHE, { recursive: true });
  // Only cache self-contained binaries. claude (Bun stub) is disabled on
  // Android, and cursor-agent is a bash launcher that needs its sibling
  // node/index.js — both break when copied to the bare cache dir, so they run
  // from their real install paths instead (see DEFAULT_CURSOR_BINARY).
  const elfs = [
    { name: "codex", src: "/usr/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex" },
    { name: "grok", src: "/home/dev/.grok/bin/grok" },
  ];
  for (const { name, src } of elfs) {
    const dst = path.join(CACHE, name);
    try {
      if (!fs.existsSync(src)) continue;
      const srcMtime = fs.statSync(src).mtimeMs;
      if (fs.existsSync(dst) && fs.statSync(dst).mtimeMs >= srcMtime) continue;
      // A stale dest owned by a different uid makes copyFileSync fail with
      // EACCES (proot fakes root, but the real kernel write check uses the app
      // uid). Remove it first — unlink only needs write on the CACHE dir, which
      // we own — so the cache always refreshes to a working binary.
      try { fs.unlinkSync(dst); } catch {}
      fs.copyFileSync(src, dst);
      fs.chmodSync(dst, 0o755);
      log(`cli-cache: ${src} -> ${dst}`);
    } catch (e) {
      log(`cli-cache failed ${name}: ${e.message}`);
    }
  }
  ensureCodexConfig();
}

// proot is a ptrace syscall emulator, not real namespaces, so codex's bundled
// bubblewrap (needs CAP_SETUID in an unprivileged userns) dies — e.g. it kills
// skills/list during the provider probe. danger-full-access skips bwrap: proot
// IS the sandbox boundary, matching the thread-start override in
// adapters/codex/session-runtime.ts. Merge (don't clobber) so other settings
// survive, and force the value if a wrong one is present.
function ensureCodexConfig() {
  const cfg = "/home/dev/.codex/config.toml";
  try {
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    let body = "";
    try { body = fs.readFileSync(cfg, "utf8"); } catch {}
    let next = body;
    for (const [key, val] of [["sandbox_mode", '"danger-full-access"'], ["approval_policy", '"never"']]) {
      const re = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
      const line = `${key} = ${val}`;
      next = re.test(next) ? next.replace(re, line) : (next ? next.replace(/\s*$/, "") + "\n" + line + "\n" : line + "\n");
    }
    if (next !== body) { fs.writeFileSync(cfg, next); log(`codex config: sandbox_mode=danger-full-access -> ${cfg}`); }
  } catch (e) { log(`codex config failed: ${e.message}`); }
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
          const resultOrPromise = handleRpc(req.method, req.params || {});
          if (resultOrPromise && typeof resultOrPromise.then === "function") {
            resultOrPromise
              .then((result) => { try { sock.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) + "\n"); } catch {} })
              .catch((e) => { try { sock.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32603, message: e.message } }) + "\n"); } catch {} });
          } else {
            sock.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: resultOrPromise }) + "\n");
          }
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

async function handleRpc(method, params) {
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
    // ── adapter.spawn: stdio-proxied adapter process manager ──
    // Bridge (proot grandchild) can't fork/exec. Engine (direct proot child)
    // spawns adapter binaries and opens a per-spawn TCP port that transparently
    // pipes the child's stdin/stdout to the bridge. Bridge connects to the TCP
    // port and gets raw stdio access as if it spawned the binary locally.
    case "adapter.spawn": {
      const { cmd, args: spawnArgs = [], env: spawnEnv = {}, cwd: spawnCwd } = params;
      if (!cmd) throw new Error("adapter.spawn: cmd required");

      // Resolve shebang: proot can't exec /usr/bin/env. Spawn the interpreter directly.
      let finalCmd = cmd;
      let finalArgs = spawnArgs;
      // Extra env injected for the cwd launcher (_ELLUL_LAUNCH_MAIN). node CLIs
      // (cursor, grok, claude, any #!node tool) call process.cwd() during
      // startup, which is uv_cwd ENOSYS under proot's app-seccomp context. We
      // launch them through NODE_LAUNCH_PATH — the cwd shim AS THE ABSOLUTE MAIN
      // MODULE (no cwd call during its bootstrap), which patches process.cwd
      // and then require()s the real entry from _ELLUL_LAUNCH_MAIN. (NODE_OPTIONS
      // =--require can't fix this: node resolves the require path via cwd() in
      // loadPreloadModules, before the shim loads.)
      const launchExtraEnv = {};
      try {
        // Read ONLY the first 512 bytes for the shebang — never the whole file.
        // codex/opencode binaries are 100-190MB; readFileSync(whole) blocked the
        // engine's (synchronous) event loop ~8s per spawn AND spiked memory by
        // the binary's size — stalling the stdio proxy mid-probe so the
        // app-server exited ("process exited with code 0").
        const _fd = fs.openSync(cmd, "r");
        const _hb = Buffer.alloc(512);
        const _n = fs.readSync(_fd, _hb, 0, 512, 0);
        fs.closeSync(_fd);
        const head = _hb.subarray(0, _n).toString("utf8");
        if (head.startsWith("#!/usr/bin/env node") || head.startsWith("#!/usr/bin/node")) {
          finalCmd = NODE;
          finalArgs = [NODE_LAUNCH_PATH, ...spawnArgs];
          launchExtraEnv._ELLUL_LAUNCH_MAIN = cmd;
        } else if (head.startsWith("#!/bin/bash") || head.startsWith("#!/usr/bin/env bash")) {
          // Adapter CLIs like cursor-agent are bash wrappers that exec a sibling
          // bundled `node` on their own index.js (which then hits uv_cwd ENOSYS).
          // Detect that shape (realpath dir has node + index.js) and launch the
          // bundled node through the cwd launcher instead of running the wrapper.
          let real = cmd;
          try { real = fs.realpathSync(cmd); } catch {}
          const dir = path.dirname(real);
          const sibNode = path.join(dir, "node");
          const sibIndex = path.join(dir, "index.js");
          if (fs.existsSync(sibNode) && fs.existsSync(sibIndex)) {
            // Preserve any node exec-flags the wrapper passes (e.g. cursor's
            // --use-system-ca). They MUST precede the launcher on node's argv.
            let wrapperBody = "";
            try { wrapperBody = fs.readFileSync(real, "utf8"); } catch {}
            const nodeFlags = [];
            if (wrapperBody.includes("--use-system-ca")) nodeFlags.push("--use-system-ca");
            finalCmd = sibNode;
            finalArgs = [...nodeFlags, NODE_LAUNCH_PATH, ...spawnArgs];
            launchExtraEnv._ELLUL_LAUNCH_MAIN = sibIndex;
          } else {
            finalCmd = "/bin/bash";
            finalArgs = [cmd, ...spawnArgs];
          }
        }
      } catch {}

      // Resolve cwd from ELLUL_NS_PROJECT (on VPS the namespace script does chdir)
      let resolvedCwd = spawnCwd || undefined;
      if (!resolvedCwd && spawnEnv.ELLUL_NS_PROJECT && spawnEnv.ELLUL_NS_PROJECT !== "__host__") {
        resolvedCwd = `/home/dev/projects/${spawnEnv.ELLUL_NS_PROJECT}`;
        try { fs.mkdirSync(resolvedCwd, { recursive: true }); } catch {}
      }

      log(`adapter.spawn: ${finalCmd} ${finalArgs.slice(0, 4).join(" ")} cwd=${resolvedCwd || "inherited"}`);

      // Spawn with piped stdio
      const child = spawn(finalCmd, finalArgs, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...spawnEnv, ...launchExtraEnv },
        // No cwd option — Android seccomp blocks fork() when cwd is set
        // (libuv falls back from posix_spawn to fork). Instead we chdir
        // the child via a wrapper or let the adapter handle cwd via env.
      });
      const pid = child.pid;
      if (!pid) throw new Error("adapter.spawn: spawn returned no pid");

      // Open a per-spawn TCP proxy: bridge connects and gets stdin/stdout piped
      const proxyServer = net.createServer({ allowHalfOpen: true }, (sock) => {
        // Bridge connected — pipe stdin/stdout. CRITICAL: do NOT merge stderr
        // into this socket. The bridge's AndroidEngineSpawner reads it as the
        // child's STDOUT (stderr is a separate empty stream there), so any
        // stderr bytes interleaved here corrupt stdio JSON protocols — codex
        // app-server ("Failed to decode wire message"), cursor ACP, and
        // `--format json` probes. Route the child's stderr to the engine log.
        // end:false — do NOT propagate the bridge's write-side close to the
        // child's stdin as EOF. Persistent stdio servers (codex app-server,
        // cursor acp) exit on stdin EOF; when the bridge's JSON-RPC client
        // finishes sending its probe requests its socket write-side closes, and
        // with end:true that EOF'd codex's stdin → codex exited mid-probe and
        // the exit raced the response read ("process exited with code 0"). The
        // child is still terminated deterministically by sock 'close' → kill.
        sock.pipe(child.stdin, { end: false });
        child.stdout.pipe(sock, { end: false });
        child.stderr.on("data", (d) => { try { process.stderr.write(d); } catch {} });
        child.on("close", () => { try { sock.end(); } catch {} });
        sock.on("close", () => { try { child.kill(); } catch {} });
        sock.on("error", () => { try { child.kill(); } catch {} });
      });
      proxyServer.maxConnections = 1;

      // Listen on dynamic port
      await new Promise((resolve, reject) => {
        proxyServer.listen(0, "127.0.0.1", () => resolve());
        proxyServer.on("error", reject);
      });
      const proxyPort = proxyServer.address().port;

      // Cleanup when child exits
      child.on("close", (code, signal) => {
        log(`adapter.spawn: pid=${pid} exited code=${code} signal=${signal} proxy=${proxyPort}`);
        try { proxyServer.close(); } catch {}
      });
      child.on("error", (e) => {
        log(`adapter.spawn: pid=${pid} error: ${e.message}`);
        try { proxyServer.close(); } catch {}
      });

      log(`adapter.spawn: pid=${pid} proxyPort=${proxyPort}`);
      return { ok: true, pid, proxyPort };
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

  // Start the adapter.spawn RPC BEFORE the services. The agent-bridge spawns
  // adapters (codex/cursor probes) the moment it boots; if :7710 isn't
  // listening yet those probes fail with ECONNREFUSED ("Engine RPC failed").
  startRpcServer();

  // The opencode service `command` is /usr/local/bin/opencode (the wrapper).
  // ensureCliTools() (which writes it) runs async AFTER this loop, so without
  // this the opencode service SKIPs on "binary not found" at boot and never
  // recovers. Write the wrapper synchronously first — it's idempotent.
  ensureOpencodeWrapper();

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

  // CLI tools are not critical for service startup — install in background.
  // Uses Node.js APIs (fs/https/zlib) instead of shell commands to avoid
  // proot ENOSYS on fork/exec of mkdir/curl/gzip binaries.
  setTimeout(() => {
    ensureCliTools()
      .then(() => prepareCliTools())
      .catch((e) => { log(`cli install failed: ${e.message}`); });
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
