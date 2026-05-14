// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Product Gate — Two-Engine Architecture Tests
 *
 * Tests both engines independently:
 *   - Restrictive Engine (cloud_sandbox, shield_proxy): blocks features not in product
 *   - Permissive Engine (cloud_platform): near-zero overhead, deploy sub-check on free billing tier
 *
 * Since the engine is selected at module load from /etc/ellul/product + /etc/ellul/billing-tier,
 * we mock fs.readFileSync BEFORE importing the module for each test suite.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';

vi.mock('fs', () => ({
  default: { readFileSync: vi.fn() },
  readFileSync: vi.fn(),
}));

// ─── Helper: dynamically import the module with specific product + tier ──────

interface LoadOptions {
  product: string | Error;
  billingTier: string | Error;
}

async function loadModuleWithConfig(opts: LoadOptions) {
  vi.resetModules();

  const mockFs = await vi.importMock<typeof import('fs')>('fs');
  vi.mocked(mockFs.default.readFileSync).mockImplementation((path: any) => {
    const pathStr = typeof path === 'string' ? path : path.toString();
    if (pathStr === '/etc/ellul/product') {
      if (opts.product instanceof Error) throw opts.product;
      return opts.product;
    }
    if (pathStr === '/etc/ellul/billing-tier') {
      if (opts.billingTier instanceof Error) throw opts.billingTier;
      return opts.billingTier;
    }
    throw new Error(`Unexpected readFileSync path: ${pathStr}`);
  });

  const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  const mod = await import('./product-gate.middleware');

  consoleSpy.mockRestore();
  consoleErrSpy.mockRestore();

  return mod;
}

async function createApp(opts: LoadOptions) {
  const { Hono } = await import('hono');
  const { productGateMiddleware, PRODUCT, BILLING_TIER } = await loadModuleWithConfig(opts);

  const app = new Hono();
  app.use('*', productGateMiddleware);
  app.all('*', (c) => c.json({ ok: true, product: c.get('product'), tier: c.get('billingTier') }));

  return { app, resolvedProduct: PRODUCT, resolvedTier: BILLING_TIER };
}

// ═════════════════════════════════════════════════════════════════════
// Resolution at boot
// ═════════════════════════════════════════════════════════════════════

describe('product resolution at boot', () => {
  it('resolves "cloud_platform" correctly', async () => {
    const { resolvedProduct } = await createApp({ product: 'cloud_platform', billingTier: 'paid' });
    expect(resolvedProduct).toBe('cloud_platform');
  });

  it('resolves "cloud_sandbox" correctly', async () => {
    const { resolvedProduct } = await createApp({ product: 'cloud_sandbox', billingTier: 'paid' });
    expect(resolvedProduct).toBe('cloud_sandbox');
  });

  it('resolves "shield_proxy" correctly', async () => {
    const { resolvedProduct } = await createApp({ product: 'shield_proxy', billingTier: 'paid' });
    expect(resolvedProduct).toBe('shield_proxy');
  });

  it('defaults to "cloud_platform" for unknown product', async () => {
    const { resolvedProduct } = await createApp({ product: 'unknown', billingTier: 'paid' });
    expect(resolvedProduct).toBe('cloud_platform');
  });

  it('defaults to "cloud_platform" on missing product file', async () => {
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    const { resolvedProduct } = await createApp({ product: err, billingTier: 'paid' });
    expect(resolvedProduct).toBe('cloud_platform');
  });
});

describe('billing tier resolution at boot', () => {
  it('resolves "free" correctly', async () => {
    const { resolvedTier } = await createApp({ product: 'cloud_platform', billingTier: 'free' });
    expect(resolvedTier).toBe('free');
  });

  it('resolves "paid" correctly', async () => {
    const { resolvedTier } = await createApp({ product: 'cloud_platform', billingTier: 'paid' });
    expect(resolvedTier).toBe('paid');
  });

  it('defaults to "paid" on missing billing file', async () => {
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    const { resolvedTier } = await createApp({ product: 'cloud_platform', billingTier: err });
    expect(resolvedTier).toBe('paid');
  });
});

// ═════════════════════════════════════════════════════════════════════
// Permissive Engine — cloud_platform (paid)
// ═════════════════════════════════════════════════════════════════════

describe('Permissive Engine — cloud_platform paid', () => {
  let app: Awaited<ReturnType<typeof createApp>>['app'];

  beforeEach(async () => {
    ({ app } = await createApp({ product: 'cloud_platform', billingTier: 'paid' }));
  });

  it('sets product and billingTier on context', async () => {
    const res = await app.request('/health');
    const body = await res.json();
    expect(body.product).toBe('cloud_platform');
    expect(body.tier).toBe('paid');
  });

  describe('ALL routes → ALLOWED', () => {
    it('/_auth/preview/authorize → 200', async () => {
      expect((await app.request('/_auth/preview/authorize')).status).toBe(200);
    });

    it('/api/preview-url → 200', async () => {
      expect((await app.request('/api/preview-url')).status).toBe(200);
    });

    it('POST /api/workflow/expose → 200', async () => {
      expect((await app.request('/api/workflow/expose', { method: 'POST' })).status).toBe(200);
    });

    it('/_auth/exec/run → 200', async () => {
      expect((await app.request('/_auth/exec/run')).status).toBe(200);
    });

    it('/api/internal/db/query → 200', async () => {
      expect((await app.request('/api/internal/db/query', { method: 'POST' })).status).toBe(200);
    });

    it('/api/internal/gates/list → 200', async () => {
      expect((await app.request('/api/internal/gates/list')).status).toBe(200);
    });

    it('/api/internal/projects/list → 200', async () => {
      expect((await app.request('/api/internal/projects/list')).status).toBe(200);
    });

    it('/some/random/path → 200', async () => {
      expect((await app.request('/some/random/path')).status).toBe(200);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════
// Permissive Engine — cloud_platform (free) — deploy blocked
// ═════════════════════════════════════════════════════════════════════

describe('Permissive Engine — cloud_platform free', () => {
  let app: Awaited<ReturnType<typeof createApp>>['app'];

  beforeEach(async () => {
    ({ app } = await createApp({ product: 'cloud_platform', billingTier: 'free' }));
  });

  it('sets product=cloud_platform and billingTier=free', async () => {
    const res = await app.request('/health');
    const body = await res.json();
    expect(body.product).toBe('cloud_platform');
    expect(body.tier).toBe('free');
  });

  describe('preview → ALLOWED (all platform tiers can preview)', () => {
    it('/_auth/preview/authorize → 200', async () => {
      expect((await app.request('/_auth/preview/authorize')).status).toBe(200);
    });

    it('/api/preview-url → 200', async () => {
      expect((await app.request('/api/preview-url')).status).toBe(200);
    });
  });

  describe('deploy → BLOCKED (requires paid billing tier)', () => {
    it('POST /api/workflow/expose → 403', async () => {
      const res = await app.request('/api/workflow/expose', { method: 'POST' });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body).toEqual({ error: 'Deployment requires a paid tier', upgrade: true });
    });

    it('GET /api/workflow/expose → 200 (only POST is gated)', async () => {
      expect((await app.request('/api/workflow/expose')).status).toBe(200);
    });
  });

  describe('other features → ALLOWED', () => {
    it('/_auth/exec/run → 200', async () => {
      expect((await app.request('/_auth/exec/run')).status).toBe(200);
    });

    it('/api/internal/db/query → 200', async () => {
      expect((await app.request('/api/internal/db/query', { method: 'POST' })).status).toBe(200);
    });

    it('/api/internal/gates/list → 200', async () => {
      expect((await app.request('/api/internal/gates/list')).status).toBe(200);
    });

    it('/api/internal/projects/list → 200', async () => {
      expect((await app.request('/api/internal/projects/list')).status).toBe(200);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════
// Restrictive Engine — cloud_sandbox
// ═════════════════════════════════════════════════════════════════════

describe('Restrictive Engine — cloud_sandbox', () => {
  let app: Awaited<ReturnType<typeof createApp>>['app'];

  beforeEach(async () => {
    ({ app } = await createApp({ product: 'cloud_sandbox', billingTier: 'paid' }));
  });

  it('sets product=cloud_sandbox on context', async () => {
    const res = await app.request('/health');
    const body = await res.json();
    expect(body.product).toBe('cloud_sandbox');
  });

  describe('ALLOWED features', () => {
    it('/_auth/preview/authorize → 200 (preview)', async () => {
      expect((await app.request('/_auth/preview/authorize')).status).toBe(200);
    });

    it('/api/preview-url → 200 (preview)', async () => {
      expect((await app.request('/api/preview-url')).status).toBe(200);
    });

    it('/_auth/exec/run → 200 (exec)', async () => {
      expect((await app.request('/_auth/exec/run')).status).toBe(200);
    });

    it('/api/internal/gates/list → 200 (gates)', async () => {
      expect((await app.request('/api/internal/gates/list')).status).toBe(200);
    });

    it('/api/internal/projects/list → 200 (projects)', async () => {
      expect((await app.request('/api/internal/projects/list')).status).toBe(200);
    });

    it('/_auth/projects/list → 200 (projects)', async () => {
      expect((await app.request('/_auth/projects/list')).status).toBe(200);
    });
  });

  describe('BLOCKED features', () => {
    it('POST /api/workflow/expose → 403 (deploy)', async () => {
      const res = await app.request('/api/workflow/expose', { method: 'POST' });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.upgrade).toBe(true);
    });

    it('/api/internal/db/query → 403 (db)', async () => {
      expect((await app.request('/api/internal/db/query', { method: 'POST' })).status).toBe(403);
    });
  });

  describe('exempt routes → ALLOWED', () => {
    it('/health → 200', async () => {
      expect((await app.request('/health')).status).toBe(200);
    });

    it('/_auth/login/start → 200', async () => {
      expect((await app.request('/_auth/login/start')).status).toBe(200);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════
// Restrictive Engine — shield_proxy
// ═════════════════════════════════════════════════════════════════════

describe('Restrictive Engine — shield_proxy', () => {
  let app: Awaited<ReturnType<typeof createApp>>['app'];

  beforeEach(async () => {
    ({ app } = await createApp({ product: 'shield_proxy', billingTier: 'paid' }));
  });

  it('sets product=shield_proxy on context', async () => {
    const res = await app.request('/health');
    const body = await res.json();
    expect(body.product).toBe('shield_proxy');
  });

  describe('ALLOWED features', () => {
    it('/_auth/exec/run → 200 (exec)', async () => {
      expect((await app.request('/_auth/exec/run')).status).toBe(200);
    });

    it('/api/internal/gates/list → 200 (gates)', async () => {
      expect((await app.request('/api/internal/gates/list')).status).toBe(200);
    });

    it('/_auth/gates/request → 200 (gates)', async () => {
      expect((await app.request('/_auth/gates/request', { method: 'POST' })).status).toBe(200);
    });
  });

  describe('BLOCKED features', () => {
    it('/_auth/preview/authorize → 403 (preview)', async () => {
      const res = await app.request('/_auth/preview/authorize');
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.upgrade).toBe(true);
    });

    it('/api/preview-url → 403 (preview)', async () => {
      expect((await app.request('/api/preview-url')).status).toBe(403);
    });

    it('POST /api/workflow/expose → 403 (deploy)', async () => {
      expect((await app.request('/api/workflow/expose', { method: 'POST' })).status).toBe(403);
    });

    it('/api/internal/db/query → 403 (db)', async () => {
      expect((await app.request('/api/internal/db/query', { method: 'POST' })).status).toBe(403);
    });

    it('/api/internal/projects/list → 403 (projects)', async () => {
      expect((await app.request('/api/internal/projects/list')).status).toBe(403);
    });

    it('/_auth/projects/list → 403 (projects)', async () => {
      expect((await app.request('/_auth/projects/list')).status).toBe(403);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════
// Backward compatibility — missing product file
// ═════════════════════════════════════════════════════════════════════

describe('Backward compatibility — missing product file', () => {
  it('missing product + paid billing → cloud_platform permissive (all allowed)', async () => {
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    const { app, resolvedProduct, resolvedTier } = await createApp({ product: err, billingTier: 'paid' });
    expect(resolvedProduct).toBe('cloud_platform');
    expect(resolvedTier).toBe('paid');

    expect((await app.request('/_auth/preview/authorize')).status).toBe(200);
    expect((await app.request('/api/workflow/expose', { method: 'POST' })).status).toBe(200);
  });

  it('missing product + free billing → cloud_platform, deploy blocked only', async () => {
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    const { app, resolvedProduct, resolvedTier } = await createApp({ product: err, billingTier: 'free' });
    expect(resolvedProduct).toBe('cloud_platform');
    expect(resolvedTier).toBe('free');

    // Preview allowed (this is the bug fix — platform_free can preview)
    expect((await app.request('/_auth/preview/authorize')).status).toBe(200);
    // Deploy still blocked on free tier
    expect((await app.request('/api/workflow/expose', { method: 'POST' })).status).toBe(403);
  });

  it('missing both files → full permissive (cloud_platform + paid)', async () => {
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    const { app, resolvedProduct, resolvedTier } = await createApp({ product: err, billingTier: err });
    expect(resolvedProduct).toBe('cloud_platform');
    expect(resolvedTier).toBe('paid');

    expect((await app.request('/_auth/preview/authorize')).status).toBe(200);
    expect((await app.request('/api/workflow/expose', { method: 'POST' })).status).toBe(200);
    expect((await app.request('/_auth/exec/run')).status).toBe(200);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Method-specific gating
// ═════════════════════════════════════════════════════════════════════

describe('Method-specific gating', () => {
  it('GET /api/workflow/expose → 200 on restrictive product (only POST is gated)', async () => {
    const { app } = await createApp({ product: 'cloud_sandbox', billingTier: 'paid' });
    expect((await app.request('/api/workflow/expose')).status).toBe(200);
  });
});
