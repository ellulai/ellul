// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Vault Proxy Service — Agent Bridge ↔ Shield IPC
 *
 * Proxies vault queries from the agent (via WebSocket) to sovereign-shield's
 * internal vault endpoints. All requests pass through shield's scope enforcement
 * layer — the bridge never interprets vault data, only forwards it.
 *
 * Agent must have an active vault_read gate grant to use these endpoints.
 * Each request requires a vault_session ID (bound to a specific scope).
 *
 * Message types handled:
 *   vault_list_notes  — list notes within the agent's scope
 *   vault_get_note    — read a specific note (scope-checked)
 *   vault_search      — full-text search within scope
 *   vault_graph       — scoped graph with optional phantom nodes
 *   vault_backlinks   — scoped backlinks with clamped restricted counts
 */

import { callShieldInternal } from '@vps/shared/shield-client';

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

export interface VaultProxyRequest {
  type: 'vault_list_notes' | 'vault_get_note' | 'vault_search' | 'vault_graph' | 'vault_backlinks';
  project: string;
  vaultSession: string;
  // Type-specific fields
  noteId?: string;
  query?: string;
  center?: string;
  depth?: number;
  limit?: number;
  offset?: number;
}

export interface VaultProxyResponse {
  type: string;
  success: boolean;
  data?: any;
  error?: string;
}

// ═══════════════════════════════════════════════════════════════════
// Proxy Handlers
// ═══════════════════════════════════════════════════════════════════

/**
 * Handle a vault proxy request from the WebSocket.
 * Routes to the appropriate shield internal endpoint.
 */
export async function handleVaultMessage(msg: VaultProxyRequest): Promise<VaultProxyResponse> {
  const { type, project, vaultSession } = msg;

  if (!project || !vaultSession) {
    return { type, success: false, error: 'project and vaultSession are required' };
  }

  try {
    switch (type) {
      case 'vault_list_notes':
        return await proxyVaultListNotes(msg);
      case 'vault_get_note':
        return await proxyVaultGetNote(msg);
      case 'vault_search':
        return await proxyVaultSearch(msg);
      case 'vault_graph':
        return await proxyVaultGraph(msg);
      case 'vault_backlinks':
        return await proxyVaultBacklinks(msg);
      default:
        return { type, success: false, error: `Unknown vault message type: ${type}` };
    }
  } catch (err: any) {
    console.error(`[vault-proxy] ${type} failed:`, err.message);
    return { type, success: false, error: err.message || 'Internal error' };
  }
}

async function proxyVaultListNotes(msg: VaultProxyRequest): Promise<VaultProxyResponse> {
  const params = new URLSearchParams({
    project: msg.project,
    vault_session: msg.vaultSession,
  });
  if (msg.limit) params.set('limit', String(msg.limit));
  if (msg.offset) params.set('offset', String(msg.offset));

  const res = await callShieldInternal(`/api/internal/vault/notes?${params}`, { timeout: 10_000 });
  const data = await res.json();

  if (!res.ok) {
    return { type: msg.type, success: false, error: data.error || `HTTP ${res.status}` };
  }

  return { type: msg.type, success: true, data };
}

async function proxyVaultGetNote(msg: VaultProxyRequest): Promise<VaultProxyResponse> {
  if (!msg.noteId) {
    return { type: msg.type, success: false, error: 'noteId is required' };
  }

  const params = new URLSearchParams({
    project: msg.project,
    vault_session: msg.vaultSession,
  });

  const res = await callShieldInternal(
    `/api/internal/vault/notes/${encodeURIComponent(msg.noteId)}?${params}`,
    { timeout: 10_000 },
  );
  const data = await res.json();

  if (!res.ok) {
    return { type: msg.type, success: false, error: data.error || `HTTP ${res.status}` };
  }

  return { type: msg.type, success: true, data };
}

async function proxyVaultSearch(msg: VaultProxyRequest): Promise<VaultProxyResponse> {
  const params = new URLSearchParams({
    project: msg.project,
    vault_session: msg.vaultSession,
  });
  if (msg.query) params.set('q', msg.query);
  if (msg.limit) params.set('limit', String(msg.limit));

  const res = await callShieldInternal(`/api/internal/vault/search?${params}`, { timeout: 10_000 });
  const data = await res.json();

  if (!res.ok) {
    return { type: msg.type, success: false, error: data.error || `HTTP ${res.status}` };
  }

  return { type: msg.type, success: true, data };
}

async function proxyVaultGraph(msg: VaultProxyRequest): Promise<VaultProxyResponse> {
  const params = new URLSearchParams({
    project: msg.project,
    vault_session: msg.vaultSession,
  });
  if (msg.center) params.set('center', msg.center);
  if (msg.depth) params.set('depth', String(msg.depth));

  const res = await callShieldInternal(`/api/internal/vault/graph?${params}`, { timeout: 15_000 });
  const data = await res.json();

  if (!res.ok) {
    return { type: msg.type, success: false, error: data.error || `HTTP ${res.status}` };
  }

  return { type: msg.type, success: true, data };
}

async function proxyVaultBacklinks(msg: VaultProxyRequest): Promise<VaultProxyResponse> {
  if (!msg.noteId) {
    return { type: msg.type, success: false, error: 'noteId is required' };
  }

  const params = new URLSearchParams({
    project: msg.project,
    vault_session: msg.vaultSession,
  });

  const res = await callShieldInternal(
    `/api/internal/vault/backlinks/${encodeURIComponent(msg.noteId)}?${params}`,
    { timeout: 10_000 },
  );
  const data = await res.json();

  if (!res.ok) {
    return { type: msg.type, success: false, error: data.error || `HTTP ${res.status}` };
  }

  return { type: msg.type, success: true, data };
}

// ═══════════════════════════════════════════════════════════════════
// Message Type Check
// ═══════════════════════════════════════════════════════════════════

const VAULT_MESSAGE_TYPES = new Set([
  'vault_list_notes',
  'vault_get_note',
  'vault_search',
  'vault_graph',
  'vault_backlinks',
]);

/**
 * Check if a WebSocket message type is a vault proxy message.
 */
export function isVaultMessage(type: string): boolean {
  return VAULT_MESSAGE_TYPES.has(type);
}
