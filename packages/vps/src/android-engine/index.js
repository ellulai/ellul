#!/usr/bin/env node
// Android proot engine — starts VPS services without systemd.
// Entry point: /usr/local/bin/ellul-engine-android → this file.

const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const net = require("net");

const VAULT = "/root/ellul-vault";
const SERVICES_DIR = "/opt/ellul/releases";
const NODE = "/usr/local/bin/node";

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
        header_up X-Forwarded-Host {http.request.hostport}
        header_up X-Forwarded-Proto {scheme}
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
        respond ${"`"}window.__ELLUL_CONFIG__=${JSON.stringify({platformZone:"localhost",appZone:"ellul.app",consoleOrigin:CONSOLE_ORIGIN,wsOrigin:"http://localhost:8443",codeWsOrigin:"http://localhost:8443",codeWsPath:"/code-ws",disabledSessions:["claw"]})};${"`"} 200
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
        import auth_gate
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

    handle /api/* {
        import auth_gate
        reverse_proxy ${FILE_API}
    }

    handle /api/internal/* {
        reverse_proxy ${BRIDGE}
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

    import ${path.join(VAULT, "etc/caddy/app-routes.d/*.caddy")}

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

  const allOrigins = [...new Set([CONSOLE_ORIGIN, CONSOLE_UPSTREAM, "http://localhost:8443"])];
  const originFiles = {
    "console-origin": CONSOLE_ORIGIN,
    "allowed-origins": allOrigins.join("\n"),
    "preview-origins.json": JSON.stringify({ origins: allOrigins, patterns: [] }),
  };
  for (const [file, value] of Object.entries(originFiles)) {
    const p = path.join(jwtDir, file);
    if (!fs.existsSync(p) || fs.readFileSync(p, "utf8").trim().length === 0) {
      fs.writeFileSync(p, value);
    }
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

  generateCaddyfile();
}

function readVaultKey() {
  const keyPath = path.join(VAULT, "run/shield/vault-key");
  try {
    const key = fs.readFileSync(keyPath, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(key)) return key;
  } catch {}
  return null;
}

function startService(svc) {
  let cmd, cmdArgs;
  if (svc.command) {
    if (!fs.existsSync(svc.command)) {
      log(`SKIP ${svc.name}: binary not found at ${svc.command}`);
      return null;
    }
    cmd = svc.command;
    cmdArgs = svc.args || [];
  } else {
    const bundlePath = path.join(SERVICES_DIR, svc.name, "current", svc.bundle);
    if (!fs.existsSync(bundlePath)) {
      log(`SKIP ${svc.name}: bundle not found at ${bundlePath}`);
      return null;
    }
    cmd = NODE;
    cmdArgs = [bundlePath];
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

  // Node 20 lacks node:sqlite — load polyfill if present
  const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
  if (svc.name === "agent-bridge" && nodeMajor < 22 && fs.existsSync("/usr/lib/node-sqlite-polyfill.js")) {
    env.NODE_OPTIONS = "--require /usr/lib/node-sqlite-polyfill.js";
  }

  log(`starting ${svc.name} on port ${svc.port}`);
  const child = spawn(cmd, cmdArgs, {
    env,
    stdio: svc.pipeVaultKey ? ["pipe", "inherit", "inherit"] : ["ignore", "inherit", "inherit"],
    cwd: "/home/dev",
  });

  if (svc.pipeVaultKey) {
    const vaultKey = readVaultKey();
    if (vaultKey) {
      child.stdin.write(vaultKey + "\n");
      child.stdin.end();
      log(`${svc.name}: vault key piped`);
    } else {
      child.stdin.end();
      log(`${svc.name}: WARNING no vault key found`);
    }
  }

  child.on("exit", (code, signal) => {
    log(`${svc.name} exited code=${code} signal=${signal}`);
    children.delete(svc.name);
    if (!shuttingDown) {
      setTimeout(() => {
        log(`restarting ${svc.name}`);
        startService(svc);
      }, 2000);
    }
  });

  children.set(svc.name, child);
  return child;
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
        clientRes.writeHead(502, { "Content-Type": "text/plain" });
        clientRes.end("Console proxy error: " + err.message);
      }
    });
    clientReq.pipe(proxyReq);
  });
  server.listen(CONSOLE_PROXY_PORT, "127.0.0.1", () => {
    log(`console-proxy listening on 127.0.0.1:${CONSOLE_PROXY_PORT}`);
  });
  return server;
}

async function main() {
  log(`Starting ellul-engine-android on ${process.arch}`);
  log(`User: uid=${process.getuid()} gid=${process.getgid()}`);

  setupFilesystem();
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

  // Keep alive
  setInterval(() => {}, 60000);
}

main().catch((e) => {
  log(`fatal: ${e.message}`);
  process.exit(1);
});
