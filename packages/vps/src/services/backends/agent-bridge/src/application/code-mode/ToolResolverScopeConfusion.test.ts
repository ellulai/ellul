// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Integration tests for the bridge's code-mode `ToolResolver.evaluatePolicy`.
 *
 * Proves that when the agent invokes a sandbox-scoped MCP tool via
 * `execute_code` with args that reference another sandbox's `.shared/`
 * snapshot, the resolver:
 *
 *   1. Denies the call structurally (`resolved: false, reason: 'CROSS_PROJECT_SCOPE_CONFUSION'`)
 *   2. Does NOT fire the approval popup callback (no user is prompted)
 *   3. Still allows the call through for non-sandbox-scoped capabilities
 *      (filesystem/network/execution) where `.shared/*` access is the
 *      whole point of cross-project inspection.
 *
 * This is the wire-up proof for L1 on the code-mode path — complements
 * the pure unit tests of the scope-confusion helpers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// `checkGateOpen` lives on the mcp-gateway module — the resolver imports
// it as a named re-export. Stubbing it lets us drive the "gate open" vs
// "gate closed" branch without any HTTP round-trip to shield.
//
// The shield-client stub prevents the module graph from actually trying
// to resolve shield network config at import time.
vi.mock('@vps/shared/shield-client', () => ({
  callShieldInternal: vi.fn(),
  shieldGet: vi.fn(),
  shieldPost: vi.fn(),
  setShieldServiceName: vi.fn(),
}));

vi.mock('../mcp-tool/governance/McpGateway', async () => {
  const actual = await vi.importActual<typeof import('../mcp-tool/governance/McpGateway')>(
    '../mcp-tool/governance/McpGateway',
  );
  return {
    ...actual,
    // Default to "open"; individual tests override via mockImplementation.
    checkGateOpen: vi.fn(async () => true),
  };
});

import { ToolResolver } from './ToolResolver';
import type { ToolIdentity } from './Types';
import { checkGateOpen, type McpGateway, type ToolCallContext } from '../mcp-tool/governance/McpGateway';
import type { ToolRegistry } from './ToolRegistry';

// ── Helpers ─────────────────────────────────────────────────────────────

function mkContext(): ToolCallContext {
  return {
    threadId: 't_00000000-0000-0000-0000-000000000000',
    sandboxId: 'sbx-aaaaaaa',
  } as ToolCallContext;
}

function mkResolver(identity: ToolIdentity, gateIsOpen: boolean): {
  resolver: ToolResolver;
  gateway: McpGateway & {
    fireApprovalRequired: ReturnType<typeof vi.fn>;
    getToolPermission: ReturnType<typeof vi.fn>;
  };
} {
  const gateway = {
    fireApprovalRequired: vi.fn(),
    getToolPermission: vi.fn().mockReturnValue(null),
  } as unknown as McpGateway & {
    fireApprovalRequired: ReturnType<typeof vi.fn>;
    getToolPermission: ReturnType<typeof vi.fn>;
  };

  const registry = {
    resolve: vi.fn().mockReturnValue(identity),
  } as unknown as ToolRegistry;

  vi.mocked(checkGateOpen).mockResolvedValue(gateIsOpen);

  const resolver = new ToolResolver(registry, gateway);
  return { resolver, gateway };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('ToolResolver: cross-project scope confusion — L1 on code-mode path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('DENIES database:read with `.shared/<B>/` args AND skips approval popup', async () => {
    const identity: ToolIdentity = {
      toolName: 'db_query',
      connectionId: 'builtin/db',
      capability: 'database:read',
    };
    const { resolver, gateway } = mkResolver(identity, false);

    const result = await resolver.resolve(
      'db_query',
      { sql: "COPY x FROM '.shared/sbx-bbbbbbb/data.csv'" },
      mkContext(),
      'exec-1',
      0,
    );

    expect(result.resolved).toBe(false);
    if (!result.resolved) {
      expect(result.reason).toBe('CROSS_PROJECT_SCOPE_CONFUSION');
    }
    // Must NOT fire the approval popup — user sees no prompt.
    expect(gateway.fireApprovalRequired).not.toHaveBeenCalled();
  });

  it('DENIES secrets:env_read with `/projects/<B>/` path reference', async () => {
    const identity: ToolIdentity = {
      toolName: 'get_secret',
      connectionId: 'builtin/secrets',
      capability: 'secrets:env_read',
    };
    const { resolver, gateway } = mkResolver(identity, false);

    const result = await resolver.resolve(
      'get_secret',
      { key: 'DB_URL', context_dir: '/home/dev/projects/sbx-bbbbbbb' },
      mkContext(),
      'exec-2',
      0,
    );

    expect(result.resolved).toBe(false);
    if (!result.resolved) {
      expect(result.reason).toBe('CROSS_PROJECT_SCOPE_CONFUSION');
    }
    expect(gateway.fireApprovalRequired).not.toHaveBeenCalled();
  });

  it('DENIES deployment:deploy_trigger targeting a shared snapshot', async () => {
    const identity: ToolIdentity = {
      toolName: 'deploy',
      connectionId: 'builtin/deploy',
      capability: 'deployment:deploy_trigger',
    };
    const { resolver, gateway } = mkResolver(identity, false);

    const result = await resolver.resolve(
      'deploy',
      { cwd: '.shared/sbx-bbbbbbb' },
      mkContext(),
      'exec-3',
      0,
    );

    expect(result.resolved).toBe(false);
    if (!result.resolved) {
      expect(result.reason).toBe('CROSS_PROJECT_SCOPE_CONFUSION');
    }
    expect(gateway.fireApprovalRequired).not.toHaveBeenCalled();
  });

  it('ALLOWS filesystem:read on `.shared/<B>/` (inspection is the point)', async () => {
    const identity: ToolIdentity = {
      toolName: 'read_file',
      connectionId: 'builtin/fs',
      capability: 'filesystem:read',
    };
    const { resolver, gateway } = mkResolver(identity, true);

    const result = await resolver.resolve(
      'read_file',
      { path: '.shared/sbx-bbbbbbb/app.ts' },
      mkContext(),
      'exec-4',
      0,
    );

    expect(result.resolved).toBe(true);
    expect(gateway.fireApprovalRequired).not.toHaveBeenCalled();
  });

  it('ALLOWS sandbox-scoped tools when args DO NOT reference a shared sandbox', async () => {
    const identity: ToolIdentity = {
      toolName: 'db_query',
      connectionId: 'builtin/db',
      capability: 'database:read',
    };
    const { resolver, gateway } = mkResolver(identity, true);

    const result = await resolver.resolve(
      'db_query',
      { sql: 'SELECT * FROM users' },
      mkContext(),
      'exec-5',
      0,
    );

    expect(result.resolved).toBe(true);
    expect(gateway.fireApprovalRequired).not.toHaveBeenCalled();
  });

  it('When gate is CLOSED for non-sandbox-scoped call, approval popup IS fired with enriched reason', async () => {
    const identity: ToolIdentity = {
      toolName: 'http_get',
      connectionId: 'builtin/http',
      capability: 'network:http_read',
    };
    const { resolver, gateway } = mkResolver(identity, false);

    const result = await resolver.resolve(
      'http_get',
      { url: 'https://api.example.com', context: '.shared/sbx-bbbbbbb/config.ts' },
      mkContext(),
      'exec-6',
      0,
    );

    expect(result.resolved).toBe(false);
    if (!result.resolved) {
      expect(result.reason).toBe('GATE_CLOSED');
    }
    expect(gateway.fireApprovalRequired).toHaveBeenCalledOnce();
    // The fired reason must carry the extracted path hint so shield's L3
    // matcher catches it.
    const [, , firedReason] = gateway.fireApprovalRequired.mock.calls[0]!;
    expect(firedReason).toContain('.shared/sbx-bbbbbbb');
  });
});
