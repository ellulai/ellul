// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// gbrain tool manifest — single source of truth for which tools exist
// and what capability each one requires. Same pattern as PlatformTools.ts
// buildToolDef: capabilities are declared, not inferred by the classifier.
//
// Adding a gbrain tool = add a row here. Undeclared tools are quarantined.

import type { ToolManifestEntry } from '../../mcp-tool/governance/Types';

export const GBRAIN_TOOL_MANIFEST: Readonly<Record<string, ToolManifestEntry>> = {
  // Read tools — auto-approved (reading the agent's own knowledge layer)
  search:               { capability: 'database:read',  defaultPermission: 'allow_always' },
  get_page:             { capability: 'database:read',  defaultPermission: 'allow_always' },
  get_links:            { capability: 'database:read',  defaultPermission: 'allow_always' },
  get_backlinks:        { capability: 'database:read',  defaultPermission: 'allow_always' },
  get_timeline_events:  { capability: 'database:read',  defaultPermission: 'allow_always' },
  query:                { capability: 'database:read',  defaultPermission: 'allow_always' },
  think:                { capability: 'database:read',  defaultPermission: 'allow_always' },
  // Write tools — auto-approved (scrubber is the security boundary, not the gate)
  put_page:             { capability: 'database:write', defaultPermission: 'allow_always' },
  sync_brain:           { capability: 'database:write', defaultPermission: 'allow_always' },
  create_take:          { capability: 'database:write', defaultPermission: 'allow_always' },
  put_timeline_event:   { capability: 'database:write', defaultPermission: 'allow_always' },
};
