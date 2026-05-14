// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * rebuild-all.ts -- Regenerate ALL deployed files from source.
 *
 * Standalone entry point: bundled with esbuild during updates, then run as:
 *   node /tmp/ellul-rebuild-all.js
 *
 * Reads config from /etc/ellul/ and writes every script, config,
 * service file, and Node.js bundle to their deploy locations.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';


import { readConfig } from './config';
import { buildManifest } from './manifest';
import { writeFileAtomic } from './file-writer';
import { rebuildNodeServices } from './service-builder';

// ─── Symlinks ───────────────────────────────────────────────────────

function recreateSymlinks(svcUser: string): void {
  const links: [string, string][] = [
    ['/usr/local/bin/ellul-ai-flow', '/usr/local/bin/ship'],
    ['/usr/local/bin/ellul-git-flow', '/usr/local/bin/save'],
    ['/usr/local/bin/ellul-git-flow', '/usr/local/bin/branch'],
    ['/usr/local/bin/ellul-git-flow', '/usr/local/bin/git-flow'],
    ['/usr/local/bin/ellul-git', '/usr/local/bin/git'],
  ];
  for (const [target, link] of links) {
    try { fs.unlinkSync(link); } catch {}
    try { fs.symlinkSync(target, link); } catch {}
  }

  // Create/refresh ~/.node symlink → actual NVM node version (CPU-agnostic)
  const svcHome = `/home/${svcUser}`;
  const nvmVersionsDir = path.join(svcHome, '.nvm', 'versions', 'node');
  try {
    let nodeVersion = '';
    try {
      nodeVersion = execSync(
        `runuser -l ${svcUser} -c 'node --version' 2>/dev/null`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
    } catch {
      // Fallback: scan NVM versions directory for installed versions
      if (fs.existsSync(nvmVersionsDir)) {
        const versions = fs.readdirSync(nvmVersionsDir).filter(v => v.startsWith('v')).sort();
        if (versions.length > 0) {
          nodeVersion = versions[versions.length - 1]!;
          console.log(`[rebuild-all] node --version failed, detected from filesystem: ${nodeVersion}`);
        }
      }
    }
    if (nodeVersion && nodeVersion.startsWith('v')) {
      const target = path.join(nvmVersionsDir, nodeVersion);
      const link = path.join(svcHome, '.node');
      if (fs.existsSync(target)) {
        try { fs.unlinkSync(link); } catch {}
        fs.symlinkSync(target, link);
        execSync(`chown -h ${svcUser}:${svcUser} ${JSON.stringify(link)}`, { stdio: 'pipe' });
        console.log(`[rebuild-all] .node symlink: ${link} → ${target}`);
      }
    }
  } catch (err) {
    console.warn(`[rebuild-all] Failed to create .node symlink: ${err}`);
  }
}

// ─── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`[rebuild-all] ellul -- rebuilding all deployed files`);

  // 1. Read config
  const config = readConfig();
  if (!config.apiUrl) {
    console.error('[rebuild-all] FATAL: /etc/ellul/api-url not found');
    process.exit(1);
  }
  console.log(`[rebuild-all] Server: ${config.serverId} Domain: ${config.domain}`);

  // 2. Generate file manifest
  const manifest = await buildManifest(config);
  console.log(`[rebuild-all] Writing ${manifest.length} files...`);

  // 3. Write all files
  let written = 0;
  let failed = 0;
  for (const entry of manifest) {
    try {
      writeFileAtomic(entry);
      written++;
    } catch (err) {
      console.error(`[rebuild-all] FAILED: ${entry.path}: ${err}`);
      failed++;
    }
  }
  console.log(`[rebuild-all] Files: ${written} written, ${failed} failed`);

  // 4. Rebuild Node.js service bundles
  const rebuilt = await rebuildNodeServices(config);
  console.log(`[rebuild-all] Node.js services: ${rebuilt} rebuilt`);

  // 5. Update ZeroClaw binary if installed (pinned version from pinned-versions.ts)
  try {
    const { BINARY_VERSIONS } = await import('../../../pinned-versions');
    const arch = execSync('uname -m', { encoding: 'utf8' }).trim();
    const zcArch = arch === 'aarch64' || arch === 'arm64'
      ? 'aarch64-unknown-linux-musl'
      : 'x86_64-unknown-linux-musl';
    const zcVer = BINARY_VERSIONS.zeroclaw;
    execSync(
      `curl -fsSL "https://github.com/zeroclaw-labs/zeroclaw/releases/download/v${zcVer}/zeroclaw-${zcArch}" -o /usr/local/bin/zeroclaw && chmod +x /usr/local/bin/zeroclaw`,
      { stdio: 'pipe', timeout: 60000 }
    );
    console.log(`[rebuild-all] ZeroClaw binary updated to v${zcVer}`);
  } catch {
    console.log('[rebuild-all] ZeroClaw update skipped (download failed or not needed)');
  }

  // 6. Symlinks (including .node → NVM version detection)
  const svcUser = config.billingTier === "free" ? "coder" : "dev";
  recreateSymlinks(svcUser);

  // 7. Security migration -- shield group, ptrace_scope, credential isolation
  try {
    // Create shield group (sovereign-shield gets SupplementaryGroups=shield via systemd)
    execSync('groupadd -f shield 2>/dev/null || true', { stdio: 'pipe' });
    // Restrict node.key so only root + shield group can read (agent cannot decrypt secrets)
    execSync('chgrp shield /etc/ellul-bootstrap/node.key 2>/dev/null || true', { stdio: 'pipe' });
    execSync('chmod 640 /etc/ellul-bootstrap/node.key 2>/dev/null || true', { stdio: 'pipe' });
    // Per-app secrets directory -- SGID ensures new files inherit shield group
    // 2770: group=rwx (shield can read/write), other=none (agent cannot access)
    // Agent reads secret names via agent-bridge API, not direct file access
    execSync('mkdir -p /etc/ellul/secrets && chown root:shield /etc/ellul/secrets && chmod 2770 /etc/ellul/secrets', { stdio: 'pipe' });
    // Enforce ptrace_scope=1 -- blocks cross-process /proc snooping
    execSync("echo 'kernel.yama.ptrace_scope = 1' > /etc/sysctl.d/99-ellul-ptrace.conf 2>/dev/null || true", { stdio: 'pipe' });
    execSync('sysctl -w kernel.yama.ptrace_scope=1 2>/dev/null || true', { stdio: 'pipe' });
    // Remove legacy git-credentials.json (credentials are in sovereign-shield memory only)
    const svcHome = `/home/${svcUser}`;
    try { fs.unlinkSync(`${svcHome}/.ellul/git-credentials.json`); } catch {}
    // Patch sovereign-shield systemd unit to add SupplementaryGroups + LimitCORE
    const shieldUnit = '/etc/systemd/system/ellul-sovereign-shield.service';
    if (fs.existsSync(shieldUnit)) {
      let unit = fs.readFileSync(shieldUnit, 'utf8');
      if (!unit.includes('SupplementaryGroups=shield')) {
        unit = unit.replace('NoNewPrivileges=true', 'NoNewPrivileges=true\nSupplementaryGroups=shield caddy\nLimitCORE=0');
        fs.writeFileSync(shieldUnit, unit);
      } else if (!unit.includes('SupplementaryGroups=shield caddy')) {
        // Already has shield but missing caddy -- update
        unit = unit.replace('SupplementaryGroups=shield', 'SupplementaryGroups=shield caddy');
        fs.writeFileSync(shieldUnit, unit);
      }
    }
    // Patch file-api systemd unit to add SupplementaryGroups=caddy
    const fileApiUnit = '/etc/systemd/system/ellul-file-api.service';
    if (fs.existsSync(fileApiUnit)) {
      let unit = fs.readFileSync(fileApiUnit, 'utf8');
      if (!unit.includes('SupplementaryGroups=caddy')) {
        unit = unit.replace('ProtectSystem=strict', 'ProtectSystem=strict\nSupplementaryGroups=caddy');
        fs.writeFileSync(fileApiUnit, unit);
      }
    }
    console.log('[rebuild-all] Security migration applied (shield group, ptrace_scope, credential isolation)');
  } catch (err) {
    console.warn(`[rebuild-all] Security migration partial: ${err}`);
  }

  // 7b. Caddy deploy gate hardening -- restrict caddy dirs + admin socket
  try {
    // Remove agent user from caddy group (services use SupplementaryGroups instead)
    execSync(`gpasswd -d ${svcUser} caddy 2>/dev/null || true`, { stdio: 'pipe' });
    // Restrict caddy config directories -- only caddy user + caddy group
    execSync('chown caddy:caddy /etc/caddy /etc/caddy/sites-enabled /etc/caddy/app-routes.d 2>/dev/null || true', { stdio: 'pipe' });
    execSync('chmod 2770 /etc/caddy /etc/caddy/sites-enabled /etc/caddy/app-routes.d 2>/dev/null || true', { stdio: 'pipe' });
    // Admin API unix socket directory -- caddy group only
    execSync('mkdir -p /run/caddy && chown caddy:caddy /run/caddy && chmod 2770 /run/caddy', { stdio: 'pipe' });
    // Persist /run/caddy across reboots (tmpfs)
    fs.writeFileSync('/etc/tmpfiles.d/ellul-caddy.conf', 'd /run/caddy 2770 caddy caddy -\n');
    // Caddy creates admin.sock with 0200 (owner-only). Services with
    // SupplementaryGroups=caddy need group-write to connect for reloads.
    execSync('mkdir -p /etc/systemd/system/caddy.service.d', { stdio: 'pipe' });
    fs.writeFileSync('/etc/systemd/system/caddy.service.d/socket-perms.conf',
      '[Unit]\nAfter=local-fs.target\nRequiresMountsFor=/etc/caddy\n\n[Service]\nRuntimeDirectory=caddy\nRuntimeDirectoryMode=2770\nExecStartPost=/bin/chmod 660 /run/caddy/admin.sock\n');
    console.log('[rebuild-all] Caddy deploy gate hardening applied (dirs restricted, admin socket dir created, socket-perms override)');
  } catch (err) {
    console.warn(`[rebuild-all] Caddy hardening partial: ${err}`);
  }

  // 7c. Phase 9: Runtime isolation -- core dump prevention + protected log dir
  try {
    // Core dump prevention: redirect to shielded directory
    execSync('mkdir -p /etc/ellul/coredumps && chown root:shield-runner /etc/ellul/coredumps && chmod 2770 /etc/ellul/coredumps', { stdio: 'pipe' });
    execSync("echo '/etc/ellul/coredumps/core.%e.%p' > /proc/sys/kernel/core_pattern 2>/dev/null || true", { stdio: 'pipe' });
    execSync("echo 'kernel.core_pattern = /etc/ellul/coredumps/core.%e.%p' > /etc/sysctl.d/99-ellul-coredump.conf", { stdio: 'pipe' });
    // Protected app log directory -- all PM2 processes log here
    execSync('mkdir -p /var/log/ellul/apps && chown root:shield /var/log/ellul/apps && chmod 2770 /var/log/ellul/apps', { stdio: 'pipe' });
    console.log('[rebuild-all] Phase 9 runtime isolation applied (core dump prevention, protected log dir)');
  } catch (err) {
    console.warn(`[rebuild-all] Phase 9 migration partial: ${err}`);
  }

  // 8. Retire the old ellul-preview singleton daemon BEFORE reloading. The
  // new model runs one systemd unit per active preview (ellul-preview@*.service)
  // under the shared ellul-user-workload-previews.slice cgroup (renamed from
  // ellul-previews.slice in resource-v2 to be re-parented under
  // ellul-user-workload.slice). Anything still using the old singleton unit
  // would fight for ports with the new per-preview units.
  try {
    execSync('systemctl disable --now ellul-preview.service 2>/dev/null || true', { stdio: 'pipe' });
    // The previous deployment shipped a service file at this path; remove it
    // so a future `systemctl start ellul-preview` doesn't accidentally
    // resurrect the retired daemon.
    execSync('rm -f /etc/systemd/system/ellul-preview.service', { stdio: 'pipe' });
    // The old singleton binary. Its replacement is /usr/local/bin/ellul-preview-instance
    // which is invoked only by the template unit, never directly.
    execSync('rm -f /usr/local/bin/ellul-preview', { stdio: 'pipe' });
    console.log('[rebuild-all] retired old ellul-preview singleton');
  } catch (err) {
    console.warn(`[rebuild-all] ellul-preview retire partial: ${err}`);
  }

  // 8b. v2 cgroup migration: stop active previews briefly so they pick up
  // the renamed slice (ellul-previews.slice → ellul-user-workload-previews.slice).
  // The reconciler at next tick re-starts each preview under the new slice.
  // The visibility-driven preview keepalive client suppresses the gap from
  // backgrounded tabs; foregrounded previews see ~10s of "Restarting after upgrade".
  try {
    execSync("systemctl stop 'ellul-preview@*.service' 2>/dev/null || true", { stdio: 'pipe' });
    execSync('rm -f /etc/systemd/system/ellul-previews.slice', { stdio: 'pipe' });
    console.log('[rebuild-all] v2: stopped previews and removed legacy ellul-previews.slice');
  } catch (err) {
    console.warn(`[rebuild-all] v2 preview slice rename partial: ${err}`);
  }

  // 8c. v2 spawn-scope assertion. Bridge unit has ExecStartPre=test -x
  // /usr/local/bin/ellul-spawn-scope; if the binary isn't present at restart
  // time the bridge fails to start. The manifest writes spawn-scope BEFORE
  // the bridge service file (manifest.ts ordering is load-bearing), but a
  // post-write disk failure or partial deploy could leave the binary missing.
  // Hard-fail rebuild-all here so the operator sees the brick risk before
  // systemd does.
  try {
    fs.accessSync('/usr/local/bin/ellul-spawn-scope', fs.constants.X_OK);
    console.log('[rebuild-all] v2: ellul-spawn-scope present and executable');
  } catch {
    console.error('[rebuild-all] FATAL: /usr/local/bin/ellul-spawn-scope missing or not executable. Bridge will refuse to start. Re-run rebuild-all OR remove ExecStartPre check from agent-bridge unit.');
    process.exit(1);
  }

  // 8d. V8 JIT probe cache isolation — probe units (codex app-server, etc.)
  // create ~4.5MB .so files per spawn. Without isolation these accumulate in
  // /tmp and fill the root FS within days. spawn-scope now redirects TMPDIR
  // to /tmp/ellul-probe-cache; this tmpfiles.d rule cleans contents > 10 min.
  try {
    fs.writeFileSync(
      '/etc/tmpfiles.d/ellul-probe-cache.conf',
      'D /tmp/ellul-probe-cache 0700 root root 10m\n',
    );
    execSync('systemd-tmpfiles --create /etc/tmpfiles.d/ellul-probe-cache.conf 2>/dev/null || true', { stdio: 'pipe' });
    console.log('[rebuild-all] v2: probe cache tmpfiles.d rule installed');
  } catch (err) {
    console.warn(`[rebuild-all] probe cache tmpfiles.d partial: ${err}`);
  }

  // 9. Immutable wrapper — the preview control path runs via sudo. Making
  // the wrapper immutable closes an otherwise-possible tampering vector
  // where root-equivalent mistakes could rewrite it.
  try {
    execSync('chattr +i /usr/local/bin/ellul-preview-ctl 2>/dev/null || true', { stdio: 'pipe' });
  } catch {}

  // 10. Reload systemd to pick up service file changes (including the new
  //     template unit + slice) AND reset-failed any leftover ghost units.
  //     file-api's unit adds the systemd-journal supplementary group so
  //     /api/preview/health can tail journalctl — apply by restarting.
  try {
    execSync('systemctl daemon-reload', { stdio: 'pipe' });
    execSync('systemctl reset-failed "ellul-preview@*.service" 2>/dev/null || true', { stdio: 'pipe' });
    execSync('systemctl try-restart ellul-file-api.service 2>/dev/null || true', { stdio: 'pipe' });
    // Boot-durable reconciler safety-net: enable the timer so it fires
    // every 5 min across reboots. `--now` also starts it in the
    // current boot without requiring a second reboot.
    execSync('systemctl enable --now ellul-preview-reconciler.timer 2>/dev/null || true', { stdio: 'pipe' });
    console.log('[rebuild-all] systemd daemon-reload done');
  } catch {}

  // 9. Reload SSH and fail2ban if configs changed
  try { execSync('systemctl reload sshd 2>/dev/null || true', { stdio: 'pipe' }); } catch {}
  try { execSync('systemctl restart fail2ban 2>/dev/null || true', { stdio: 'pipe' }); } catch {}

  // 10. PostgreSQL hardening -- backup timer, backup dir, crash-safety config
  try {
    // Ensure backup directory exists with correct permissions
    execSync('mkdir -p /var/backups/ellul/postgres && chown root:shield /var/backups/ellul/postgres 2>/dev/null && chmod 2770 /var/backups/ellul/postgres', { stdio: 'pipe' });
    // Ensure recovery state directory exists (persistent attempt tracking)
    execSync('mkdir -p /var/lib/ellul-pg-recovery && chmod 700 /var/lib/ellul-pg-recovery', { stdio: 'pipe' });
    // Enable and start backup timer
    execSync('systemctl enable ellul-pg-backup.timer 2>/dev/null || true', { stdio: 'pipe' });
    execSync('systemctl start ellul-pg-backup.timer 2>/dev/null || true', { stdio: 'pipe' });
    // Apply crash-safety settings to every PostgreSQL version present. The
    // previous `.sort().pop()` picked only the highest version, which would
    // miss any non-default parallel installs. Iterating every numeric dir is
    // safer and handles multi-version upgrades in place.
    try {
      const pgVersionDirs = fs.readdirSync('/etc/postgresql')
        .filter((d) => /^\d+(?:\.\d+)?$/.test(d));
      for (const pgVersionDir of pgVersionDirs) {
        const pgConf = `/etc/postgresql/${pgVersionDir}/main/postgresql.conf`;
        if (fs.existsSync(pgConf)) {
          execSync(`sed -i "s/^#*fsync.*/fsync = on/" ${pgConf}`, { stdio: 'pipe' });
          execSync(`sed -i "s/^#*full_page_writes.*/full_page_writes = on/" ${pgConf}`, { stdio: 'pipe' });
          execSync(`sed -i "s/^#*wal_level.*/wal_level = replica/" ${pgConf}`, { stdio: 'pipe' });
          execSync(`sed -i "s/^#*synchronous_commit.*/synchronous_commit = on/" ${pgConf}`, { stdio: 'pipe' });
        }
      }
    } catch {}
    console.log('[rebuild-all] PostgreSQL hardening applied (backup timer, crash-safety settings)');
  } catch (err) {
    console.warn(`[rebuild-all] PostgreSQL hardening partial: ${err}`);
  }

  // 11. Shield-runner sudoers -- ensure pg-ensure + ssh-key-mgr entries exist
  try {
    const sudoersFile = '/etc/sudoers.d/shield-runner';
    if (fs.existsSync(sudoersFile)) {
      let sudoers = fs.readFileSync(sudoersFile, 'utf8');
      let changed = false;
      if (!sudoers.includes('shield-pg-ensure')) {
        sudoers = sudoers.trimEnd() + '\n# PG auto-recovery: shield can trigger recovery when user requests DB operation\nshield-runner ALL=(root) NOPASSWD: /usr/local/bin/shield-pg-ensure\n';
        changed = true;
      }
      if (!sudoers.includes('shield-ssh-key-mgr')) {
        sudoers = sudoers.trimEnd() + '\n# SSH key management: shield writes/reads authorized_keys via root wrapper\nshield-runner ALL=(root) NOPASSWD: /usr/local/bin/shield-ssh-key-mgr\n';
        changed = true;
      }
      if (changed) {
        fs.writeFileSync(sudoersFile, sudoers);
        execSync(`chmod 440 ${sudoersFile} && chown root:root ${sudoersFile}`, { stdio: 'pipe' });
        execSync(`visudo -cf ${sudoersFile}`, { stdio: 'pipe' });
        console.log('[rebuild-all] Shield-runner sudoers updated (pg-ensure + ssh-key-mgr entries reconciled)');
      }
    }
  } catch (err) {
    console.warn(`[rebuild-all] Shield-runner sudoers update partial: ${err}`);
  }

  console.log(`[rebuild-all] Complete. ${written + rebuilt} total files updated.`);
}

main().catch((err) => {
  console.error(`[rebuild-all] FATAL: ${err}`);
  process.exit(1);
});
