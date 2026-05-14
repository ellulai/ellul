// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * PostgreSQL failure detection and pre-recovery fixes.
 *
 * Handles:
 *   - PG version detection + guard clauses (first boot, postgres user)
 *   - F4: Stale postmaster.pid removal
 *   - F5: Ownership drift after vault wake (chown -R)
 *   - F6: Missing pg_wal directory recreation
 *   - F8: Emergency disk-space cleanup before resetwal
 */

import content from '@vps/shell/helpers/pg-recovery/failure-detection.sh';

export function failureDetectionBlock(): string {
  return content;
}
