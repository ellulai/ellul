// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import content from '@vps/shell/sessions/pty-wrap.sh';

/**
 * PTY Wrap Script
 *
 * Simple wrapper that runs commands in a pseudo-terminal using the `script` utility.
 * Required for interactive CLI tools (claude login, codex login, cursor-agent login, etc.) that need
 * proper terminal emulation when spawned from agent-bridge.
 */

/**
 * Get the pty-wrap script content.
 * Uses the Unix `script` command to provide PTY wrapping.
 */
export function getPtyWrapScript(): string {
  return content;
}
