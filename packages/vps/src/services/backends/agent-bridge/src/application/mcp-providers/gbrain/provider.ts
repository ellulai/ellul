// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// gbrain McpProviderDefinition — persistent knowledge layer for AI agents.
//
// Self-contained lifecycle: reads feature toggle + access token from disk,
// builds McpConnectionConfig with explicit toolManifest + scrubber, and
// delegates connect/disconnect to the gateway. The registry drives startup;
// features-routes drives runtime toggling.

import * as fs from 'fs';
import { mcpGateway, type McpConnectionConfig } from '../../mcp-tool/governance/McpGateway';
import { GBRAIN_PORT } from '@vps/shared/ports';
import type { McpProviderDefinition } from '../types';
import { GBRAIN_TOOL_MANIFEST } from './manifest';
import { gbrainScrubber } from './scrubber';

const LOG_PREFIX = '[GbrainProvider]';
const FEATURES_PATH = '/etc/ellul/agent-bridge/features.json';
const TOKEN_PATH = '/etc/ellul/agent-bridge/gbrain-token';

export const GBRAIN_CONNECTION_ID = '__gbrain__';

function readAuthToken(): string | undefined {
  try {
    const token = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

export const gbrainProvider: McpProviderDefinition = {
  id: GBRAIN_CONNECTION_ID,
  kind: 'gbrain',
  name: 'gbrain — Persistent Knowledge Layer',
  toolManifest: GBRAIN_TOOL_MANIFEST,
  scrubber: gbrainScrubber,

  isEnabled(): boolean {
    try {
      const raw = fs.readFileSync(FEATURES_PATH, 'utf8');
      const features = JSON.parse(raw) as { gbrain?: { enabled?: boolean } };
      return features.gbrain?.enabled === true;
    } catch {
      return false;
    }
  },

  async connect(): Promise<void> {
    const status = mcpGateway.getConnectionStatus(GBRAIN_CONNECTION_ID);
    if (status === 'connected') return;

    const authToken = readAuthToken();
    if (!authToken) {
      console.warn(`${LOG_PREFIX} no auth token at ${TOKEN_PATH}, skipping connect`);
      return;
    }

    const config: McpConnectionConfig = {
      connectionId: GBRAIN_CONNECTION_ID,
      url: `http://127.0.0.1:${GBRAIN_PORT}/mcp`,
      transport: 'streamable-http',
      providerKind: 'gbrain',
      authToken,
      toolManifest: GBRAIN_TOOL_MANIFEST,
      scrubber: gbrainScrubber,
    };

    try {
      const result = await mcpGateway.connect(config);
      if (result.errors.length > 0) {
        console.warn(`${LOG_PREFIX} connected with errors: ${result.errors.join(', ')}`);
      } else {
        console.log(`${LOG_PREFIX} connected: ${result.tools.length} tools`);
      }
    } catch (err) {
      console.warn(`${LOG_PREFIX} failed to connect:`, (err as Error).message);
    }
  },

  disconnect(): void {
    if (mcpGateway.getConnectionStatus(GBRAIN_CONNECTION_ID)) {
      mcpGateway.disconnect(GBRAIN_CONNECTION_ID);
      console.log(`${LOG_PREFIX} disconnected`);
    }
  },
};
