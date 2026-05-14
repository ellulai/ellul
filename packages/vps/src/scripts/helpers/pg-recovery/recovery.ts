// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * PostgreSQL WAL Recovery Script -- Production Grade
 *
 * Deployed to /usr/local/bin/ellul-pg-recovery (mode 0700, root-only).
 * Invoked from two paths:
 *   1. ExecStartPre -- systemd runs this BEFORE pg_ctlcluster start
 *   2. Enforcer     -- called at runtime when pg_isready fails
 *
 * ──────────────────────────────────────────────────────────────────
 * FAILURE MODES HANDLED
 * ──────────────────────────────────────────────────────────────────
 *
 *  F1  WAL corruption (invalid checkpoint record)
 *      Root cause: VPS force-stopped mid-write, WAL segment has zeroed tail
 *      Symptom:    PANIC: could not locate a valid checkpoint record
 *      Fix:        pg_resetwal -f  (resets WAL, discards uncommitted txns)
 *
 *  F2  Unclean shutdown (state "in production")
 *      Root cause: kill -9, OOM, power loss
 *      Symptom:    pg_controldata shows non-"shut down" state
 *      Fix:        pg_resetwal -f  (safe -- uncommitted data already lost)
 *
 *  F3  pg_resetwal already ran but PG still fails (state looks "shut down")
 *      Root cause: pg_resetwal sets state to "shut down" but WAL checkpoint
 *                  offset still points at corrupt data. Next startup PANICs.
 *      Symptom:    Repeated ExecStartPre calls within seconds
 *      Fix:        Persistent retry counter -- force pg_resetwal again
 *
 *  F4  Stale postmaster.pid
 *      Root cause: PG process killed without cleanup
 *      Symptom:    "lock file postmaster.pid already exists"
 *      Fix:        Remove stale PID file if no matching process exists
 *
 *  F5  Ownership drift after vault wake
 *      Root cause: UID/GID map not restored before bind mount
 *      Symptom:    FATAL: data directory has wrong ownership
 *      Fix:        chown -R postgres:postgres (idempotent)
 *
 *  F6  Missing pg_wal directory or WAL segment files
 *      Root cause: Incomplete vault copy, disk corruption
 *      Symptom:    FATAL: could not open directory "pg_wal"
 *      Fix:        Re-create pg_wal dir with correct ownership
 *
 *  F7  pg_control file corrupted/missing
 *      Root cause: Disk corruption, incomplete write
 *      Symptom:    pg_controldata exits non-zero, empty state
 *      Fix:        pg_resetwal -f can reconstruct from WAL. If that also
 *                  fails, last resort: re-initialize cluster.
 *
 *  F8  Disk full -- pg_resetwal can't write new WAL segment
 *      Root cause: App filled disk, WAL accumulated
 *      Symptom:    pg_resetwal fails with ENOSPC
 *      Fix:        Emergency WAL cleanup before resetwal attempt
 *
 *  F9  Concurrent execution (enforcer + systemd both call script)
 *      Root cause: Race between ExecStartPre and enforcer heartbeat
 *      Symptom:    Two pg_resetwal runs collide, partial writes
 *      Fix:        flock-based mutual exclusion
 *
 *  F10 Infinite recovery loop
 *      Root cause: Unrecoverable corruption (bad base tables, not just WAL)
 *      Symptom:    Recovery script called 5+ times in 5 minutes
 *      Fix:        Max attempt counter with escalation:
 *                  attempts 1-3: pg_resetwal
 *                  attempt  4:   pg_resetwal + remove all WAL segments
 *                  attempt  5:   re-initialize cluster (last resort, data loss)
 *                  attempt  6+:  give up, log FATAL, exit 0 to avoid blocking
 *
 * ──────────────────────────────────────────────────────────────────
 * WHY NOT USE pg_resetwal -n (dry-run) FOR DETECTION?
 * ──────────────────────────────────────────────────────────────────
 *   pg_resetwal -n reads the pg_control file, NOT the WAL segments.
 *   It can report "no issues" even when the WAL checkpoint record is
 *   invalid -- the corruption only surfaces when PostgreSQL's startup
 *   process tries to read the actual checkpoint from the WAL file.
 *   This was the root cause of the original bug: the grep on dry-run
 *   output never matched, pg_resetwal -f never ran, PG stayed broken.
 *
 * ──────────────────────────────────────────────────────────────────
 * SAFETY GUARANTEES
 * ──────────────────────────────────────────────────────────────────
 *   - pg_resetwal -f preserves ALL committed data on disk
 *   - Only uncommitted (in-flight) transactions are discarded
 *   - For VPS force-stop scenarios, these transactions were lost anyway
 *   - flock prevents concurrent corruption from parallel invocations
 *   - Re-init is absolute last resort (attempt 5+) with backup attempt
 */

import skeleton from '@vps/templates/helpers/pg-recovery/recovery.sh';
import { failureDetectionBlock } from './failure-detection';
import { walRecoveryBlock } from './wal-recovery';

export function getPgRecoveryScript(): string {
  return skeleton
    .replace('__FAILURE_DETECTION__', () => failureDetectionBlock())
    .replace('__WAL_RECOVERY__', () => walRecoveryBlock());
}
