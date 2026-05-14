// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

/**
 * ellul-namespaced — systemd unit generator + bundled binary loader.
 *
 * ConditionPathExists=/etc/ellul/feature-flags/nsd-enabled gates startup.
 * The unit is enabled in systemd but won't start until the flag is
 * created. SuccessExitStatus=78 covers the kernel-too-old path
 * (EX_CONFIG) so a misprovisioned host doesn't restart-loop.
 *
 * The daemon binary tarball is bundled at bin/ and embedded into the
 * cloud-init payload as base64. This is the bootstrap fallback that
 * mirrors how bridge / file-api / etc. ship — without it, the only
 * delivery path is the manifest pipeline, and a single missed publish
 * (or DB wipe — 2026-04-29) bricks every fresh-provisioned VPS. The
 * manifest pipeline still serves hot upgrades; this is just the floor.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TARBALL_RE = /^ellul-namespaced-(.+)\.tar\.gz$/;

interface NamespacedDaemonTarball {
  filename: string;
  version: string;
  sha256: string;
  sizeBytes: number;
  base64: string;
}

let cachedTarball: NamespacedDaemonTarball | null = null;

function getBinDir(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = dirname(currentFile);
  if (currentDir.includes("/dist/") || currentDir.endsWith("/dist")) {
    const packageRoot = currentDir.replace(/\/dist(\/.*)?$/, "");
    return join(packageRoot, "src", "services", "daemons", "ellul-namespaced", "bin");
  }
  return join(currentDir, "bin");
}

/**
 * Load the bundled daemon tarball. Hard-fails if missing — bridge HEAD
 * cannot function without a daemon, and the cloud-init embed is the
 * only fallback when the manifest pipeline is unavailable. release.mjs
 * runs scripts/sync-namespaced-tarball.mjs as a build step to keep the
 * bundled tarball in lockstep with the latest build-cache version.
 */
export function getNamespacedDaemonTarball(): NamespacedDaemonTarball {
  if (cachedTarball) return cachedTarball;

  const binDir = getBinDir();
  if (!existsSync(binDir)) {
    throw new Error(
      `[ellul-namespaced] bundled tarball directory missing: ${binDir}\n` +
        `  Run: node scripts/sync-namespaced-tarball.mjs\n` +
        `  This is normally invoked by release.mjs build step.`,
    );
  }

  const candidates: Array<{ name: string; version: string }> = [];
  for (const entry of readdirSync(binDir)) {
    const m = TARBALL_RE.exec(entry);
    if (m && m[1]) candidates.push({ name: entry, version: m[1] });
  }

  if (candidates.length === 0) {
    throw new Error(
      `[ellul-namespaced] no daemon tarball in ${binDir}\n` +
        `  Run: node scripts/sync-namespaced-tarball.mjs\n` +
        `  Without this binary, fresh-provisioned VPSes cannot start the daemon.`,
    );
  }
  if (candidates.length > 1) {
    throw new Error(
      `[ellul-namespaced] multiple daemon tarballs in ${binDir}: ${candidates.map((c) => c.name).join(", ")}\n` +
        `  bin/ should contain exactly one tarball.\n` +
        `  Run: node scripts/sync-namespaced-tarball.mjs (auto-prunes older versions).`,
    );
  }

  const first = candidates[0]!;
  const name = first.name;
  const version = first.version;
  const path = join(binDir, name);
  const buffer = readFileSync(path);
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const sizeBytes = statSync(path).size;
  const base64 = buffer.toString("base64");

  cachedTarball = {
    filename: name,
    version,
    sha256,
    sizeBytes,
    base64,
  };
  return cachedTarball;
}

export function getNamespacedDaemonService(): string {
  return `[Unit]
Description=ellul Namespaced Daemon
Documentation=https://github.com/ellul-ai/ellul.ai/blob/main/packages/vps/docs/ELLUL-NAMESPACED-PROTOCOL.md
After=local-fs.target ellul-luks-boot.service
Before=ellul-agent-bridge.service
RequiresMountsFor=/etc/ellul /opt/ellul
ConditionPathExists=/etc/ellul/feature-flags/nsd-enabled

[Service]
Type=notify
User=root
Group=root
NotifyAccess=main
# Refuse to start when vault was provisioned but bind mount didn't activate — secrets would be on plaintext rootfs.
ExecStartPre=/bin/sh -c '[ ! -f /etc/ellul-bootstrap/volume-was-encrypted ] || /usr/bin/mountpoint -q /etc/ellul'
ExecStartPre=+/bin/sh -c 'U=$(cat /etc/ellul/svc-user 2>/dev/null || echo coder); H=$(getent passwd "$U" | cut -d: -f6); for f in .claude.json .gitconfig; do [ -f "$H/$f" ] || { printf "{}\\n" > "$H/$f" && chown "$U:" "$H/$f" && chmod 0600 "$H/$f"; }; done'
ExecStart=/usr/local/bin/ellul-namespaced
Restart=on-failure
RestartSec=2
SuccessExitStatus=78
WatchdogSec=15

LimitCORE=0
LockPersonality=true
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/run/ellul-ns /var/log/ellul /run /var/lib/ellul /etc/ellul
# ProtectHome NOT set: daemon bind-mounts into project user homes. The +
# prefixed ExecStartPre below creates dotfiles outside the sandbox since
# ProtectSystem=strict makes /home read-only for ExecStart.
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=false
RestrictAddressFamilies=AF_UNIX AF_NETLINK AF_INET AF_INET6
# RestrictNamespaces NOT set: daemon's job IS creating mnt/pid/net namespaces.
# systemd's RestrictNamespaces seccomp filter returns ENOSYS for clone3 since
# BPF can't inspect clone_args struct, breaking our atomic CLONE_INTO_CGROUP
# fork. CapabilityBoundingSet (CAP_SYS_ADMIN required for namespace ops) is
# the real gate.
SystemCallArchitectures=native
MemoryDenyWriteExecute=true
RestrictRealtime=true
RestrictSUIDSGID=true
CapabilityBoundingSet=CAP_SYS_ADMIN CAP_NET_ADMIN CAP_NET_RAW CAP_SETUID CAP_SETGID CAP_DAC_OVERRIDE CAP_CHOWN CAP_SYS_PTRACE CAP_SYS_CHROOT
AmbientCapabilities=
OOMScoreAdjust=-900
Slice=ellul-control-plane.slice
TasksMax=64
MemoryMax=128M

[Install]
WantedBy=multi-user.target
`;
}
