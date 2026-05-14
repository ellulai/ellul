// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Sudo wrapper for preview systemd control.
 *
 * Generates `/usr/local/bin/ellul-preview-ctl`. file-api runs as the
 * service user with no general sudo access — it calls this wrapper via
 * a scoped sudoers entry (see `configs/system/sudoers-preview-units.ts`)
 * to start/stop/restart the per-preview systemd units.
 *
 * The bash source is kept under `@vps/shell/workflow/preview/` and inlined
 * at build time, so shellcheck can lint it and backslash-heavy patterns
 * (the systemd-escape character class regex) aren't mangled by JS template
 * literal escaping.
 *
 * Same defense pattern as `shield-git-wrapper` / `shield-pg-wrapper`:
 *   - Immutable wrapper (chattr +i) with hardcoded systemctl path.
 *   - Whitelist of accepted actions (no arbitrary systemctl subcommands).
 *   - Regex-validated instance name (systemd-escape's output is a
 *     strict character class — anything outside it is either a malformed
 *     call or a path-injection attempt).
 *
 * The agent (service user) cannot exec systemctl directly and cannot
 * edit the wrapper — privilege escalation beyond the allowed actions
 * on the allowed unit class is closed by construction.
 */

import previewCtlScript from '@vps/shell/workflow/preview/preview-ctl.sh';

export function getPreviewCtlScript(): string {
  return previewCtlScript;
}
