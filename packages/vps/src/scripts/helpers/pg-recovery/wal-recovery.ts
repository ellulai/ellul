// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * PostgreSQL WAL recovery logic.
 *
 * Handles:
 *   - F1-F3: pg_resetwal with escalation (attempts 1-3)
 *   - F7:    Corrupted/missing pg_control (empty state triggers recovery)
 *   - F10:   Attempt tracking, escalation ladder, and give-up logic
 *   - Recovery functions: run_resetwal, run_resetwal_aggressive, run_reinit
 *   - Decision logic: state-based routing into escalation ladder
 */

import content from '@vps/shell/helpers/pg-recovery/wal-recovery.sh';

export function walRecoveryBlock(): string {
  return content;
}
