// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// MCP Provider type system — mirrors the chat adapter pattern
// (adapters/registry.ts + ProviderAdapterShape) for tool providers.
//
// Each platform-installed MCP service implements McpProviderDefinition.
// The registry holds all providers; the gateway stays provider-agnostic.

import type { ToolManifestEntry } from '../mcp-tool/governance/Types';

// ── Scrub Middleware ──

export interface McpProviderScrubber {
  /** Tool names that require scrubbing before forwarding to the provider. */
  readonly writeTools: ReadonlySet<string>;
  /** Scrub secret material from tool arguments. Throws on failure (fail-closed). */
  scrubArgs(args: Record<string, unknown>): Record<string, unknown>;
}

// ── Provider Definition ──

export interface McpProviderDefinition {
  /** Unique connection ID in the MCP gateway (e.g., '__gbrain__'). */
  readonly id: string;
  /** Provider kind identifier (e.g., 'gbrain'). */
  readonly kind: string;
  /** Human-readable display name. */
  readonly name: string;
  /** Explicit capability for each tool — same pattern as PlatformTools.ts buildToolDef.
   *  Declared tools skip the pattern classifier; undeclared tools are quarantined. */
  readonly toolManifest: Readonly<Record<string, ToolManifestEntry>>;
  /** Optional write-path scrub middleware. Attached to the connection config
   *  so the gateway can apply it without provider-specific imports. */
  readonly scrubber?: McpProviderScrubber;

  /** Whether this provider is currently enabled (feature toggle, etc.). */
  isEnabled(): boolean;
  /** Connect to the MCP server via the gateway. Idempotent. */
  connect(): Promise<void>;
  /** Disconnect from the MCP server. Idempotent. */
  disconnect(): void;
}
