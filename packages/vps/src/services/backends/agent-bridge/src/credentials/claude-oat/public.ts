// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

/**
 * Public surface — what bridge's main.ts, adapter.ts, and auth-routes
 * import. Everything else inside `credentials/claude-oat/` is module-
 * internal; refactors below this barrel are non-breaking.
 */

import {
  buildClaudeOatBridgeModule,
  type ClaudeOatBridgeModule,
} from "./bootstrap";

export {
  buildClaudeOatBridgeModule,
  type ClaudeOatBridgeModule,
} from "./bootstrap";
export {
  makeClaudeTokenHandler,
  makeClaudeLogoutHandler,
} from "./interface/http/claude-token.handler";

/**
 * Bridge-process-wide singleton.
 *
 * The bounded context is wired once at startup (in main.ts). Adapter,
 * auth-routes, and internal-http handlers retrieve the same instance via
 * `getClaudeOatBridgeModule()` to avoid prop-drilling through every
 * call site. This is the only mutable module-level state in the bounded
 * context — all use cases are pure functions over the gateway port.
 */
let singleton: ClaudeOatBridgeModule | null = null;

export function getClaudeOatBridgeModule(): ClaudeOatBridgeModule {
  if (!singleton) {
    singleton = buildClaudeOatBridgeModule();
  }
  return singleton;
}

/** @internal — for tests only */
export function __setClaudeOatBridgeModuleForTests(
  module: ClaudeOatBridgeModule | null,
): void {
  singleton = module;
}
