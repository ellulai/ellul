// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// MCP Provider Registry — mirrors adapters/registry.ts for tool providers.
//
// Holds all platform-installed MCP providers. Manages bulk lifecycle
// (connectAll at startup, disconnectAll at shutdown) and provides
// lookup for features-routes and platform-instructions.

import type { McpProviderDefinition } from './types';
import { mcpGateway } from '../mcp-tool/governance/McpGateway';

const LOG_PREFIX = '[McpProviderRegistry]';
const RECONCILE_INTERVAL_MS = 30_000;

class McpProviderRegistryImpl {
  private readonly providers = new Map<string, McpProviderDefinition>();
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;

  register(provider: McpProviderDefinition): void {
    if (this.providers.has(provider.id)) {
      console.warn(`${LOG_PREFIX} Replacing existing provider: ${provider.id}`);
    }
    this.providers.set(provider.id, provider);
    console.log(`${LOG_PREFIX} Registered: ${provider.kind} (${provider.id}), ${Object.keys(provider.toolManifest).length} tools declared`);
  }

  get(id: string): McpProviderDefinition | undefined {
    return this.providers.get(id);
  }

  getByKind(kind: string): McpProviderDefinition | undefined {
    for (const p of this.providers.values()) {
      if (p.kind === kind) return p;
    }
    return undefined;
  }

  getAll(): McpProviderDefinition[] {
    return [...this.providers.values()];
  }

  async connectAll(): Promise<void> {
    const results = await Promise.allSettled(
      this.getAll().map(async (p) => {
        if (!p.isEnabled()) {
          console.log(`${LOG_PREFIX} Skipping disabled provider: ${p.kind}`);
          return;
        }
        await p.connect();
      }),
    );

    let ok = 0;
    let fail = 0;
    for (const r of results) {
      if (r.status === 'fulfilled') ok++;
      else {
        fail++;
        console.error(`${LOG_PREFIX} Provider connect failed:`, r.reason);
      }
    }
    console.log(`${LOG_PREFIX} connectAll: ${ok} ok, ${fail} failed, ${this.providers.size} registered`);

    this.startReconciler();
  }

  disconnectAll(): void {
    this.stopReconciler();
    for (const p of this.providers.values()) {
      p.disconnect();
    }
  }

  private startReconciler(): void {
    if (this.reconcileTimer) return;
    this.reconcileTimer = setInterval(() => void this.reconcile(), RECONCILE_INTERVAL_MS);
    if (typeof this.reconcileTimer.unref === 'function') this.reconcileTimer.unref();
  }

  private stopReconciler(): void {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
  }

  private async reconcile(): Promise<void> {
    for (const p of this.providers.values()) {
      const status = mcpGateway.getConnectionStatus(p.id);
      const enabled = p.isEnabled();

      if (enabled && status !== 'connected') {
        console.log(`${LOG_PREFIX} Reconciler: ${p.kind} enabled but ${status ?? 'not connected'}, reconnecting`);
        try {
          await p.connect();
        } catch (err) {
          console.warn(`${LOG_PREFIX} Reconciler: ${p.kind} reconnect failed:`, (err as Error).message);
        }
      } else if (!enabled && status === 'connected') {
        console.log(`${LOG_PREFIX} Reconciler: ${p.kind} disabled but connected, disconnecting`);
        p.disconnect();
      }
    }
  }
}

export const mcpProviderRegistry = new McpProviderRegistryImpl();
