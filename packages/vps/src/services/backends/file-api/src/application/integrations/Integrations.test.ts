// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Integrations service — pure-function tests.
 *
 * Covers the augmentation logic (`mergeIntegrationState`) and the local
 * signal detectors (`detectGitRemote`, `detectMigrations`) against a
 * temporary filesystem. The network fetch + shield round-trip are
 * covered by the route-level integration tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { IntegrationsResponse, IntegrationState } from '@ellul.ai/types';

vi.mock('@vps/shared/shield-client', () => ({
  callShieldInternal: vi.fn(),
  setShieldServiceName: vi.fn(),
}));

// Hoisted so the `vi.mock('../../config', …)` factory (also hoisted) can
// reference the same tmp-file paths used by the test bodies.
const PATH_FIXTURES = vi.hoisted(() => {
  const fsModule = require('fs') as typeof import('fs');
  const osModule = require('os') as typeof import('os');
  const pathModule = require('path') as typeof import('path');
  const credTmp = fsModule.mkdtempSync(
    pathModule.join(osModule.tmpdir(), 'integrations-paths-'),
  );
  return {
    SERVER_ID_FILE: pathModule.join(credTmp, 'server-id'),
    API_URL_FILE: pathModule.join(credTmp, 'api-url'),
    AI_PROXY_TOKEN_FILE: pathModule.join(credTmp, 'ai-proxy-token'),
  };
});

const { SERVER_ID_FILE, API_URL_FILE, AI_PROXY_TOKEN_FILE } = PATH_FIXTURES;

vi.mock('../../config', () => ({
  HOME: '/tmp',
  ROOT_DIR: '/tmp/test-projects',
  PATHS: {
    SERVER_ID: PATH_FIXTURES.SERVER_ID_FILE,
    API_URL: PATH_FIXTURES.API_URL_FILE,
    AI_PROXY_TOKEN: PATH_FIXTURES.AI_PROXY_TOKEN_FILE,
  },
}));

import {
  detectGitRemote,
  detectMigrations,
  getIntegrations,
  invalidateIntegrationsCache,
  mergeIntegrationState,
} from './Integrations';
import { callShieldInternal } from '@vps/shared/shield-client';

// ─── Filesystem fixture helpers ─────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'integrations-test-'));
}

function wipe(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

// ─── detectGitRemote ────────────────────────────────────────────────────────

describe('detectGitRemote', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTempDir();
  });

  afterEach(() => wipe(tmp));

  it('returns false when there is no .git directory', () => {
    expect(detectGitRemote(tmp)).toBe(false);
  });

  it('returns false when .git/config exists but has no remote section', () => {
    fs.mkdirSync(path.join(tmp, '.git'));
    fs.writeFileSync(
      path.join(tmp, '.git', 'config'),
      '[core]\n\trepositoryformatversion = 0\n',
    );
    expect(detectGitRemote(tmp)).toBe(false);
  });

  it('returns true when .git/config has at least one remote section', () => {
    fs.mkdirSync(path.join(tmp, '.git'));
    fs.writeFileSync(
      path.join(tmp, '.git', 'config'),
      '[core]\n\trepositoryformatversion = 0\n' +
        '[remote "origin"]\n\turl = git@github.com:me/repo.git\n',
    );
    expect(detectGitRemote(tmp)).toBe(true);
  });

  it('returns true for non-origin remote names too', () => {
    fs.mkdirSync(path.join(tmp, '.git'));
    fs.writeFileSync(
      path.join(tmp, '.git', 'config'),
      '[remote "upstream"]\n\turl = https://example.com/repo.git\n',
    );
    expect(detectGitRemote(tmp)).toBe(true);
  });
});

// ─── detectMigrations ───────────────────────────────────────────────────────

describe('detectMigrations', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTempDir();
  });

  afterEach(() => wipe(tmp));

  it('returns false for an empty project', () => {
    expect(detectMigrations(tmp)).toBe(false);
  });

  it('detects a "db:migrate" script in package.json', () => {
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ scripts: { 'db:migrate': 'drizzle-kit migrate' } }),
    );
    expect(detectMigrations(tmp)).toBe(true);
  });

  it('detects prisma as a script name', () => {
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ scripts: { prisma: 'prisma generate' } }),
    );
    expect(detectMigrations(tmp)).toBe(true);
  });

  it('detects a prisma directory even without package.json', () => {
    fs.mkdirSync(path.join(tmp, 'prisma'));
    expect(detectMigrations(tmp)).toBe(true);
  });

  it('detects a generic migrations directory', () => {
    fs.mkdirSync(path.join(tmp, 'migrations'));
    expect(detectMigrations(tmp)).toBe(true);
  });

  it('detects db/migrations directory', () => {
    fs.mkdirSync(path.join(tmp, 'db'));
    fs.mkdirSync(path.join(tmp, 'db', 'migrations'));
    expect(detectMigrations(tmp)).toBe(true);
  });

  it('ignores unrelated scripts and directories', () => {
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ scripts: { build: 'tsc', start: 'node .' } }),
    );
    fs.mkdirSync(path.join(tmp, 'src'));
    expect(detectMigrations(tmp)).toBe(false);
  });

  it('tolerates malformed package.json', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), '{ not json ');
    expect(detectMigrations(tmp)).toBe(false);
  });

  it('detects Ruby on Rails db/migrate directory', () => {
    fs.mkdirSync(path.join(tmp, 'db'));
    fs.mkdirSync(path.join(tmp, 'db', 'migrate'));
    expect(detectMigrations(tmp)).toBe(true);
  });

  it('detects Alembic via alembic.ini', () => {
    fs.writeFileSync(path.join(tmp, 'alembic.ini'), '[alembic]\n');
    expect(detectMigrations(tmp)).toBe(true);
  });

  it('detects Django via manage.py', () => {
    fs.writeFileSync(
      path.join(tmp, 'manage.py'),
      'from django.core.management import execute_from_command_line\n',
    );
    expect(detectMigrations(tmp)).toBe(true);
  });

  it('detects Supabase migrations', () => {
    fs.mkdirSync(path.join(tmp, 'supabase'));
    fs.mkdirSync(path.join(tmp, 'supabase', 'migrations'));
    expect(detectMigrations(tmp)).toBe(true);
  });

  it('does not false-positive on an unrelated migrate-like word', () => {
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ scripts: { emigrate: 'echo ok' } }),
    );
    // "emigrate" has no \bmigrate\b match
    expect(detectMigrations(tmp)).toBe(false);
  });
});

// ─── mergeIntegrationState ──────────────────────────────────────────────────

describe('mergeIntegrationState', () => {
  const baseControlPlane = (
    overrides?: Partial<IntegrationState>,
  ): IntegrationState => ({
    deployProviders: [],
    dataProviders: [],
    gitProviders: [],
    cloudflareProviders: [],
    paymentProviders: [],
    hasLinkedRepo: false,
    hasDeployConfig: false,
    hasDatabase: false,
    hasMigrations: false,
    ...overrides,
  });

  it('preserves provider lists unchanged', () => {
    const cp = baseControlPlane({
      deployProviders: ['vercel'],
      gitProviders: ['github'],
    });
    const merged = mergeIntegrationState(cp, {
      gitRemote: true,
      shieldDatabase: false,
      migrations: false,
    });
    expect(merged.deployProviders).toEqual(['vercel']);
    expect(merged.gitProviders).toEqual(['github']);
  });

  it('requires BOTH a connected git provider AND a local git remote for hasLinkedRepo', () => {
    const providerOnly = mergeIntegrationState(
      baseControlPlane({ gitProviders: ['github'], hasLinkedRepo: true }),
      { gitRemote: false, shieldDatabase: false, migrations: false },
    );
    expect(providerOnly.hasLinkedRepo).toBe(false);

    const remoteOnly = mergeIntegrationState(
      baseControlPlane({ gitProviders: [], hasLinkedRepo: false }),
      { gitRemote: true, shieldDatabase: false, migrations: false },
    );
    expect(remoteOnly.hasLinkedRepo).toBe(false);

    const both = mergeIntegrationState(
      baseControlPlane({ gitProviders: ['github'], hasLinkedRepo: true }),
      { gitRemote: true, shieldDatabase: false, migrations: false },
    );
    expect(both.hasLinkedRepo).toBe(true);
  });

  it('OR-combines hasDatabase — external provider OR local shield', () => {
    const externalOnly = mergeIntegrationState(
      baseControlPlane({ hasDatabase: true }),
      { gitRemote: false, shieldDatabase: false, migrations: false },
    );
    expect(externalOnly.hasDatabase).toBe(true);

    const shieldOnly = mergeIntegrationState(
      baseControlPlane({ hasDatabase: false }),
      { gitRemote: false, shieldDatabase: true, migrations: false },
    );
    expect(shieldOnly.hasDatabase).toBe(true);

    const neither = mergeIntegrationState(
      baseControlPlane({ hasDatabase: false }),
      { gitRemote: false, shieldDatabase: false, migrations: false },
    );
    expect(neither.hasDatabase).toBe(false);
  });

  it('passes hasDeployConfig through unchanged (control-plane authoritative)', () => {
    const on = mergeIntegrationState(
      baseControlPlane({ hasDeployConfig: true }),
      { gitRemote: false, shieldDatabase: false, migrations: false },
    );
    expect(on.hasDeployConfig).toBe(true);

    const off = mergeIntegrationState(
      baseControlPlane({ hasDeployConfig: false }),
      { gitRemote: true, shieldDatabase: true, migrations: true },
    );
    expect(off.hasDeployConfig).toBe(false);
  });

  it('overrides hasMigrations with the VPS-local signal', () => {
    const merged = mergeIntegrationState(
      baseControlPlane({ hasMigrations: false }),
      { gitRemote: false, shieldDatabase: false, migrations: true },
    );
    expect(merged.hasMigrations).toBe(true);
  });
});

// ─── getIntegrations (end-to-end with mocked control plane + shield) ────────

describe('getIntegrations', () => {
  let projectDir: string;

  const cpResponse = (
    override?: Partial<IntegrationsResponse>,
  ): IntegrationsResponse => ({
    sandboxId: 'sbx-abc1234/my-app',
    state: {
      deployProviders: ['vercel'],
      dataProviders: [],
      gitProviders: ['github'],
      cloudflareProviders: [],
      paymentProviders: [],
      hasLinkedRepo: true,
      hasDeployConfig: true,
      hasDatabase: false,
      hasMigrations: false,
    },
    connections: {
      deploy: [
        {
          providerKind: 'vercel',
          displayName: 'Vercel',
          status: 'connected',
          isDefault: true,
        },
      ],
      data: [],
      git: [
        {
          providerKind: 'github',
          displayName: 'GitHub',
          status: 'connected',
          isDefault: true,
        },
      ],
      cloudflare: [],
      payments: [],
    },
    computedAt: 1,
    ...override,
  });

  beforeEach(() => {
    projectDir = makeTempDir();
    fs.writeFileSync(SERVER_ID_FILE, 'srv_test');
    fs.writeFileSync(API_URL_FILE, 'https://api.test');
    fs.writeFileSync(AI_PROXY_TOKEN_FILE, 'tok_test');
    invalidateIntegrationsCache();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    wipe(projectDir);
  });

  it('merges control-plane state with local signals', async () => {
    // Local signals: git remote + migrations + no shield database
    fs.mkdirSync(path.join(projectDir, '.git'));
    fs.writeFileSync(
      path.join(projectDir, '.git', 'config'),
      '[remote "origin"]\n\turl = https://example.com/repo.git\n',
    );
    fs.mkdirSync(path.join(projectDir, 'prisma'));

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(cpResponse()), { status: 200 }),
      ),
    );
    vi.mocked(callShieldInternal).mockResolvedValue(
      new Response(JSON.stringify({ exists: false }), { status: 200 }),
    );

    const result = await getIntegrations(
      'sbx-abc1234/my-app',
      projectDir,
    );

    expect(result.state.gitProviders).toEqual(['github']);
    expect(result.state.hasLinkedRepo).toBe(true);
    expect(result.state.hasMigrations).toBe(true);
    expect(result.state.hasDatabase).toBe(false);
  });

  it('falls back to an empty state when the control plane is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{}', { status: 500 })),
    );
    vi.mocked(callShieldInternal).mockResolvedValue(
      new Response(JSON.stringify({ exists: false }), { status: 200 }),
    );

    const result = await getIntegrations(
      'sbx-abc1234/my-app',
      projectDir,
    );

    expect(result.state.deployProviders).toEqual([]);
    expect(result.state.gitProviders).toEqual([]);
    expect(result.state.hasLinkedRepo).toBe(false);
  });

  it('reflects a shield-provisioned database via hasDatabase', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify(
            cpResponse({
              state: {
                deployProviders: [],
                dataProviders: [],
                gitProviders: [],
                cloudflareProviders: [],
                paymentProviders: [],
                hasLinkedRepo: false,
                hasDeployConfig: false,
                hasDatabase: false,
                hasMigrations: false,
              },
            }),
          ),
          { status: 200 },
        ),
      ),
    );
    vi.mocked(callShieldInternal).mockResolvedValue(
      new Response(JSON.stringify({ exists: true }), { status: 200 }),
    );

    const result = await getIntegrations(
      'sbx-abc1234/my-app',
      projectDir,
    );
    expect(result.state.hasDatabase).toBe(true);
  });

  it('caches results across calls until invalidated', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () =>
        new Response(JSON.stringify(cpResponse()), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(callShieldInternal).mockImplementation(async () =>
      new Response(JSON.stringify({ exists: false }), { status: 200 }),
    );

    await getIntegrations('sbx-abc1234/my-app', projectDir);
    await getIntegrations('sbx-abc1234/my-app', projectDir);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    invalidateIntegrationsCache('sbx-abc1234/my-app');
    await getIntegrations('sbx-abc1234/my-app', projectDir);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('degrades to empty state when VPS credentials are missing', async () => {
    fs.rmSync(AI_PROXY_TOKEN_FILE);

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(callShieldInternal).mockResolvedValue(
      new Response(JSON.stringify({ exists: false }), { status: 200 }),
    );

    const result = await getIntegrations(
      'sbx-abc1234/my-app',
      projectDir,
    );
    // No network call attempted — credentials missing.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.state.gitProviders).toEqual([]);
  });
});
