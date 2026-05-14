// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// File API Bundle Generator

import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

let cachedBundle: string | null = null;
let inflight: Promise<string> | null = null;

function getSourceDir(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);
  if (currentDir.includes("/dist/") || currentDir.endsWith("/dist")) {
    const packageRoot = currentDir.replace(/\/dist(\/.*)?$/, "");
    return path.join(packageRoot, "src", "services", "backends", "file-api");
  }
  return currentDir;
}

async function bundleModular(): Promise<string> {
  if (cachedBundle) return cachedBundle;
  if (inflight) return inflight;

  inflight = doBundleModular();
  try { return await inflight; } finally { inflight = null; }
}

async function doBundleModular(): Promise<string> {
  if (cachedBundle) return cachedBundle;

  const curDir = path.dirname(fileURLToPath(import.meta.url));
  if (curDir.includes("/dist/") || curDir.endsWith("/dist")) {
    const pkgRoot = curDir.replace(/\/dist(\/.*)?$/, "");
    const pre = path.join(pkgRoot, "dist", "prebundled", "file-api.js");
    if (fs.existsSync(pre)) {
      cachedBundle = fs.readFileSync(pre, "utf8");
      return cachedBundle;
    }
  }

  console.warn("[file-api] prebundled artifact missing — falling back to runtime esbuild");
  const esbuild = await import("esbuild");
  const sourceDir = getSourceDir();
  const packageRoot = path.resolve(sourceDir, "..", "..", "..", "..");
  const entryPoint = path.join(sourceDir, "src", "main.ts");

  const result = await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: "node",
    target: "node18",
    format: "cjs",
    minify: false,
    write: false,
    tsconfig: path.resolve(packageRoot, "tsconfig.json"),
    external: [
      "fs", "path", "crypto", "http", "https", "url", "events", "stream",
      "util", "os", "child_process", "ws", "chokidar",
    ],
  });

  if (!result.outputFiles?.[0]) {
    throw new Error("esbuild produced no output");
  }

  cachedBundle = result.outputFiles[0].text;
  return cachedBundle;
}

// Get the file API script for VPS deployment.
export async function getFileApiScript(serverId: string): Promise<string> {
  const bundledCode = await bundleModular();

  return `// ellul File API (Code Browser Backend)
process.env.ELLUL_SERVER_ID = ${JSON.stringify(serverId)};

${bundledCode}
`;
}

// Get the file API script synchronously (for compatibility).
export function getFileApiScriptSync(serverId: string): string {
  const preBundledPath = path.join(__dirname, "dist", "server.js");
  if (fs.existsSync(preBundledPath)) {
    const bundledCode = fs.readFileSync(preBundledPath, "utf8");
    return `// ellul File API (Code Browser Backend)
process.env.ELLUL_SERVER_ID = ${JSON.stringify(serverId)};
${bundledCode}
`;
  }

  throw new Error(
    "Pre-bundled file-api not found. Run build first or use async getFileApiScript()",
  );
}

// Generate the systemd service file for file-api.
export function getFileApiService(svcUser: string = "dev", heapCapMb?: number | null): string {
  const svcHome = `/home/${svcUser}`;
  const nodeFlags = heapCapMb ? `--max-old-space-size=${heapCapMb} ` : '';
  return `[Unit]
Description=ellul File API (Code Browser)
After=network-online.target local-fs.target ellul-luks-boot.service ellul-sovereign-shield.service
Wants=network-online.target ellul-luks-boot.service
RequiresMountsFor=/etc/ellul /opt/ellul /etc/caddy

[Service]
Type=simple
Slice=ellul-control-plane.slice
User=${svcUser}
Group=${svcUser}
WorkingDirectory=${svcHome}
Environment=NODE_ENV=production
Environment=PORT=3002
Environment=NODE_PATH=${svcHome}/.node/lib/node_modules
Environment=PATH=${svcHome}/.node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# Dynamic heap sizing — provisioning-time memory tuner writes a host-sized
# NODE_OPTIONS into this file. Optional (leading dash) so fresh installs
# before the tuner runs fall back to the static nodeFlags inlined below.
EnvironmentFile=-/etc/ellul/heap-caps/file-api.env
EnvironmentFile=-/etc/default/ellul-secrets
# Refuse to start when vault was provisioned but bind mount didn't activate — app secrets injected from /etc/ellul/secrets would be on plaintext rootfs.
ExecStartPre=/bin/sh -c '[ ! -f /etc/ellul-bootstrap/volume-was-encrypted ] || /usr/bin/mountpoint -q /etc/ellul'
ExecStart=${svcHome}/.node/bin/node ${nodeFlags}/usr/local/bin/ellul-file-api
Restart=on-failure
RestartSec=5
# Control plane — survive any OOM. Kernel must kill leaked CLI sessions
# before touching the API that the UI talks to.
OOMScoreAdjust=-1000
MemoryHigh=512M
# KillMode=mixed so a file-api restart (deploy, OOM of main, systemctl
# restart) sends SIGTERM to the main process only — NOT to every
# subprocess in the cgroup. Install-manager spawns detached package-
# manager subprocesses that must survive file-api restarts (a 3-minute
# npm install cannot be torn down every time the control plane recycles).
# Those children additionally run in their own systemd-run scopes for
# cgroup isolation, but mixed is the correct default regardless — file-
# api is a control plane, not a cgroup parent for long-running work.
KillMode=mixed

# Security hardening
# NOTE: NoNewPrivileges intentionally omitted — file-api delegates to
# privileged helper scripts via sudo (update-identity, mount-volume,
# restore-identity). NoNewPrivileges blocks setuid binaries like sudo.
ProtectSystem=strict
PrivateTmp=true
LimitCORE=0
# /run/systemd/system is needed for the per-instance preview drop-in written
# via ellul-preview-ctl (mkdir + atomic write of a 10-framework.conf override
# inside ellul-preview@<inst>.service.d/). The drop-in lives in /run not /etc
# so it's volatile (tmpfs, gone on reboot) — file-api re-emits per-preview
# caps on every start anyway, and a compromised file-api can't persist
# malicious systemd config across a reboot via this path.
# ProtectSystem=strict propagates the read-only mount through sudo, so without
# this entry ellul-preview-ctl's mkdir hits EROFS and every framework-aware
# preview start fails. UNIX perms (root:root 0755) still gate direct writes
# from file-api itself; only the sudo wrapper can actually write here.
ReadWritePaths=${svcHome} /etc/ellul /etc/ellul-bootstrap /etc/caddy /opt/ellul /run/systemd/system
ReadOnlyPaths=/run/shield
SupplementaryGroups=caddy shield-ipc systemd-journal
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true

[Install]
WantedBy=multi-user.target
`;
}

