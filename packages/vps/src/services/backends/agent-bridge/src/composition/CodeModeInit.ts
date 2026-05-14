// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// Code-mode execution layer setup. Ellul-only — parallel to the MCP gateway.
// Rewired for the orchestration-owned gate flow: approval callback POSTs to
// our own /api/internal/gate-request route, which now dispatches
// thread.activity.append + optional continuation turn.

import { isSandboxId } from "@ellul.ai/types";

import { PORT } from "../config";
import {
  CodeModeObservability,
  CodeModeService,
  ExecutionLifecycle,
  ExecutionRuntime,
  registerBuiltinTools,
  registerPlatformTools,
  ToolExecutor,
  ToolRegistry,
  ToolResolver,
} from "../application/code-mode";
import { mcpGateway } from "../application/mcp-tool/governance/McpGateway";
import { readServiceTokens } from "../internal-http/acl";

let codeModeRegistry: ToolRegistry | null = null;

export function getCodeModeRegistry(): ToolRegistry | null {
  return codeModeRegistry;
}

export function initCodeMode(): void {
  try {
    const registry = new ToolRegistry();
    registry.sync(mcpGateway.getAllGovernedTools());
    codeModeRegistry = registry;

    const resolver = new ToolResolver(registry, mcpGateway);
    const executor = new ToolExecutor(mcpGateway);
    const lifecycle = new ExecutionLifecycle();
    const emitter = new CodeModeObservability();
    const runtime = new ExecutionRuntime();

    emitter.on("tool.started", (e) =>
      console.log(
        `[CodeMode] tool.started: ${e.tool} #${e.sequenceNumber} (exec: ${e.executionId.slice(0, 8)})`,
      ),
    );
    emitter.on("tool.finished", (e) =>
      console.log(
        `[CodeMode] tool.finished: ${e.tool} ${e.state} ${e.durationMs}ms (idemp: ${e.idempotencyKey.slice(0, 12)})`,
      ),
    );
    emitter.on("tool.failed", (e) =>
      console.error(
        `[CodeMode] tool.failed: ${e.tool} ${e.state} ${e.error} (idemp: ${e.idempotencyKey.slice(0, 12)})`,
      ),
    );

    const service = new CodeModeService(runtime, resolver, executor, lifecycle, emitter);
    registerBuiltinTools(mcpGateway, service);
    registerPlatformTools(mcpGateway);

    mcpGateway.setOnApprovalRequired((gate, threadId, reason, toolName, rawSandboxId) => {
      const sandboxId = rawSandboxId && isSandboxId(rawSandboxId) ? rawSandboxId : null;
      const selfToken = readServiceTokens().get("agent-bridge");
      if (!selfToken) {
        return;
      }
      fetch(`http://127.0.0.1:${PORT}/api/internal/gate-request`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-token": selfToken,
        },
        body: JSON.stringify({ gate, threadId, reason, sandboxId }),
      }).catch(() => {});
    });

    setInterval(() => lifecycle.cleanup(), 300_000).unref?.();

    console.log(`[Bridge] Code-mode initialized (${registry.size} tools registered)`);
  } catch (err) {
    console.error("[Bridge] Code-mode initialization failed:", (err as Error).message);
  }
}
