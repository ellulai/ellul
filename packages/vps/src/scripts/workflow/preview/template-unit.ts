// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Per-preview systemd template unit.
 *
 * Generates `/etc/systemd/system/ellul-preview@.service`. One instance per
 * active preview, named after the systemd-escaped app directory (so
 * `sbx-xyz/workspace/apps/api` → `ellul-preview@sbx\x2dxyz-workspace-apps-api.service`).
 *
 * The unit body lives at `@vps/shell/workflow/preview/template-unit.service`
 * and is inlined at build time. Only the service user varies (dev vs
 * coder), so we use a `@@SVC_USER@@` placeholder that is substituted at
 * render time — keeping the .service file a valid systemd unit that
 * tooling (systemd-analyze, editors with ini highlighting) can read
 * directly.
 *
 * The template is intentionally minimal: restart policy, memory cap, OOM
 * score, cgroup slice, hardening. Per-preview tweaks (if ever needed for a
 * heavy framework) land as drop-ins at
 * `/etc/systemd/system/ellul-preview@<instance>.service.d/`. The default
 * caps hold for every framework we support today.
 */

import templateUnit from '@vps/shell/workflow/preview/template-unit.service';

export function getPreviewTemplateUnit(svcUser: string = 'dev'): string {
  return templateUnit.replaceAll('@@SVC_USER@@', svcUser);
}
