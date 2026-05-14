// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Sovereign Shield Bundle Generator
 *
 * Bundles the modular TypeScript source files into a deployable JavaScript
 * script using esbuild. This replaces the monolithic 7,000+ line template.
 *
 * Usage:
 *   import { getSovereignShieldScript, getSovereignShieldService } from './bundle';
 *   const script = getSovereignShieldScript(hostname);
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
    return path.join(packageRoot, 'src', 'services', 'auth', 'sovereign-shield');
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
    const pre = path.join(pkgRoot, 'dist', 'prebundled', 'sovereign-shield.js');
    if (fs.existsSync(pre)) {
      cachedBundle = fs.readFileSync(pre, 'utf8');
      return cachedBundle;
    }
  }

  console.warn('[sovereign-shield] prebundled artifact missing — falling back to runtime esbuild');
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
      'net', 'tls', 'dns', 'zlib', 'buffer', 'querystring', 'string_decoder',
      'child_process', 'worker_threads', 'perf_hooks', 'async_hooks',
      'better-sqlite3',
      '@solana/web3.js',
      'bip39',
      'ed25519-hd-key',
    ],
    plugins: [{
      name: 'static-text',
      setup(build) {
        build.onLoad({ filter: /[/\\]static[/\\][^/\\]+\.(html|js\.map|js)$/ }, async (args) => ({
          contents: `export default ${JSON.stringify(fs.readFileSync(args.path, 'utf8'))}`,
          loader: 'js',
        }));
      },
    }],
  });

  if (!result.outputFiles?.[0]) {
    throw new Error('esbuild produced no output');
  }

  cachedBundle = result.outputFiles[0].text;
  return cachedBundle;
}

// ── PQC ML-KEM Browser Bundle ──

// ── PQC ML-KEM Browser Bundle ──

/**
 * Pre-built browser ES module bundle of @noble/post-quantum/ml-kem.js.
 * Generated at build time by pqc-browser-bundle.build.ts (runs during `pnpm build`).
 *
 * No runtime esbuild, no npm packages at runtime — the bundle is a static string
 * baked into the VPS package at build time and written to disk at provisioning time.
 */
import { PQC_MLKEM_BROWSER_BUNDLE } from './pqc-mlkem-bundle';

export async function getMlKemBrowserBundle(): Promise<string> {
  return PQC_MLKEM_BROWSER_BUNDLE;
}

/**
 * Get the sovereign shield script for VPS deployment.
 * Returns JavaScript code that runs the auth service.
 */
export async function getSovereignShieldScript(hostname: string): Promise<string> {
  const bundledCode = await bundleModular();

  return `// ellul Sovereign Shield (VPS Authentication Service)
process.env.ELLUL_HOSTNAME = ${JSON.stringify(hostname)};

${bundledCode}
`;
}

/**
 * Get the sovereign shield script synchronously (for compatibility).
 * Uses pre-bundled output if available.
 */
export function getSovereignShieldScriptSync(hostname: string): string {
  // For synchronous use, read from pre-bundled file if available
  const preBundledPath = path.join(__dirname, 'dist', 'server.js');
  if (fs.existsSync(preBundledPath)) {
    const bundledCode = fs.readFileSync(preBundledPath, 'utf8');
    return `// ellul Sovereign Shield (VPS Authentication Service)
process.env.ELLUL_HOSTNAME = ${JSON.stringify(hostname)};
${bundledCode}
`;
  }

  // Fallback: throw error indicating async bundle is needed
  throw new Error('Pre-bundled sovereign-shield not found. Run build first or use async getSovereignShieldScript()');
}

/**
 * Generate the systemd service file for sovereign-shield.
 */
/**
 * Oneshot service that creates paths required by sovereign-shield's ReadWritePaths.
 * Runs as root with NO namespace restrictions — creates files that must exist before
 * systemd sets up the mount namespace for the main shield service.
 * Separate service because ExecStartPre=+ doesn't reliably bypass mount namespace
 * setup on all systemd versions (tested broken on Ubuntu 22.04 systemd 249).
 */
export function getSovereignShieldPrereqService(svcUser: string = "dev"): string {
  return `[Unit]
Description=ellul Sovereign Shield Path Setup
Before=ellul-sovereign-shield.service
DefaultDependencies=no
After=local-fs.target

[Service]
Type=oneshot
RemainAfterExit=yes
# Pre-create shield-debug.jsonl owned by shield-runner so DebugLog.ts can append.
# /var/log/ellul itself is ${svcUser}-owned 0755, so shield-runner (running as
# "other") cannot create files there at runtime — the file must already exist
# with shield-runner ownership and 0644 perms (world-readable, owner-writable).
ExecStart=/bin/bash -c 'mkdir -p /home/${svcUser}/.ellul-identity; touch /home/${svcUser}/.ellul-cli-env; mkdir -p /home/${svcUser}/projects /home/${svcUser}/.ssh /run/shield /var/log/ellul; chown ${svcUser}:${svcUser} /home/${svcUser}/.ellul-identity /home/${svcUser}/.ellul-cli-env; touch /var/log/ellul/shield-debug.jsonl; chown shield-runner:shield-runner /var/log/ellul/shield-debug.jsonl 2>/dev/null || true; chmod 0644 /var/log/ellul/shield-debug.jsonl'

[Install]
WantedBy=multi-user.target
`;
}

/**
 * Oneshot service that handles LUKS volume opening, mounting, and vault
 * bind-mount restoration BEFORE any other ellul service starts.
 *
 * Solves the encrypted volume boot problem:
 * - crypttab doesn't work (Hetzner volumes not ready at early boot)
 * - Enforcer was too late (5+ min for Argon2id + PrivateTmp namespace)
 * - Services started before volume was open → 503
 *
 * Enhanced mode: opens LUKS with platform keyfile automatically.
 * Sovereign mode: exits with /run/ellul-luks-pending marker, Caddy
 *   serves unlock UI, user PRF gesture unlocks via Shield endpoint.
 *
 * Runs in PID 1's mount namespace (no PrivateTmp, no PrivateDevices)
 * so all mounts are globally visible to dependent services.
 */
export function getLuksBootService(): string {
  return `[Unit]
Description=ellul LUKS Volume Boot
DefaultDependencies=no
After=local-fs.target ellul-shield-prereq.service
Before=caddy.service postgresql.service ellul-sovereign-shield.service ellul-enforcer.service ellul-file-api.service ellul-agent-bridge.service ellul-ide.service ellul-watchdog.service ellul-term-proxy.service ellul-perf-monitor.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/ellul-luks-boot
TimeoutStartSec=180

[Install]
WantedBy=multi-user.target
`;
}

/**
 * Generate the /usr/local/bin/ellul-luks-boot script.
 *
 * This is a standalone bash script — no dependency on the enforcer.
 * Handles: LUKS open, mount, vault bind mounts, ownership fix.
 */
export function getLuksBootScript(svcUser: string = "dev"): string {
  return `#!/bin/bash
# ellul LUKS Volume Boot
# Runs as systemd oneshot BEFORE all services.
# Opens encrypted volume, mounts, restores vault bind mounts.
# Non-encrypted servers: exits immediately (zero cost).
set -o pipefail

SVC_USER="${svcUser}"
SVC_HOME="/home/$SVC_USER"
VAULT="$SVC_HOME/.ellul-vault"

log() {
  echo "[\$(date -Iseconds)] [luks-boot] \$1"
}

# ── Step 1: Check if encrypted ──
# Check boot volume path first (never vault-bound), then vault-backed path as fallback.
# Boot volume marker survives vault bind-mount overlay.
if [ ! -f /etc/ellul-bootstrap/volume-was-encrypted ] && [ ! -f /etc/ellul/volume-was-encrypted ]; then
  # Not encrypted — nothing to do. Idempotent marker for non-encrypted flow.
  touch /run/ellul-decrypted 2>/dev/null || true
  exit 0
fi

log "Encrypted volume detected"

# ── Step 2: Check if LUKS already open ──
if [ -b /dev/mapper/luks-home ]; then
  log "LUKS mapping already open"
else
  # ── Step 3: Wait for block device ──
  # Read from boot partition first (never vault-bound), fall back to /etc/ellul/.
  # On reboot the vault bind-mount overlays /etc/ellul/ with an empty dir,
  # hiding the volume-device file until the vault is restored — which is
  # exactly what we're trying to do here. Boot partition is always readable.
  #
  # If neither location has it (servers provisioned before the boot-partition
  # fix), wait up to 120s for cloud-init to mount the vault and expose the
  # file. This is the safety net that makes ALL servers work, not just new ones.
  VOL_DEVICE=""
  DEVICE_WAIT=0
  while [ -z "\$VOL_DEVICE" ] && [ \$DEVICE_WAIT -lt 120 ]; do
    VOL_DEVICE=\$(cat /etc/ellul-bootstrap/volume-device 2>/dev/null || cat /etc/ellul/volume-device 2>/dev/null)
    if [ -n "\$VOL_DEVICE" ]; then break; fi
    if [ \$((\$DEVICE_WAIT % 15)) -eq 0 ] && [ \$DEVICE_WAIT -gt 0 ]; then
      log "Waiting for volume-device file (\$DEVICE_WAIT/120s)..."
    fi
    sleep 1
    DEVICE_WAIT=\$((\$DEVICE_WAIT + 1))
  done
  if [ -z "\$VOL_DEVICE" ]; then
    log "ERROR: volume-device not found after 120s (checked /etc/ellul-bootstrap/ and /etc/ellul/)"
    touch /run/ellul-luks-pending
    exit 0
  fi
  [ \$DEVICE_WAIT -gt 0 ] && log "volume-device found after \${DEVICE_WAIT}s"

  REAL_DEV=\$(readlink -f "$VOL_DEVICE" 2>/dev/null || echo "$VOL_DEVICE")
  log "Waiting for device $REAL_DEV..."

  WAIT=0
  while [ ! -b "$REAL_DEV" ] && [ $WAIT -lt 90 ]; do
    if [ \$((WAIT % 10)) -eq 0 ] && [ $WAIT -gt 0 ]; then
      udevadm trigger --subsystem-match=block 2>/dev/null || true
      udevadm settle --timeout=5 2>/dev/null || true
      log "Still waiting for device ($WAIT/90s)..."
    fi
    sleep 1
    WAIT=\$((WAIT + 1))
    # Re-resolve symlink each iteration (udev may create it late)
    [ ! -b "$REAL_DEV" ] && REAL_DEV=\$(readlink -f "$VOL_DEVICE" 2>/dev/null || echo "$VOL_DEVICE")
  done

  if [ ! -b "$REAL_DEV" ]; then
    log "ERROR: device $VOL_DEVICE not found after 90s"
    touch /run/ellul-luks-pending
    exit 0
  fi

  log "Device ready ($WAIT seconds)"

  # Verify it's actually LUKS
  if ! cryptsetup isLuks "$REAL_DEV" 2>/dev/null; then
    log "ERROR: $REAL_DEV is not a LUKS volume"
    touch /run/ellul-luks-pending
    exit 0
  fi

  # ── Step 4: Check sovereign mode ──
  # Sovereign marker is on the bootstrap partition (root FS, never bind-mounted).
  # If sovereign, skip ALL auto-open attempts — only the user's PRF key can unlock.
  # This is defense-in-depth: the keyfile should be destroyed during sovereign
  # transition, but even if a copy survives, this marker prevents auto-open.
  if [ -f /etc/ellul-bootstrap/volume-security-mode ]; then
    _SEC_MODE=\$(cat /etc/ellul-bootstrap/volume-security-mode 2>/dev/null)
    if [ "\$_SEC_MODE" = "sovereign" ]; then
      log "Sovereign mode — PRF unlock required (no platform auto-open)"
      touch /run/ellul-luks-pending
      exit 0
    fi
  fi

  # ── Step 5: Open LUKS (enhanced mode) ──
  # Keyfile may be in boot partition (survives vault overlay) or /etc/ellul/.
  # Wait up to 30s for the keyfile if neither location has it yet (cloud-init
  # may still be mounting the vault).
  KEYFILE=""
  KEY_WAIT=0
  while [ -z "\$KEYFILE" ] && [ \$KEY_WAIT -lt 30 ]; do
    if [ -f "/etc/ellul-bootstrap/.luks-platform-keyfile" ]; then
      KEYFILE="/etc/ellul-bootstrap/.luks-platform-keyfile"
    elif [ -f "/etc/ellul/.luks-platform-keyfile" ]; then
      KEYFILE="/etc/ellul/.luks-platform-keyfile"
    fi
    [ -n "\$KEYFILE" ] && break
    sleep 1
    KEY_WAIT=\$((\$KEY_WAIT + 1))
  done
  if [ -n "\$KEYFILE" ]; then
    log "Opening LUKS with platform keyfile (enhanced mode)..."
    # Try slot 1 first (platform recovery key, pbkdf2 — fast).
    # Slot 0 may be PRF-derived (argon2id) which can OOM on low-memory hosts.
    if cryptsetup luksOpen --key-file="$KEYFILE" --key-slot 1 "$REAL_DEV" luks-home 2>/dev/null; then
      log "LUKS opened via slot 1 (recovery key)"
    elif cryptsetup luksOpen --key-file="$KEYFILE" "$REAL_DEV" luks-home 2>&1; then
      log "LUKS opened (all slots)"
    else
      log "ERROR: cryptsetup luksOpen failed"
      touch /run/ellul-luks-pending
      exit 0
    fi
  else
    log "No platform keyfile — sovereign mode (waiting for user unlock)"
    touch /run/ellul-luks-pending
    exit 0
  fi
fi

# ── Step 5: Mount volume ──
if mountpoint -q "$SVC_HOME" 2>/dev/null; then
  log "$SVC_HOME already mounted"
else
  mkdir -p "$SVC_HOME"
  if ! mount -o nosuid,nodev /dev/mapper/luks-home "$SVC_HOME" 2>&1; then
    # Race with systemd fstab auto-mount: by the time we try, systemd may have mounted it.
    # Re-check mountpoint before giving up.
    sleep 1
    if mountpoint -q "$SVC_HOME" 2>/dev/null; then
      log "$SVC_HOME mounted by systemd (fstab race)"
    else
      log "ERROR: failed to mount /dev/mapper/luks-home at $SVC_HOME"
      touch /run/ellul-luks-pending
      exit 0
    fi
  else
    log "Volume mounted at $SVC_HOME"
  fi
fi

# ── Step 6: Restore vault bind mounts ──
if [ -f "$VAULT/.initialized" ] && [ -d "$VAULT/etc/ellul" ]; then
  log "Restoring vault bind mounts..."

  # Restore UID/GID map (users may differ after server change)
  if [ -f "$VAULT/.gid-map" ]; then
    while IFS=: read -r _type _name _id; do
      case "\$_type" in
        g) getent group "\$_name" >/dev/null 2>&1 || groupadd --gid "\$_id" "\$_name" 2>/dev/null || groupadd --system --gid "\$_id" "\$_name" 2>/dev/null || true ;;
        u) id -u "\$_name" >/dev/null 2>&1 || useradd --system --uid "\$_id" --no-create-home --shell /usr/sbin/nologin "\$_name" 2>/dev/null || true ;;
      esac
    done < "$VAULT/.gid-map"
  fi

  # Bind mount each vault path (with seed-before-mount merge)
  BIND_OK=0
  BIND_FAIL=0
  BIND_MERGED=0
  for _vpath in etc/ellul etc/caddy etc/iptables etc/ssh/authorized_keys \\
                var/lib/ellul-shielded var/lib/postgresql \\
                var/log/ellul var/log/caddy opt/ellul; do
    if [ -d "$VAULT/\$_vpath" ]; then
      mkdir -p "/\$_vpath" 2>/dev/null
      # Seed-before-mount: if vault dir is empty but root FS has content, merge.
      # Prevents SSH keys and boot markers from being hidden by empty vault overlay.
      if ! mountpoint -q "/\$_vpath" 2>/dev/null; then
        _vc=\$(ls -A "$VAULT/\$_vpath" 2>/dev/null | wc -l)
        _rc=\$(ls -A "/\$_vpath" 2>/dev/null | wc -l)
        if [ "\$_vc" -eq 0 ] && [ "\$_rc" -gt 0 ]; then
          cp -a "/\$_vpath/." "$VAULT/\$_vpath/" 2>/dev/null || true
          BIND_MERGED=\$((BIND_MERGED + 1))
          log "Merged root FS → vault for /\$_vpath (\$_rc items)"
        fi
      fi
      if mountpoint -q "/\$_vpath" 2>/dev/null; then
        BIND_OK=\$((BIND_OK + 1))
      elif mount --bind "$VAULT/\$_vpath" "/\$_vpath" 2>/dev/null; then
        BIND_OK=\$((BIND_OK + 1))
      else
        log "WARN: bind mount failed for /\$_vpath"
        BIND_FAIL=\$((BIND_FAIL + 1))
      fi
    fi
  done
  log "Vault bind mounts: $BIND_OK active, $BIND_FAIL failed, $BIND_MERGED merged"

  # Fix ownership on vault-backed paths
  chown root:shield /etc/ssh/authorized_keys 2>/dev/null || true
  chmod 770 /etc/ssh/authorized_keys 2>/dev/null || true

  # Restore iptables
  if [ -f /etc/iptables/rules.v4 ] && [ -s /etc/iptables/rules.v4 ]; then
    iptables-restore < /etc/iptables/rules.v4 2>/dev/null || true
  fi

  # Reload systemd so it recognises new mount state
  systemctl daemon-reload 2>/dev/null || true

  # Force-restart services that may have started before the vault was mounted.
  # On reboot, the ordering is: local-fs.target → luks-boot → services.
  # If luks-boot took time (device wait, LUKS open, mount), services may have
  # started with the pre-mount /etc/ellul/ (empty or stale). The restart
  # ensures they re-read the now-mounted vault config (domains, Caddyfile,
  # shield tokens, authorized keys). This is the safety net that makes
  # preview, auth, and SSH work deterministically after every boot.
  #
  # CRITICAL: --no-block is mandatory.
  # This unit is Type=oneshot with Before=caddy.service ellul-sovereign-shield.service
  # etc. Those services cannot become active until this unit completes (exits 0 +
  # RemainAfterExit). A synchronous 'systemctl restart caddy' here blocks waiting
  # for caddy to be active — but caddy is waiting for us to finish. That cycle
  # only breaks when TimeoutStartSec=180 fires and systemd kills luks-boot, by
  # which point caddy has been SIGTERM'd as part of the incomplete restart
  # transaction and is never brought back. --no-block queues the restart into
  # systemd's job table without waiting, so we can exit, the Before= ordering
  # lets caddy start, and the queued restart lands cleanly (as a start, since
  # nothing was active yet).
  log "Restarting services to pick up vault-mounted config..."
  systemctl restart --no-block caddy 2>/dev/null || true
  systemctl restart --no-block ellul-sovereign-shield 2>/dev/null || true
  # Small delay for shield to write internal tokens before file-api starts
  sleep 1
  systemctl restart --no-block ellul-file-api 2>/dev/null || true
  systemctl restart --no-block ellul-agent-bridge 2>/dev/null || true
  log "Services restarted with vault config"
else
  log "WARN: vault not initialized at $VAULT — services will start with root FS config"
fi

# ── Step 7: Clean stale crypttab entries ──
# crypttab doesn't work with Hetzner late-attached volumes — luks-boot handles it instead
if [ -f /etc/crypttab ] && grep -q 'luks-home' /etc/crypttab 2>/dev/null; then
  sed -i '/luks-home/d' /etc/crypttab 2>/dev/null || true
  log "Removed stale crypttab entry"
fi

# ── Step 8: Bootstrap integrity tripwire ──
# Verify that the bootstrap partition (passkey public keys on root FS) hasn't been
# tampered with since the last sleep/shutdown. The expected hash is stored INSIDE
# the encrypted volume — an attacker without the LUKS key can't forge it.
if [ -f /etc/ellul-bootstrap/passkeys.json ] && [ -f /var/lib/ellul-shielded/bootstrap-integrity.hash ]; then
  CURRENT_HASH=\$(sha256sum /etc/ellul-bootstrap/passkeys.json | awk '{print \$1}')
  EXPECTED_HASH=\$(cat /var/lib/ellul-shielded/bootstrap-integrity.hash 2>/dev/null)
  if [ "\$CURRENT_HASH" != "\$EXPECTED_HASH" ]; then
    log "SECURITY ALERT: Bootstrap partition tampered! Expected \${EXPECTED_HASH:0:16}..., got \${CURRENT_HASH:0:16}..."
    # Continue boot but flag for sovereign-shield to raise alert
    echo "tampered" > /run/ellul-bootstrap-tampered
  else
    log "Bootstrap integrity verified"
  fi
fi

# ── Done ──
rm -f /run/ellul-luks-pending 2>/dev/null || true
touch /run/ellul-decrypted 2>/dev/null || true
log "Boot complete — volume decrypted and mounted"
exit 0
`;
}

/**
 * Generate the /usr/local/bin/ellul-luks-unlock script.
 *
 * Privileged wrapper for sovereign mode PRF unlock. Reads the 32-byte
 * PRF-derived key from stdin, opens LUKS, then delegates to mount-volume
 * for the rest of the mount + vault restoration flow.
 *
 * Called by file-api via sudo (file-api runs as dev, not root).
 * Sudoers entry: $SVC_USER ALL=(root) NOPASSWD: /usr/local/bin/ellul-luks-unlock
 */
export function getLuksUnlockScript(): string {
  return `#!/bin/bash
set -euo pipefail
# ellul LUKS Unlock Wrapper (sovereign mode PRF unlock)
# Reads key from stdin → opens LUKS → delegates to mount-volume

DEVICE=\$(cat /etc/ellul-bootstrap/volume-device 2>/dev/null || cat /etc/ellul/volume-device 2>/dev/null)
if [ -z "\$DEVICE" ]; then
  echo '{"success":false,"error":"No volume device configured (checked boot partition and /etc/ellul/)"}'
  exit 1
fi

REAL_DEV=\$(readlink -f "\$DEVICE" 2>/dev/null || echo "\$DEVICE")
if [ ! -b "\$REAL_DEV" ]; then
  echo '{"success":false,"error":"Device not found"}'
  exit 1
fi

# If already open, skip to mount
if [ ! -b /dev/mapper/luks-home ]; then
  if ! cryptsetup luksOpen --key-file=- "\$REAL_DEV" luks-home; then
    echo '{"success":false,"error":"cryptsetup luksOpen failed"}'
    exit 1
  fi
fi

# Delegate to mount-volume for mount + fstab + vault restore
exec /usr/local/bin/ellul-mount-volume mount "\$DEVICE"
`;
}

export function getSovereignShieldService(svcUser: string = "dev", heapCapMb?: number | null): string {
  const nodeFlags = heapCapMb ? `--max-old-space-size=${heapCapMb} ` : '';
  return `[Unit]
Description=ellul Sovereign Shield (Passkey Auth)
After=network-online.target local-fs.target ellul-shield-prereq.service ellul-luks-boot.service
Wants=network-online.target ellul-luks-boot.service
Requires=ellul-shield-prereq.service
RequiresMountsFor=/etc/ellul /opt/ellul

[Service]
Type=simple
Slice=ellul-control-plane.slice
# UID separation: shield-runner is a dedicated system user, NOT $SVC_USER.
# This creates a kernel-enforced boundary — the agent ($SVC_USER) physically
# cannot read shield files, signal shield processes, or forge internal tokens.
User=shield-runner
Group=shield-runner
WorkingDirectory=/opt/ellul/auth
# Dynamic heap sizing — provisioning-time memory tuner writes a host-sized
# NODE_OPTIONS into this file. Optional (leading dash) so fresh installs
# before the tuner runs fall back to the static nodeFlags inlined below.
EnvironmentFile=-/etc/ellul/heap-caps/sovereign-shield.env
# Refuse to start when vault was provisioned but bind mount didn't activate — passkey state, jwt-secret, app secrets would be on plaintext rootfs.
ExecStartPre=/bin/sh -c '[ ! -f /etc/ellul-bootstrap/volume-was-encrypted ] || /usr/bin/mountpoint -q /etc/ellul'
ExecStart=/usr/bin/node ${nodeFlags}/opt/ellul/auth/server.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
# Pass SVC_USER so shield knows which user to runuser into for git/project ops
Environment=ELLUL_SVC_USER=${svcUser}

# Security hardening
ProtectSystem=strict
# /etc/ellul: read configs (domain, api-url) + write shield-data, secrets, tier, markers
ReadWritePaths=/etc/ellul /etc/ellul-bootstrap /etc/ssh/authorized_keys /var/lib/ellul-shielded /run/shield /etc/caddy /var/log/caddy /var/log/ellul /home/${svcUser}/projects /home/${svcUser}/.ssh /home/${svcUser}/.ellul-identity /home/${svcUser}/.ellul-cli-env
# ProtectHome=read-only: /home is read-only except for paths in ReadWritePaths.
# shield-runner needs write access to $SVC_HOME/projects for git operations
# (push/pull/clone run as shield-runner via sudo wrappers, and runuser children
# inherit the parent's mount namespace — ProtectHome=true would block them too).
# The rest of /home is read-only, limiting shield-runner's filesystem reach.
ProtectHome=read-only
PrivateTmp=true
# NoNewPrivileges intentionally omitted — shield-runner delegates to privileged
# helper scripts via sudo (git as $SVC_USER, pg_* as postgres). NoNewPrivileges
# blocks setuid binaries like sudo/runuser.
# CAP_SETUID/SETGID: required for runuser -l postgres (database admin)
# and runuser -l $SVC_USER (git operations in project dirs).
# CAP_CHOWN/FOWNER: required for SSH key management and file ownership operations.
# CAP_DAC_OVERRIDE: required for sudo to function (reads /etc/sudoers, /etc/shadow).
# Without it, sudo shield-project-lock fails and project creation breaks.
# SSH authorized_keys writes use group perms (root:shield 770) and don't need this.
CapabilityBoundingSet=CAP_SETUID CAP_SETGID CAP_CHOWN CAP_FOWNER CAP_DAC_OVERRIDE
AmbientCapabilities=CAP_SETUID CAP_SETGID CAP_CHOWN CAP_FOWNER
# shield: read node.key (root:shield 640), write to secrets dir (root:shield 2770),
#         write to PM2 shielded home (root:shield 2770)
# caddy: write Caddy site configs for deploy/expose operations
# shield-ipc: write per-service internal tokens to /run/shield/internal-{service}.token
SupplementaryGroups=shield caddy shield-ipc
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
LimitCORE=0
RestrictSUIDSGID=true
# Real-time scheduling: gate expiry callbacks and credential destruction execute
# with guaranteed CPU preemption over agent workloads. The kernel scheduler will
# always preempt the agent (SCHED_OTHER/CFS) to run sovereign-shield, even under
# CPU monopolization attempts (fork bombs, busy loops).
CPUSchedulingPolicy=fifo
CPUSchedulingPriority=50
# OOM protection: security service is unkillable under memory pressure.
# -1000 means the kernel OOM killer will NEVER pick this process — only
# leaked CLI/preview/zeroclaw sessions in the user slice can be killed.
OOMScoreAdjust=-1000
MemoryHigh=512M

[Install]
WantedBy=multi-user.target
`;
}


/**
 * Generate the ellul-downgrade script.
 */
export function getDowngradeScript(): string {
  return `#!/bin/bash
set -e

TIER_FILE="/etc/ellul/security-tier"
LOG_FILE="/var/log/ellul-enforcer.log"
[ -f /etc/default/ellul ] && source /etc/default/ellul
SVC_USER="\${PS_USER:-dev}"
SVC_HOME="/home/\${SVC_USER}"
SSH_AUTH_KEYS="\${SVC_HOME}/.ssh/authorized_keys"

log() { echo "[$(date -Iseconds)] DOWNGRADE: $1" >> "$LOG_FILE"; echo "$1"; }

CURRENT_TIER="standard"
if [ -f "$TIER_FILE" ]; then
  CURRENT_TIER=$(cat "$TIER_FILE")
fi

if [ "$CURRENT_TIER" = "standard" ]; then
  log "Already at Standard tier"
  exit 0
fi

if [ "$CURRENT_TIER" = "web_locked" ] || [ "$CURRENT_TIER" = "private_locked" ]; then
  log "ERROR: $CURRENT_TIER tier requires passkey auth for downgrade"
  log "Use the dashboard to downgrade"
  exit 1
fi

log "Downgrading to Standard..."

# =============================================================================
# ATOMIC DOWNGRADE: Ensure web access works BEFORE removing SSH access
# Order matters: we must not lock the user out if something fails
# =============================================================================

# Step 1: Enable web terminal FIRST (remove disabled marker)
# This ensures web access will work once tier switches
log "Step 1: Enabling web terminal..."
rm -f /etc/ellul/shield-data/.terminal-disabled

# Step 2: Switch tier via API - this enables web terminal access
# If this fails, user still has SSH access (safe state)
log "Step 2: Switching tier to standard..."
SWITCH_RESULT=$(curl -s -X POST http://127.0.0.1:3005/_auth/tier/switch \\
  -H "Content-Type: application/json" \\
  -H "X-Internal-Request: enforcer" \\
  -d '{"tier":"standard","source":"cli"}' 2>&1)

if echo "$SWITCH_RESULT" | grep -q '"error"'; then
  log "ERROR: Tier switch failed: $SWITCH_RESULT"
  log "Aborting - SSH access preserved for safety"
  # Restore terminal disabled marker since tier switch failed
  touch /etc/ellul/shield-data/.terminal-disabled
  exit 1
fi

# Step 3: Verify web terminal is accessible before removing SSH
# Give services a moment to restart
log "Step 3: Verifying web access..."
sleep 2
systemctl restart ellul-enforcer 2>/dev/null || true
sleep 2

# Check that sovereign-shield is responding (web access works)
if ! curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3005/health | grep -q '200'; then
  log "WARNING: Web service health check failed, but tier already switched"
  log "Proceeding with SSH cleanup - web terminal should recover"
fi

# Step 4: NOW safe to remove SSH access (web terminal is available)
# SECURITY: Remove all SSH keys - they could be compromised
log "Step 4: Removing SSH keys for security..."
if [ -f "$SSH_AUTH_KEYS" ]; then
  # Backup keys just in case (will be cleaned up by enforcer later)
  cp "$SSH_AUTH_KEYS" "/etc/ellul/.ssh-keys-backup-$(date +%s)" 2>/dev/null || true
  rm -f "$SSH_AUTH_KEYS"
  log "SSH authorized_keys removed"
fi

# Step 5: Disable SSH service
log "Step 5: Disabling SSH access..."
ufw delete allow 22/tcp 2>/dev/null || true
systemctl stop sshd 2>/dev/null || true
systemctl disable sshd 2>/dev/null || true

log "Downgrade complete - web terminal enabled, SSH access removed"
log "SECURITY: All SSH keys have been removed. Add new keys if you upgrade again."
`;
}

/**
 * Generate the web-locked switch script.
 * From Standard with existing passkey: switches directly
 * Without passkey: generates setup token and outputs link for passkey registration
 */
export function getWebLockedSwitchScript(): string {
  return `#!/bin/bash
set -e

TIER_FILE="/etc/ellul/security-tier"
DOMAIN_FILE="/etc/ellul/domain"
SETUP_TOKEN_FILE="/etc/ellul/shield-data/.sovereign-setup-token"
SETUP_EXPIRY_FILE="/etc/ellul/shield-data/.sovereign-setup-expiry"
LOG_FILE="/var/log/ellul-enforcer.log"
[ -f /etc/default/ellul ] && source /etc/default/ellul
SVC_USER="\${PS_USER:-dev}"
SVC_HOME="/home/\${SVC_USER}"
SSH_AUTH_KEYS="\${SVC_HOME}/.ssh/authorized_keys"

log() { echo "[$(date -Iseconds)] WEB_LOCKED: $1" >> "$LOG_FILE"; echo "$1"; }

CURRENT_TIER=$(cat "$TIER_FILE" 2>/dev/null || echo "standard")
DOMAIN=$(cat "$DOMAIN_FILE" 2>/dev/null || echo "")

if [ -z "$DOMAIN" ]; then
  echo "ERROR: Domain not configured"
  exit 1
fi

# Check if passkey already exists using the tier/current endpoint (localhost only)
TIER_INFO=$(curl -s -H "X-Internal-Request: enforcer" http://127.0.0.1:3005/_auth/tier/current 2>/dev/null)
HAS_PASSKEYS=$(echo "$TIER_INFO" | grep -o '"hasPasskeys":true' || echo "")

if [ -n "$HAS_PASSKEYS" ]; then
  # ==========================================================================
  # ATOMIC SWITCH: Passkey exists - switch directly with verification
  # ==========================================================================
  log "Passkey found, switching to Web Locked tier..."

  # Step 1: Attempt tier switch
  SWITCH_RESULT=$(curl -s -X POST http://127.0.0.1:3005/_auth/tier/switch \\
    -H "Content-Type: application/json" \\
    -H "X-Internal-Request: enforcer" \\
    -d '{"tier":"web_locked","source":"cli"}' 2>&1)

  if echo "$SWITCH_RESULT" | grep -q '"error"'; then
    log "ERROR: Tier switch failed: $SWITCH_RESULT"
    echo "ERROR: Failed to switch to Web Locked tier"
    echo "Current access methods preserved."
    exit 1
  fi

  # Step 2: Verify the switch succeeded
  sleep 1
  NEW_TIER=$(cat "$TIER_FILE" 2>/dev/null || echo "unknown")
  if [ "$NEW_TIER" != "web_locked" ]; then
    log "WARNING: Tier file not updated to web_locked (shows: $NEW_TIER)"
  fi

  # Step 3: Verify web access works (passkey gate should be active)
  if curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3005/health | grep -q '200'; then
    log "Web Locked switch complete - sovereign-shield responding"
    echo "Web Locked mode enabled successfully."
    echo "Passkey authentication is now required for web access."
  else
    log "WARNING: Health check failed but tier switched"
    echo "Web Locked mode enabled (health check pending)."
  fi
else
  # ==========================================================================
  # NO PASSKEY: Generate setup link for browser registration
  # User must complete registration in browser to finish upgrade
  # ==========================================================================
  log "No passkey found - generating setup link..."

  # Generate random token
  TOKEN=$(openssl rand -hex 32)
  EXPIRY=$(($(date +%s) + 600))  # 10 minutes

  # Write token files atomically
  echo "$TOKEN" > "$SETUP_TOKEN_FILE.tmp"
  echo "$EXPIRY" > "$SETUP_EXPIRY_FILE.tmp"
  chmod 600 "$SETUP_TOKEN_FILE.tmp" "$SETUP_EXPIRY_FILE.tmp"
  mv "$SETUP_TOKEN_FILE.tmp" "$SETUP_TOKEN_FILE"
  mv "$SETUP_EXPIRY_FILE.tmp" "$SETUP_EXPIRY_FILE"

  echo ""
  echo "========================================"
  echo "  WEB LOCKED SETUP"
  echo "========================================"
  echo ""
  echo "Open this link in your browser to register a passkey:"
  echo ""
  echo "  https://$DOMAIN/_auth/setup?token=$TOKEN"
  echo ""
  echo "This link expires in 10 minutes."
  echo ""
  echo "After registering your passkey, Web Locked mode will be enabled."
  echo "========================================"

  log "Setup link generated for passkey registration"
fi
`;
}

/**
 * Generate the reset auth script.
 */
export function getResetAuthScript(): string {
  return `#!/bin/bash
set -e

AUTH_DB="/etc/ellul/shield-data/local-auth.db"
TIER_FILE="/etc/ellul/security-tier"
LOG_FILE="/var/log/ellul-enforcer.log"
[ -f /etc/default/ellul ] && source /etc/default/ellul
SVC_USER="\${PS_USER:-dev}"
SVC_HOME="/home/\${SVC_USER}"
SSH_AUTH_KEYS="\${SVC_HOME}/.ssh/authorized_keys"

log() { echo "[$(date -Iseconds)] RESET_AUTH: $1" >> "$LOG_FILE"; echo "$1"; }

CURRENT_TIER=$(cat "$TIER_FILE" 2>/dev/null || echo "standard")

# =============================================================================
# SAFETY CHECK: Prevent lockout - must have alternative access
# =============================================================================

# Check for SSH keys
HAS_SSH_KEYS=false
if [ -f "$SSH_AUTH_KEYS" ] && [ -s "$SSH_AUTH_KEYS" ]; then
  HAS_SSH_KEYS=true
fi

# Check if SSH is running
SSH_RUNNING=false
if systemctl is-active --quiet sshd 2>/dev/null; then
  SSH_RUNNING=true
fi

# Safety logic based on current tier
if [ "$CURRENT_TIER" = "web_locked" ] || [ "$CURRENT_TIER" = "private_locked" ]; then
  if [ "$HAS_SSH_KEYS" != "true" ] || [ "$SSH_RUNNING" != "true" ]; then
    log "ERROR: Cannot reset auth in $CURRENT_TIER without working SSH access"
    echo "ERROR: Resetting auth would lock you out!"
    echo ""
    echo "You are in Web Locked tier - passkeys are required for web access."
    echo "Resetting auth would clear passkeys with no way to log back in."
    echo ""
    echo "To proceed safely:"
    echo "  1. Add an SSH key first: sudo ellul-add-ssh-key 'ssh-ed25519 ...'"
    echo "  2. Verify SSH works: ssh \$SVC_USER@\$(hostname -I | awk '{print \$1}')"
    echo "  3. Then retry: sudo ellul-reset-auth"
    exit 1
  fi
  log "SSH access verified - safe to reset auth"
  echo "WARNING: SSH access detected - you can recover via SSH after reset."
fi

if [ ! -f "$AUTH_DB" ]; then
  log "No auth database found"
  echo "No auth database found - nothing to reset."
  exit 0
fi

echo ""
echo "AUTH RESET - THIS WILL CLEAR ALL AUTHENTICATION DATA"
echo ""
echo "  This will delete:"
echo "    - All passkeys (Face ID / Touch ID registrations)"
echo "    - All active sessions"
echo "    - All recovery codes"
echo "    - Audit log"
echo ""
if [ "$CURRENT_TIER" = "web_locked" ] || [ "$CURRENT_TIER" = "private_locked" ]; then
  echo "  IMPORTANT: You are in $CURRENT_TIER tier."
  echo "  After reset, you must re-register a passkey to access web terminal."
  echo "  SSH access will remain available for recovery."
fi
echo ""
read -p "Type RESET to confirm: " CONFIRM
if [ "$CONFIRM" != "RESET" ]; then
  echo "Aborted."
  exit 0
fi

log "Resetting all authentication data..."

# Backup current database
BACKUP_FILE="$AUTH_DB.backup.$(date +%s)"
cp "$AUTH_DB" "$BACKUP_FILE"
log "Database backed up to $BACKUP_FILE"

# Clear all tables but keep schema
sqlite3 "$AUTH_DB" <<EOF
DELETE FROM sessions;
DELETE FROM credential;
DELETE FROM recovery_codes;
DELETE FROM audit_log;
DELETE FROM auth_attempts;
DELETE FROM recovery_attempts;
DELETE FROM recovery_sessions;
DELETE FROM pop_nonces;
EOF

# Remove web_locked marker since passkeys are cleared
rm -f /etc/ellul/shield-data/.web_locked_activated

# If in a locked tier, downgrade to standard (no passkeys = can't stay locked)
if [ "$CURRENT_TIER" = "web_locked" ] || [ "$CURRENT_TIER" = "private_locked" ]; then
  log "Passkeys cleared - switching to standard tier (was $CURRENT_TIER)"
  echo "standard" > "$TIER_FILE"
  systemctl restart ellul-enforcer 2>/dev/null || true
fi

log "Auth reset complete. All sessions, passkeys, and recovery codes cleared."
echo ""
echo "Auth reset complete."
echo "  - Database backed up to: $BACKUP_FILE"
if [ "$CURRENT_TIER" = "web_locked" ] || [ "$CURRENT_TIER" = "private_locked" ]; then
  echo "  - Tier changed to: standard (was $CURRENT_TIER, passkeys required for locked tiers)"
  echo "  - Re-register a passkey to return to a locked tier"
fi
echo "  - User will need to re-register on next access."
`;
}

/**
 * Generate the tier switch helper script.
 */
export function getTierSwitchHelperScript(): string {
  return `#!/bin/bash
# Tier Switch Helper - called by enforcer after API confirms switch
# This is a low-level helper; prefer using the tier switch API directly

set -e

TIER_FILE="/etc/ellul/security-tier"
LOG_FILE="/var/log/ellul-enforcer.log"
NEW_TIER="$1"

log() { echo "[$(date -Iseconds)] TIER_HELPER: $1" >> "$LOG_FILE"; }

if [ -z "$NEW_TIER" ]; then
  echo "Usage: tier-switch.sh <standard|web_locked|private_locked>"
  exit 1
fi

# Validate tier value
if [ "$NEW_TIER" != "standard" ] && [ "$NEW_TIER" != "web_locked" ] && [ "$NEW_TIER" != "private_locked" ]; then
  echo "ERROR: Invalid tier '$NEW_TIER'"
  echo "Valid tiers: standard, web_locked, private_locked"
  exit 1
fi

CURRENT_TIER=$(cat "$TIER_FILE" 2>/dev/null || echo "unknown")
log "Switching tier: $CURRENT_TIER -> $NEW_TIER"

# Write atomically
echo "$NEW_TIER" > "$TIER_FILE.tmp"
chmod 644 "$TIER_FILE.tmp"
mv "$TIER_FILE.tmp" "$TIER_FILE"

# Verify write succeeded
WRITTEN_TIER=$(cat "$TIER_FILE" 2>/dev/null || echo "failed")
if [ "$WRITTEN_TIER" != "$NEW_TIER" ]; then
  log "ERROR: Tier file write verification failed (expected: $NEW_TIER, got: $WRITTEN_TIER)"
  echo "ERROR: Failed to write tier file"
  exit 1
fi

log "Tier file updated successfully"

# Restart services based on new tier
systemctl restart ellul-enforcer 2>/dev/null || {
  log "WARNING: Failed to restart enforcer"
}

log "Tier switch complete: $NEW_TIER"
echo "Tier switched to: $NEW_TIER"
`;
}

/**
 * Generate the SSH setup script.
 */
export function getSshSetupScript(): string {
  return `#!/bin/bash
set -e

[ -f /etc/default/ellul ] && source /etc/default/ellul
SVC_USER="\${PS_USER:-dev}"
SVC_HOME="/home/\${SVC_USER}"
SSH_DIR="\${SVC_HOME}/.ssh"
AUTH_KEYS="$SSH_DIR/authorized_keys"

mkdir -p "$SSH_DIR"
chmod 700 "$SSH_DIR"
touch "$AUTH_KEYS"
chmod 600 "$AUTH_KEYS"
chown -R \${SVC_USER}:\${SVC_USER} "$SSH_DIR"
`;
}

export { getSovereignShieldScript as getVpsAuthScript };
export { getSovereignShieldService as getVpsAuthService };
export { getSovereignShieldPrereqService as getVpsAuthPrereqService };
// getLuksBootService, getLuksBootScript, getLuksUnlockScript are already
// exported inline via `export function` — no re-export needed.
