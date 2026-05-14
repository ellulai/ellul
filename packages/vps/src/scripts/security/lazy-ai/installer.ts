// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Lazy AI installer - installs AI tools in the background after provisioning.
 * On snapshot boot, tools are already pre-installed — this only installs missing ones.
 *
 * Uses pinned versions from pinned-versions.ts (single source of truth).
 */

import content from '@vps/shell/security/lazy-ai/installer.sh';
import { NPM_AI_TOOLS } from '../../../pinned-versions';

export function getLazyAiInstallerScript(): string {
  return content
    .split('__NPM_CLAUDE_CODE__').join(NPM_AI_TOOLS[0])
    .split('__NPM_CODEX__').join(NPM_AI_TOOLS[1]);
}
