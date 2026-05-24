// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Sandbox-delete state-machine tests.
 *
 * Full end-to-end mocking of systemctl / Shield is out of scope —
 * those are exercised in the deployment smoke suite. Here we verify
 * the pieces that are pure TS logic and matter for correctness
 * guarantees documented in the module header:
 *
 *   - preflight rejects traversal / absolute / outside-root
 *   - metrics counters bump on every start / complete / fail
 *   - the coordinator is idempotent across concurrent calls via the
 *     per-directory mutex
 *   - partial failures return failedAt + steps for surfacing to the
 *     HTTP caller
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { deleteApp, type DeleteContext } from './SandboxDelete';
import { _resetMutexForTests } from '../preview/PreviewMutex';
import { _resetMetricsForTests, snapshot as metricsSnapshot } from '../preview/PreviewMetrics';
import { _resetTrackingForTests } from '../preview/PreviewTracking';

// Mock systemd layer — always reports inactive so drain + verify pass.
vi.mock('../preview/PreviewUnits', () => ({
  stopUnit: vi.fn(async (_directory: string) => {}),
  unitStatus: vi.fn(async (_directory: string) => ({
    ActiveState: 'inactive',
    SubState: 'dead',
    Result: 'success',
    ExecMainStatus: '0',
  })),
  escapeInstance: (s: string) => s.replace(/-/g, '\\x2d').replace(/\//g, '-'),
}));

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-delete-'));

function makeSandbox(root: string, dir: string): void {
  const abs = path.join(root, dir);
  fs.mkdirSync(abs, { recursive: true });
  fs.writeFileSync(path.join(abs, 'ellul.json'), '{}');
}

function makeCtx(): DeleteContext {
  return {
    log: () => {},
    releaseRoutes: async () => [],
    releasePort: () => {},
  };
}

describe('sandbox-delete preflight invariants', () => {
  let root: string;

  beforeEach(() => {
    _resetMutexForTests();
    _resetMetricsForTests();
    _resetTrackingForTests();
    root = tmp();
  });

  afterEach(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  });

  it('rejects path traversal', async () => {
    const result = await deleteApp('../escape', makeCtx(), root);
    expect(result.ok).toBe(false);
    expect(result.failedAt).toBe('preflight');
  });

  it('rejects absolute paths', async () => {
    const result = await deleteApp('/etc/passwd', makeCtx(), root);
    expect(result.ok).toBe(false);
    expect(result.failedAt).toBe('preflight');
  });

  it('rejects empty directory string', async () => {
    const result = await deleteApp('', makeCtx(), root);
    expect(result.ok).toBe(false);
    expect(result.failedAt).toBe('preflight');
  });

  it('accepts nested sandbox/app paths', async () => {
    // Preflight should not reject `sbx-a/my-app` — the nested form.
    // We stop at 'remove' failing because fs is empty, but preflight
    // must pass through.
    const result = await deleteApp('sbx-a/my-app', makeCtx(), root);
    // preflight succeeded; any later step may or may not fail.
    const preflight = result.steps.find(s => s.step === 'preflight');
    expect(preflight?.ok).toBe(true);
  });
});

describe('sandbox-delete metrics', () => {
  let root: string;

  beforeEach(() => {
    _resetMutexForTests();
    _resetMetricsForTests();
    _resetTrackingForTests();
    root = tmp();
  });

  afterEach(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  });

  it('bumps start + fail on preflight rejection', async () => {
    await deleteApp('../escape', makeCtx(), root);
    const s = metricsSnapshot();
    expect(s.delete.started).toBe(1);
    expect(s.delete.failed).toBe(1);
    expect(s.delete.completed).toBe(0);
    expect(s.delete.stepFailures['preflight']).toBe(1);
  });

  it('aggregates step failures by step id', async () => {
    await deleteApp('../a', makeCtx(), root);
    await deleteApp('../b', makeCtx(), root);
    const s = metricsSnapshot();
    expect(s.delete.stepFailures['preflight']).toBe(2);
  });
});

describe('sandbox-delete concurrency', () => {
  let root: string;

  beforeEach(() => {
    _resetMutexForTests();
    _resetMetricsForTests();
    _resetTrackingForTests();
    root = tmp();
  });

  afterEach(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  });

  it('serializes two DELETEs against the same directory', async () => {
    // Both reject at preflight with same input, so ordering doesn't
    // matter for the outcome — but the mutex must not deadlock, and
    // each one records its own start+fail in metrics.
    const [a, b] = await Promise.all([
      deleteApp('../x', makeCtx(), root),
      deleteApp('../x', makeCtx(), root),
    ]);
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    const s = metricsSnapshot();
    expect(s.delete.started).toBe(2);
    expect(s.delete.failed).toBe(2);
  });
});
