// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Agent Bridge Bundle Generator
 *
 * Bundles the modular TypeScript source files into a deployable JavaScript
 * script using esbuild. This replaces the monolithic 2,000+ line template.
 *
 * Usage:
 *   import { getAgentBridgeScript, getAgentBridgeService } from './bundle';
 *   const script = getAgentBridgeScript();
 */

import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

let cachedBundle: string | null = null;
let inflight: Promise<string> | null = null;

function getSourceDir(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);
  if (currentDir.includes('/dist/') || currentDir.endsWith('/dist')) {
    const packageRoot = currentDir.replace(/\/dist(\/.*)?$/, '');
    return path.join(packageRoot, 'src', 'services', 'backends', 'agent-bridge');
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
  if (curDir.includes('/dist/') || curDir.endsWith('/dist')) {
    const pkgRoot = curDir.replace(/\/dist(\/.*)?$/, '');
    const pre = path.join(pkgRoot, 'dist', 'prebundled', 'agent-bridge.js');
    if (fs.existsSync(pre)) {
      cachedBundle = fs.readFileSync(pre, 'utf8');
      return cachedBundle;
    }
  }

  console.warn('[agent-bridge] prebundled artifact missing — falling back to runtime esbuild');
  const esbuild = await import('esbuild');
  const sourceDir = getSourceDir();
  const packageRoot = path.resolve(sourceDir, '..', '..', '..', '..');
  const entryPoint = path.join(sourceDir, 'src', 'main.ts');

  const result = await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    minify: false,
    write: false,
    tsconfig: path.join(packageRoot, 'tsconfig.json'),
    external: [
      'fs', 'path', 'crypto', 'http', 'https', 'url', 'events', 'stream', 'util', 'os',
      'child_process', 'ws', 'node-pty', 'better-sqlite3', 'isolated-vm',
    ],
    loader: {
      '.md': 'text', '.sh': 'text', '.txt': 'text', '.conf': 'text',
      '.c': 'text', '.h': 'text', '.service': 'text', '.slice': 'text', '.timer': 'text',
    },
  });

  if (!result.outputFiles?.[0]) {
    throw new Error('esbuild produced no output');
  }

  cachedBundle = result.outputFiles[0].text;
  return cachedBundle;
}

/**
 * Get the agent bridge script for VPS deployment.
 */
export async function getAgentBridgeScript(): Promise<string> {
  const bundledCode = await bundleModular();

  return `// ellul Agent Bridge (Workbench WebSocket Server)
${bundledCode}
`;
}

/**
 * Get the agent bridge script synchronously (for compatibility).
 */
export function getAgentBridgeScriptSync(): string {
  const preBundledPath = path.join(__dirname, 'dist', 'server.js');
  if (fs.existsSync(preBundledPath)) {
    const bundledCode = fs.readFileSync(preBundledPath, 'utf8');
    return `// ellul Agent Bridge (Workbench WebSocket Server)
${bundledCode}
`;
  }

  throw new Error('Pre-bundled agent-bridge not found. Run build first or use async getAgentBridgeScript()');
}

/**
 * Generate the systemd service file for agent-bridge.
 * @param svcUser - Service user name (coder for free tier, dev for paid)
 */
export function getAgentBridgeService(svcUser: string = "dev", heapCapMb?: number | null): string {
  const svcHome = `/home/${svcUser}`;
  const nodeFlags = heapCapMb ? `--max-old-space-size=${heapCapMb} ` : '';
  const isFreeTier = svcUser === 'coder';
  const securityBlock = isFreeTier
    ? `# Security hardening (free tier)
# NoNewPrivileges intentionally NOT set — agent-bridge needs sudo for
# ellul-agent-namespace (per-project isolation). Sudoers restricts sudo
# to ONLY that script. SUID bits removed from dangerous binaries in security.ts.
SupplementaryGroups=shield-ipc
ProtectSystem=strict
PrivateTmp=true
LimitCORE=0
ReadWritePaths=${svcHome} /etc/ellul/agent-bridge /tmp /run
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true`
    : `# Paid tier — allow sudo for system package installs and namespace isolation
SupplementaryGroups=shield-ipc
PrivateTmp=true
LimitCORE=0
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true`;
  return `[Unit]
Description=ellul Agent Bridge
After=network-online.target local-fs.target ellul-luks-boot.service ellul-sovereign-shield.service ellul-namespaced.service
Wants=network-online.target ellul-luks-boot.service ellul-namespaced.service
Requires=ellul-agent-bridge.socket
RequiresMountsFor=/etc/ellul /opt/ellul

[Service]
Type=notify
# NotifyAccess=all (not main): the bridge's sd_notify path in main.ts
# spawns systemd-notify as a detached child process (Node has no native
# AF_UNIX dgram, so this is the only practical way to write to
# NOTIFY_SOCKET). With NotifyAccess=main, systemd rejects every READY=1
# because the source PID is the spawned helper, not MAINPID — manifests
# as "reception only permitted for main PID X" in the journal and a
# 90s start-timeout on every fresh boot. NotifyAccess=all accepts
# notifications from any process in the bridge's cgroup; that cgroup
# is controlled (only bridge-spawned processes land in it under
# resource-v2 since pool spawns route to per-sandbox transient slices),
# so the security boundary is the same.
NotifyAccess=all
Sockets=ellul-agent-bridge.socket
Slice=ellul-control-plane.slice
User=${svcUser}
Group=${svcUser}
WorkingDirectory=${svcHome}
Environment=NODE_ENV=production
Environment=PORT=7700
Environment=NODE_PATH=${svcHome}/.node/lib/node_modules
Environment=PATH=${svcHome}/.node/bin:${svcHome}/.opencode/bin:${svcHome}/.local/bin:/usr/local/bin:/usr/bin:/bin
# SVC_USER must match systemd User= so the orphan sweeper can scope
# cursor-agent / opencode-serve / zeroclaw process reaping to processes
# this bridge owns. Without it, orphan-sweeper.service.ts hard-skips all
# three branches ("SVC_USER unset; refusing to sweep ... without owner
# constraint") and stale subprocesses accumulate. Mirrors watchdog
# (packages/vps/src/services/daemons/watchdog/index.ts:49).
Environment=SVC_USER=${svcUser}
# Dynamic heap sizing — EnvironmentFile provides NODE_OPTIONS when the
# provisioning-time memory tuner has written a per-host value; the
# leading dash makes the file optional so fresh installs before the
# tuner runs don't fail service start.
EnvironmentFile=-/etc/ellul/heap-caps/agent-bridge.env
EnvironmentFile=-/etc/default/ellul-secrets
# Fail loud at boot if any link of the Claude auth+trap chain is missing.
ExecStartPre=/usr/bin/test -x /usr/local/bin/ellul-claude-ns
ExecStartPre=/usr/bin/test -x /usr/local/bin/ellul-agent-namespace
# resource-v2: pool spawns route through ellul-spawn-scope which wraps
# systemd-run --scope --slice= --property=… for cgroup placement under
# per-sandbox transient slices. Missing on disk = pool spawns fall back to
# bridge cgroup (the failure mode v2 fixes), so refuse to start the bridge
# at all rather than silently degrade.
# Spec: docs/v2/architecture/resource-v2/03-spawn-routing.md
ExecStartPre=/usr/bin/test -x /usr/local/bin/ellul-spawn-scope
# Daemon socket gate: when nsd-enabled is set, the bridge requires the
# ellul-namespaced admin socket to be bound before accepting traffic.
# Without this gate, bridge would race the daemon at boot and fail every
# turn with "Namespace not running" until the next manifest sync — the
# 2026-04-29 fleet outage. RestartSec=5 retries until socket appears.
# Operator rollback: \`rm /etc/ellul/feature-flags/nsd-enabled\` falls
# through this check (legacy mode); pair with bridge code rollback.
ExecStartPre=/bin/sh -c '[ ! -e /etc/ellul/feature-flags/nsd-enabled ] || [ -S /run/ellul-ns/admin.sock ]'
# Refuse to start when vault was provisioned but bind mount didn't activate — jwt-secret + app secrets would be on plaintext rootfs.
ExecStartPre=/bin/sh -c '[ ! -f /etc/ellul-bootstrap/volume-was-encrypted ] || /usr/bin/mountpoint -q /etc/ellul'
ExecStart=${svcHome}/.node/bin/node ${nodeFlags}/usr/local/bin/ellul-agent-bridge
Restart=on-failure
RestartSec=5
KillMode=mixed
TimeoutStopSec=90
# CPU bandwidth limit — prevents the agent from monopolizing CPU and starving
# the sovereign-shield security service (which runs at SCHED_FIFO priority).
# 80% cap ensures sovereign-shield's gate expiry callbacks, credential destruction,
# and attestation responses always get scheduled promptly.
CPUQuota=80%
# Control plane — survive any SYSTEM OOM. The kernel must kill leaked
# CLI sessions (opencode/claude/etc) and runaway previews before
# touching the bridge that orchestrates them.
OOMScoreAdjust=-1000
# Memory caps. High = throttle threshold, Max = local cgroup OOM.
# v2 (resource-v2): pool processes (opencode-serve, cursor-agent acp,
# codex daemon, Pro Claude SDK) no longer inherit this cgroup — they
# spawn into per-sandbox transient slices under
# ellul-user-workload.slice via systemd-run --scope --slice=. The
# bridge's own RSS is ~170 M (Node + Effect + WebSocket server +
# adapter runtime + MetricsCollector sidecar), so 512 M holds the
# bridge plus immediate watchers without overprovisioning.
# Spec: docs/v2/architecture/resource-v2/02-cgroup-topology.md
MemoryHigh=384M
MemoryMax=512M
# Control plane never swaps. Pages reclaimed from agent-bridge would
# land in disk I/O contention with user previews and starve us of
# scheduling even though we're alive. OOM inside our own cgroup
# (bounded above) is cleaner than disk-backed throttling.
MemorySwapMax=0
# Bounded task count for the bridge itself. v2: pools land in per-sandbox
# transient slices, so this cap covers only the bridge process, the
# MetricsCollector sidecar, and the systemd-run wrapper invocations that
# return immediately. 256 is comfortable.
TasksMax=256
# Page-pin budget for vmtouch -l (MemoryDiscipline). 320 MB covers the
# top tier; smaller tiers consume what computeAdapterPoolProfile allots.
LimitMEMLOCK=320M
# Lets the bridge write its own memory.high. https://systemd.io/CGROUP_DELEGATION/
Delegate=memory

${securityBlock}

[Install]
WantedBy=multi-user.target
`;
}

export function getAgentBridgeSocketUnit(): string {
  return `[Unit]
Description=ellul Agent Bridge socket
PartOf=ellul-agent-bridge.service

[Socket]
ListenStream=127.0.0.1:7700
NoDelay=true
KeepAlive=true
ReusePort=false
Service=ellul-agent-bridge.service

[Install]
WantedBy=sockets.target
`;
}

/**
 * Get the MCP stdio relay script for deployment.
 * Deployed as /usr/local/bin/ellul-mcp-relay (mode 0755).
 */
export { getMcpRelayScript } from './src/application/mcp-tool/McpRelayScript';
