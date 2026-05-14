// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

export function getPgBackupService(): string {
  return `[Unit]
Description=ellul PostgreSQL Daily Backup
After=postgresql.service
Requires=postgresql.service

[Service]
Type=oneshot
User=root
ExecStart=/usr/local/bin/ellul-pg-backup
LimitCORE=0
PrivateTmp=true
`;
}

export function getPgBackupTimer(): string {
  return `[Unit]
Description=ellul PostgreSQL Daily Backup Timer

[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true
RandomizedDelaySec=900

[Install]
WantedBy=timers.target
`;
}

export function getPgRecoverySystemdDropin(): string {
  return `[Unit]
# Wait for vault bind mounts before starting PostgreSQL.
# Without this, PG may start against an empty /var/lib/postgresql before
# the vault bind mount is applied, then fail when the mount appears.
After=local-fs.target
RequiresMountsFor=/var/lib/postgresql /etc/ellul

[Service]
# Run WAL recovery before every start attempt.
# The script handles its own locking (flock), attempt counting, and
# escalation from pg_resetwal through to full re-init as last resort.
ExecStartPre=/usr/local/bin/ellul-pg-recovery

# Allow recovery script up to 60s (default ExecStartPre timeout is 90s).
# pg_resetwal is fast, but emergency WAL cleanup + chown can be slow on
# large data directories.
TimeoutStartSec=120

# OOM protection: keep PostgreSQL alive under memory pressure.
# -900 = almost unkillable (only -1000 is fully exempt).
OOMScoreAdjust=-900

# Auto-restart on failure with backoff.
# Combined with the recovery script's ExecStartPre, this means:
# crash → systemd waits RestartSec → runs recovery script → starts PG.
Restart=on-failure
RestartSec=5s

# Prevent rapid restart storms from overwhelming the system.
# 5 restarts within 120s = systemd stops trying, enforcer takes over.
StartLimitBurst=5
StartLimitIntervalSec=120
`;
}
