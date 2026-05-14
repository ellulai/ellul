// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Integration Loader Service
 *
 * Fetches MCP connection configs from the central API and connects them
 * to the MCP gateway. Handles EXTERNAL (user-connected, third-party) MCP
 * integrations only. Platform-local providers (gbrain, etc.) are managed
 * by their own modules under application/.
 *
 * Lifecycle:
 *   1. Startup: loadIntegrations() called after reconcileProjects()
 *   2. Refresh: reloadIntegrations() called when user enables/disables agent exposure
 *   3. Teardown: mcpGateway.disconnectAll() on shutdown
 *
 * Data flow:
 *   API (decrypted tokens) → Bridge (this service) → MCP Gateway → Remote MCP Servers
 *
 * Auth: VPS bearer token (ai-proxy-token) against central API.
 * Follows push-notify.service.ts credential pattern.
 */

import * as fs from 'fs';
import { mcpGateway, type McpConnectionConfig } from './governance/McpGateway';

const LOG_PREFIX = '[IntegrationLoader]';
const SERVER_ID_FILE = '/etc/ellul-bootstrap/server-id';
const API_URL_FILE = '/etc/ellul/api-url';

// ── Server Credentials (cached, same pattern as push-notify) ──

interface ServerCredentials {
  serverId: string;
  apiUrl: string;
  token: string;
}

let _cachedCreds: ServerCredentials | null = null;
let _credsReadAt = 0;
const CREDS_CACHE_MS = 60_000;

function getServerCredentials(): ServerCredentials | null {
  const now = Date.now();
  if (_cachedCreds && now - _credsReadAt < CREDS_CACHE_MS) {
    return _cachedCreds;
  }

  try {
    const serverId = fs.readFileSync(SERVER_ID_FILE, 'utf8').trim();
    const apiUrl = fs.existsSync(API_URL_FILE)
      ? fs.readFileSync(API_URL_FILE, 'utf8').trim()
      : (() => { try { const z = fs.readFileSync('/etc/ellul/platform-zone', 'utf8').trim(); return `https://api.${z}`; } catch { return ''; } })();

    const token = process.env.AI_PROXY_TOKEN?.trim();
    if (!token) return null;

    _cachedCreds = { serverId, apiUrl, token };
    _credsReadAt = now;
    return _cachedCreds;
  } catch {
    return null;
  }
}

// ── API Response Type ──

interface McpConnectionResponse {
  connectionId: string;
  groupId: string;
  providerKind: string;
  url: string;
  transport: 'sse' | 'streamable-http';
  authToken?: string;
  displayName: string;
}

// ── Core Functions ──

/**
 * Fetch MCP connection configs from the central API.
 * Returns decrypted auth tokens (API decrypts before sending).
 */
async function fetchConnectionConfigs(): Promise<McpConnectionResponse[]> {
  const creds = getServerCredentials();
  if (!creds) {
    console.warn(`${LOG_PREFIX} No server credentials available`);
    return [];
  }

  try {
    const res = await fetch(
      `${creds.apiUrl}/api/servers/${creds.serverId}/mcp-connections`,
      {
        headers: {
          'Authorization': `Bearer ${creds.token}`,
          'Accept': 'application/json',
          'User-Agent': 'ellul-bridge/1.0',
        },
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!res.ok) {
      console.warn(`${LOG_PREFIX} API returned ${res.status}`);
      return [];
    }

    const data = (await res.json()) as { connections: McpConnectionResponse[] };
    return data.connections || [];
  } catch (err) {
    console.warn(`${LOG_PREFIX} Failed to fetch connections:`, (err as Error).message);
    return [];
  }
}

/**
 * Load external MCP integrations from the API and connect them to the gateway.
 * Called at bridge startup and on manual refresh.
 *
 * Idempotent: disconnects stale connections, connects new ones, skips unchanged.
 */
export async function loadIntegrations(): Promise<void> {
  const configs = await fetchConnectionConfigs();

  if (configs.length === 0) {
    console.log(`${LOG_PREFIX} No MCP connections to load`);
    return;
  }

  const currentIds = new Set(mcpGateway.getConnectionIds());
  const desiredIds = new Set(configs.map(c => c.connectionId));

  for (const id of currentIds) {
    if (!desiredIds.has(id)) {
      mcpGateway.disconnect(id);
      console.log(`${LOG_PREFIX} Disconnected stale: ${id}`);
    }
  }

  let connected = 0;
  let errors = 0;
  for (const config of configs) {
    const status = mcpGateway.getConnectionStatus(config.connectionId);
    if (status === 'connected') continue;

    const mcpConfig: McpConnectionConfig = {
      connectionId: config.connectionId,
      url: config.url,
      transport: config.transport,
      authToken: config.authToken,
      providerKind: config.providerKind,
    };

    try {
      const result = await mcpGateway.connect(mcpConfig);
      if (result.errors.length > 0) {
        console.warn(`${LOG_PREFIX} ${config.providerKind} (${config.connectionId}): ${result.errors.join(', ')}`);
        errors++;
      } else {
        console.log(`${LOG_PREFIX} Connected ${config.providerKind}: ${result.tools.length} tools discovered`);
        connected++;
      }
    } catch (err) {
      console.warn(`${LOG_PREFIX} Failed to connect ${config.providerKind}:`, (err as Error).message);
      errors++;
    }
  }

  console.log(`${LOG_PREFIX} Load complete: ${connected} connected, ${errors} errors, ${configs.length} total`);
}

/**
 * Reload integrations from the API. Disconnects removed connections,
 * connects new ones. Called when user changes agent exposure.
 */
export async function reloadIntegrations(): Promise<void> {
  console.log(`${LOG_PREFIX} Reloading integrations...`);
  await loadIntegrations();
}
