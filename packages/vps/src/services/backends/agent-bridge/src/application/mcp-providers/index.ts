// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// MCP Provider public API — register all platform MCP providers and
// re-export the registry + provider identifiers for consumers.
//
// Adding a new MCP provider:
//   1. Create a directory under mcp-providers/<name>/ with manifest,
//      scrubber (optional), provider, and index.
//   2. Import and register it below.

import { mcpProviderRegistry } from './registry';
import { gbrainProvider } from './gbrain';

// ── Register all providers ──
mcpProviderRegistry.register(gbrainProvider);

// ── Public API ──
export { mcpProviderRegistry } from './registry';
export { GBRAIN_CONNECTION_ID } from './gbrain';
export type { McpProviderDefinition, McpProviderScrubber } from './types';
