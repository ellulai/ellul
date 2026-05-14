// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

/**
 * Public surface — what shield's main.ts and routes/index.ts import.
 *
 * Everything else inside `credentials/claude-oat/` is module-internal.
 * Refactors below this line are non-breaking as long as this barrel is
 * stable.
 */

export {
  buildClaudeOatPorts,
  buildClaudeOatModule,
  type ClaudeOatModule,
  type ClaudeOatModuleConfig,
} from "./bootstrap";
export { registerClaudeOatRoutes } from "./interface/http/claude-oat.routes";
export { ProbeLoop } from "./interface/probe/probe-loop";
export { HttpAnthropicProbeClient } from "./interface/probe/anthropic-probe.client";
export { ClaudeOatError } from "./domain/errors";
