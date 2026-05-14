// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import content from '@vps/shell/helpers/system/opencode-exec.sh';

/**
 * TMPDIR-isolated wrapper for the opencode binary. Installed at
 * /usr/local/bin/ellul-opencode-exec by provisioning. Every opencode
 * invocation on the box (bridge serve, one-shot CLIs in ai-flow / inspect)
 * goes through this wrapper so bun's per-process dylib leak is contained
 * to a wrapper-private TMPDIR that's removed on exit.
 */
export function getOpencodeExecScript(): string {
  return content;
}
