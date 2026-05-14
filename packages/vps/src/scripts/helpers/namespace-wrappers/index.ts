// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import claudeNsScript from "@vps/shell/helpers/namespace-wrappers/claude-ns.sh";
import codexNsScript from "@vps/shell/helpers/namespace-wrappers/codex-ns.sh";

export function getClaudeNsScript(): string {
  return claudeNsScript;
}

export function getCodexNsScript(): string {
  return codexNsScript;
}
