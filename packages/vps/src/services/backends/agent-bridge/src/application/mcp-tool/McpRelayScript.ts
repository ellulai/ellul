// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * MCP Relay Script
 *
 * Returns the Node.js stdio-to-HTTP relay source. The bytes ship as
 * mcp-relay.js inside the core-runtime tarball alongside file-api.js
 * and agent-bridge.js — the enforcer's ensure_bin_symlink creates
 * /usr/local/bin/ellul-mcp-relay pointing at the release copy with
 * the same atomic-swap discipline as every other core-runtime service.
 *
 * The source file on disk is named `mcp-relay.sh` for legacy reasons
 * (it's a pure Node.js program; the extension is a build-tool quirk).
 * It's inlined into the bundle at build time via the `.sh → text`
 * loader in tsup.config.ts, matching every other shell asset in this
 * package. No runtime fs reads — the bytes travel with whichever
 * dist/chunk-*.js consumer ends up importing this module.
 *
 * Spawned by OpenCode, Claude Code, and Codex inside project
 * namespaces via their per-CLI MCP config files.
 */

import relaySource from '@vps/shell/helpers/mcp-relay.sh';

/**
 * Returns the complete relay script as a string, ready to be written
 * to disk or embedded in a tarball. Shipped in core-runtime.tar.gz and
 * symlinked by the enforcer at /usr/local/bin/ellul-mcp-relay
 * (mode 0755 root:root).
 */
export function getMcpRelayScript(): string {
  return relaySource;
}
