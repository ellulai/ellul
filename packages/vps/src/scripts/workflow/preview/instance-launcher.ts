// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Per-preview instance launcher.
 *
 * Generates `/usr/local/bin/ellul-preview-instance`, the single entry point
 * invoked by the `ellul-preview@.service` systemd template. The unescaped
 * instance path (app directory relative to ~/projects) is passed as %I.
 *
 * The bash source lives at `@vps/shell/workflow/preview/instance-launcher.sh`
 * and is inlined at build time by the static-text esbuild plugin. Keeping
 * the script in a `.sh` file (rather than a TS template literal) lets
 * shellcheck lint it and removes the escaping hazard that burned us on
 * 2026-04-20 — `\(.key)` in a JS template literal silently drops the
 * backslash, so jq emitted `(.key)=(.value)` and bash died with a syntax
 * error.
 *
 * Responsibilities:
 *  - Load `<app>/.ellul/preview.json` (or fall back to package.json.scripts.dev
 *    with a LOUD warning so the agent knows to commit a real spec).
 *  - Enforce port-conflict guard — refuse to exec if the port is already bound.
 *  - exec the dev command with $PORT / $HOST / NODE_ENV=development in the env.
 *
 * systemd owns everything else: restart policy, memory cap, OOM score, logging,
 * start-limit, cleanup on stop.
 *
 * NOT responsible for: framework detection, runtime install, build steps,
 * fixers, host-auth patching, caddy wiring, health checks. Each of those is
 * either handled elsewhere (caddy by file-api, openapi by probe) or
 * intentionally out-of-scope (fixers — agent owns code quality).
 */

import launcherScript from '@vps/shell/workflow/preview/instance-launcher.sh';

export function getPreviewInstanceLauncher(): string {
  return launcherScript;
}
