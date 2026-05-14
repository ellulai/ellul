// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import content from '@vps/shell/helpers/agent-namespace/ns-shell.sh';

/**
 * NS Shell wrapper script deployed to /usr/local/bin/ellul-ns-shell.
 *
 * ZeroClaw's exec tool calls: $SHELL -c "command"
 * Per-project daemons run inside namespaces with SHELL=/usr/local/bin/ellul-ns-shell,
 * ensuring every exec call is routed through namespace isolation.
 *
 * Flow: ZeroClaw -> $SHELL -c "cmd" -> derive project from $PWD -> nsenter -> bash
 */
export function getNsShellScript(): string {
  return content;
}
