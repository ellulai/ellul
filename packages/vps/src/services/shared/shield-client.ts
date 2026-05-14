// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Shield Internal API Client
 *
 * Used by file-api, agent-bridge, and enforcer to call sovereign-shield's
 * internal endpoints with proper authentication.
 *
 * Reads the per-service internal token from /run/shield/internal-<service>.token.
 * On 401 (token rotated after shield restart), re-reads the token and retries once.
 *
 * Only services in the shield-ipc group can read the token file.
 * Agent ($SVC_USER) is not in this group — cannot authenticate.
 */

import fs from 'fs';

import { PORT_REGISTRY } from './ports';

const SHIELD_BASE_URL = `http://127.0.0.1:${PORT_REGISTRY.SOVEREIGN_SHIELD.port}`;

let cachedToken: string | null = null;

// Service identification — set once at startup by each service.
// Determines which per-service token file to read and is sent
// as x-service-name header for verified audit logging.
let serviceName: string = 'unknown';

/**
 * Get the per-service token file path.
 * Requires serviceName to be set via setShieldServiceName() at startup.
 */
function getTokenPath(): string {
  if (serviceName === 'unknown') {
    throw new Error('[shield-client] serviceName not set — call setShieldServiceName() at startup');
  }
  return `/run/shield/internal-${serviceName}.token`;
}

/**
 * Set the caller service name for token scoping and audit logging.
 * Call once at service startup (e.g., setShieldServiceName('file-api')).
 */
export function setShieldServiceName(name: string): void {
  serviceName = name;
  // Invalidate cached token so next call reads the per-service file
  cachedToken = null;
}

/**
 * Read the per-service internal token from the filesystem.
 * Caches in memory after first read.
 */
function readToken(): string | null {
  try {
    cachedToken = fs.readFileSync(getTokenPath(), 'utf8').trim();
    return cachedToken;
  } catch {
    return null;
  }
}

/**
 * Refresh the cached token (used after 401 response).
 */
function refreshToken(): string | null {
  cachedToken = null;
  return readToken();
}

/**
 * Call a sovereign-shield internal endpoint with authentication.
 * Automatically retries once on 401 (token may have rotated).
 *
 * @param path - Endpoint path (e.g., '/api/internal/gate/status')
 * @param options - fetch options (method, body, etc.)
 * @returns Response from shield
 */
export async function callShieldInternal(
  path: string,
  options: {
    method?: string;
    body?: any;
    headers?: Record<string, string>;
    timeout?: number;
  } = {},
): Promise<Response> {
  const token = cachedToken || readToken();

  const doFetch = async (authToken: string | null): Promise<Response> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-service-name': serviceName,
      ...(options.headers || {}),
    };

    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }

    const controller = new AbortController();
    const timeout = options.timeout || 30_000;
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const res = await fetch(`${SHIELD_BASE_URL}${path}`, {
        method: options.method || (options.body ? 'POST' : 'GET'),
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
      clearTimeout(timer);
      return res;
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  };

  // First attempt
  const res = await doFetch(token);

  // On 401: token may have rotated (shield restarted). Re-read and retry once.
  if (res.status === 401) {
    const newToken = refreshToken();
    if (newToken && newToken !== token) {
      return doFetch(newToken);
    }
  }

  return res;
}

/**
 * Convenience: GET request to shield internal API.
 */
export async function shieldGet(path: string): Promise<any> {
  const res = await callShieldInternal(path);
  if (!res.ok) throw new Error(`Shield GET ${path}: ${res.status}`);
  return res.json();
}

/**
 * Convenience: POST request to shield internal API.
 */
export async function shieldPost(path: string, body?: any): Promise<any> {
  const res = await callShieldInternal(path, { method: 'POST', body });
  if (!res.ok) throw new Error(`Shield POST ${path}: ${res.status}`);
  return res.json();
}
