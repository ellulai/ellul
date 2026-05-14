// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * The `spawn)` case: one-shot namespace (creates fresh per invocation).
 */

import spawnTemplate from '@vps/templates/helpers/agent-namespace/spawn.sh';
import { rsyncAllowlistNestedShell } from '@vps/services/shared/rsync-allowlist';

export function spawnBlock(): string {
  // Config parsing moved from python3 (shell-side) to TypeScript (bridge-side).
  // The bridge pre-parses JSON configs and passes results as CLI args.
  //
  // SECURITY: substitute the canonical rsync allowlist into the cross-project
  // snapshot block. `__RSYNC_ALLOWLIST__` is the load-bearing placeholder; if
  // substitution ever fails (typo / template drift) the resulting bash will
  // attempt to execute the literal token and rsync will refuse, which fails
  // closed (no snapshot is produced rather than leaking a denylisted file).
  if (!spawnTemplate.includes('__RSYNC_ALLOWLIST__')) {
    throw new Error(
      'spawn.sh template missing __RSYNC_ALLOWLIST__ placeholder — refusing to ship a template that may use a stale denylist',
    );
  }
  return spawnTemplate.replace('__RSYNC_ALLOWLIST__', rsyncAllowlistNestedShell());
}
