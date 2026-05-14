// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Tool Registry
 *
 * Pure data. Owns tool identity and routing.
 * Identity = (name + connectionId + capability) — prevents:
 *   - MCP namespace collisions
 *   - Ambiguous routing
 *   - Privilege escalation via name reuse
 *
 * Rebuilds on integration reload. No policy logic.
 */

import type { ToolIdentity, GovernedToolDefinition } from './Types';

export class ToolRegistry {
  private tools = new Map<string, ToolIdentity>();

  /**
   * Rebuild the registry from the gateway's governed tools.
   * Only approved + agent-visible tools with a classified capability are registered.
   * Called at startup and on integration reload.
   */
  sync(governedTools: GovernedToolDefinition[]): void {
    this.tools.clear();
    for (const tool of governedTools) {
      if (
        tool.lifecycleStatus === 'approved' &&
        tool.exposureStatus === 'agent_visible' &&
        tool.capability
      ) {
        this.tools.set(tool.name, {
          toolName: tool.name,
          connectionId: tool.provider.providerId,
          capability: tool.capability,
        });
      }
    }
  }

  /** Resolve a tool name to its full identity. Returns null if unknown. */
  resolve(toolName: string): ToolIdentity | null {
    return this.tools.get(toolName) ?? null;
  }

  /** Check if a tool name is registered. */
  has(toolName: string): boolean {
    return this.tools.has(toolName);
  }

  /** Get all registered tool identities. */
  all(): ToolIdentity[] {
    return [...this.tools.values()];
  }

  /** Number of registered tools. */
  get size(): number {
    return this.tools.size;
  }
}
