// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Central port registry for every VPS service.
 *
 * Single source of truth for every TCP port a VPS service binds. Every
 * service MUST import its port constant from this file — defining a port
 * inline anywhere else is a build error.
 *
 * Each entry declares:
 *   - `port`: the TCP port number
 *   - `service`: the systemd unit / binary that owns the port
 *   - `bind`: which interface address the service listens on
 *   - `reachable`: who is expected to be able to reach the port
 *
 * Build-time invariants (enforced by `assertNoPortCollisions`):
 *   1. Every port number is unique across the whole table.
 *   2. No two services claim the same (host, port) tuple.
 *
 * Runtime contract: any service that binds one of these ports MUST match
 * the declared bind address. Binding to a different address or port is a
 * bug — rip the declaration and re-run the collision check.
 *
 * Historical context: before this registry existed, MCP_ENDPOINT_PORT
 * was declared in config.ts as 7701, which silently collided with
 * ellul-term-proxy's hard-coded PORT = 7701. The collision only became
 * visible once term-proxy shipped its real bundle; until then term-proxy
 * was a no-op placeholder and MCP got the port by default. Declarative
 * port allocation with a collision check makes that class of bug
 * impossible by construction.
 */

export type BindAddress = '127.0.0.1' | '0.0.0.0' | 'unix-socket';

export interface PortAllocation {
  /** TCP port number. */
  readonly port: number;
  /** systemd unit or binary owning the port (source of truth name). */
  readonly service: string;
  /** Interface the service binds to. */
  readonly bind: BindAddress;
  /** Short prose: who is expected to reach this port. */
  readonly reachable: string;
}

/**
 * The authoritative allocation table. Add a new service HERE, not inline.
 */
export const PORT_REGISTRY = {
  FILE_API: {
    port: 3002,
    service: 'ellul-file-api',
    bind: '127.0.0.1',
    reachable: 'localhost only; agent blocked by warden OUTPUT DROP',
  },
  IDE: {
    port: 3003,
    service: 'ellul-ide',
    bind: '127.0.0.1',
    reachable: 'localhost only; gateway DNATs /ide/* via caddy',
  },
  SOVEREIGN_SHIELD: {
    port: 3005,
    service: 'ellul-sovereign-shield',
    bind: '127.0.0.1',
    reachable: 'localhost only; shield-ipc group gated',
  },
  OPENCODE_API: {
    port: 4096,
    service: 'opencode-serve',
    bind: '127.0.0.1',
    reachable: 'localhost only; spawned per-namespace',
  },
  AGENT_BRIDGE: {
    port: 7700,
    service: 'ellul-agent-bridge',
    bind: '127.0.0.1',
    reachable: 'localhost only; WebSocket to the dashboard',
  },
  TERM_PROXY: {
    port: 7701,
    service: 'ellul-term-proxy',
    bind: '127.0.0.1',
    reachable: 'localhost only; gateway frontend DNATs here via caddy',
  },
  MCP_ENDPOINT: {
    port: 7702,
    service: 'ellul-agent-bridge (mcp-endpoint)',
    bind: '0.0.0.0',
    reachable:
      'per-project namespace veths (10.200.0.0/11) via INPUT ACCEPT ' +
      '+ -i ea-+ interface match; every request carries an HMAC ' +
      'per-project token; external network blocked by catch-all DROP',
  },
  METRICS_PROMETHEUS: {
    port: 7703,
    service: 'ellul-agent-bridge (metrics-collector)',
    bind: '127.0.0.1',
    reachable: 'localhost only; scrape target for in-process diagnostics',
  },
  TERMINAL_PROXY_BACKEND: {
    port: 18790,
    service: 'ellul-file-api (terminal socket)',
    bind: '127.0.0.1',
    reachable: 'per-project namespace via DNAT',
  },
  GBRAIN: {
    port: 7704,
    service: 'ellul-gbrain',
    bind: '127.0.0.1',
    reachable:
      'localhost only; agent-bridge MCP gateway connects via ' +
      'streamable-http; unreachable from namespace veths',
  },
} as const satisfies Record<string, PortAllocation>;

export type PortRegistryKey = keyof typeof PORT_REGISTRY;

// Convenience aliases for the services that most often need a port
// number without reaching into the registry.
export const FILE_API_PORT = PORT_REGISTRY.FILE_API.port;
export const SOVEREIGN_SHIELD_PORT = PORT_REGISTRY.SOVEREIGN_SHIELD.port;
export const OPENCODE_API_PORT = PORT_REGISTRY.OPENCODE_API.port;
export const AGENT_BRIDGE_PORT = PORT_REGISTRY.AGENT_BRIDGE.port;
export const TERM_PROXY_PORT = PORT_REGISTRY.TERM_PROXY.port;
export const MCP_ENDPOINT_PORT = PORT_REGISTRY.MCP_ENDPOINT.port;
export const METRICS_PROMETHEUS_PORT = PORT_REGISTRY.METRICS_PROMETHEUS.port;
export const TERMINAL_PROXY_BACKEND_PORT = PORT_REGISTRY.TERMINAL_PROXY_BACKEND.port;
export const GBRAIN_PORT = PORT_REGISTRY.GBRAIN.port;

/**
 * Assert that every entry in PORT_REGISTRY claims a unique port number.
 *
 * Called at build time from scripts/build-agent-bundles.mjs and at the
 * top of the vps package's index so the collision is caught before any
 * artifact ships. Throws a detailed error on the first collision.
 */
export function assertNoPortCollisions(): void {
  const seen = new Map<number, string>();
  for (const [key, alloc] of Object.entries(PORT_REGISTRY)) {
    const owner = seen.get(alloc.port);
    if (owner) {
      throw new Error(
        `Port collision in PORT_REGISTRY: ${key} (${alloc.service}) and ` +
          `${owner} both claim port ${alloc.port}. Pick a different port ` +
          `for one of them in packages/vps/src/services/shared/ports.ts.`,
      );
    }
    seen.set(alloc.port, key);
  }
}

// Run the check on first import. Any future edit that introduces a
// collision throws at module load, failing both build-agent-bundles.mjs
// and any service that imports from this file at build time.
assertNoPortCollisions();
