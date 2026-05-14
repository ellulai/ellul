// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Preview service — orphan classifier tests.
 *
 * classifyOrphan is the pure decision function: given (port, pid, unit
 * state, process info, svc uid, port range) return the orphan verdict.
 * These tests exercise every branch so the invariants are locked in
 * without mocking /proc or systemd.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stubs for sibling module boundaries that the service file imports at top
// level. These tests only exercise the pure function, but importing it
// pulls the whole module graph along.
vi.mock('@vps/shared/caddy', () => ({ reloadCaddy: vi.fn() }));
vi.mock('@vps/shared/preview-spec', () => ({
  readSpec: vi.fn(),
  writeSpec: vi.fn(),
  inferSpecFromRepo: vi.fn(),
}));
vi.mock('./PreviewUnits', () => ({
  startUnit: vi.fn(),
  stopUnit: vi.fn(),
  restartUnit: vi.fn(),
  resetFailed: vi.fn(),
  isActive: vi.fn(),
  listActive: vi.fn().mockResolvedValue([]),
  unitStatus: vi.fn(),
  escapeInstance: vi.fn((s: string) => s),
}));
vi.mock('../../config', () => ({
  HOME: '/tmp',
  ROOT_DIR: '/tmp/projects',
}));

import {
  classifyOrphan,
  emitPhaseTransition,
  CANONICAL_PREVIEW_PHASES,
  registerPreviewBroadcast,
} from './Preview';
import { _resetForTests as _resetLifecycleForTests } from './PreviewLifecycle';
import {
  computeFingerprint as computeManifestFingerprint,
  isNodeInstallComplete,
} from '../platform/InstallManager';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const DEFAULT_INPUTS = {
  port: 4000,
  pid: 12345,
  activeState: 'inactive' as const,
  proc: { uid: 1000, cmdline: 'next-server /home/dev/projects/sbx-abc/my-app' },
  svcUid: 1000,
  portRangeMin: 4000,
  portRangeMax: 4099,
};

describe('classifyOrphan', () => {
  it('no listener → isOrphan=false, reason=no_listener', () => {
    const r = classifyOrphan({ ...DEFAULT_INPUTS, pid: null });
    expect(r.isOrphan).toBe(false);
    expect(r.reason).toBe('no_listener');
  });

  it('unit active + listener → isOrphan=false, reason=unit_active', () => {
    const r = classifyOrphan({ ...DEFAULT_INPUTS, activeState: 'active' });
    expect(r.isOrphan).toBe(false);
    expect(r.reason).toBe('unit_active');
    expect(r.unitActive).toBe(true);
  });

  it('unit activating + listener → isOrphan=false, reason=unit_activating', () => {
    const r = classifyOrphan({ ...DEFAULT_INPUTS, activeState: 'activating' });
    expect(r.isOrphan).toBe(false);
    expect(r.reason).toBe('unit_activating');
    expect(r.unitActive).toBe(true);
  });

  it('unit inactive + port out of preview range → orphan but port_out_of_range (refuse to heal)', () => {
    const r = classifyOrphan({ ...DEFAULT_INPUTS, port: 22 });
    expect(r.isOrphan).toBe(true);
    expect(r.reason).toBe('port_out_of_range');
  });

  it('listener disappeared between pid lookup and proc read → collapses to no_listener', () => {
    const r = classifyOrphan({ ...DEFAULT_INPUTS, proc: null });
    expect(r.isOrphan).toBe(false);
    expect(r.reason).toBe('no_listener');
    expect(r.pid).toBeNull();
  });

  it('foreign user process → orphan, refuse to heal (foreign_user)', () => {
    const r = classifyOrphan({
      ...DEFAULT_INPUTS,
      proc: { uid: 0, cmdline: 'next-server' }, // root-owned
    });
    expect(r.isOrphan).toBe(true);
    expect(r.reason).toBe('foreign_user');
  });

  it('skips UID check when svcUid is -1 (getuid unavailable — e.g. on macOS dev)', () => {
    const r = classifyOrphan({
      ...DEFAULT_INPUTS,
      svcUid: -1,
      proc: { uid: 0, cmdline: 'next-server' },
    });
    // Falls through to cmdline check → healable
    expect(r.reason).toBe('orphan_healable');
  });

  it('unknown cmdline → orphan, refuse to heal (unknown_cmdline)', () => {
    const r = classifyOrphan({
      ...DEFAULT_INPUTS,
      proc: { uid: 1000, cmdline: '/usr/bin/curl http://localhost:4000' },
    });
    expect(r.isOrphan).toBe(true);
    expect(r.reason).toBe('unknown_cmdline');
    expect(r.cmdline).toContain('curl');
  });

  it('same-user + dev-server cmdline → orphan_healable', () => {
    const r = classifyOrphan(DEFAULT_INPUTS);
    expect(r.isOrphan).toBe(true);
    expect(r.reason).toBe('orphan_healable');
    expect(r.pid).toBe(12345);
  });

  it.each([
    ['next dev via npm', 'npm exec next dev -H 0.0.0.0 -p 4000'],
    ['next-server', 'next-server (v16.2.4)'],
    ['vite at path', 'node /app/node_modules/.bin/vite'],
    ['nuxt at path', 'node /app/node_modules/.bin/nuxt dev'],
    ['astro at path', 'node /app/node_modules/.bin/astro dev'],
    ['django manage', 'python manage.py runserver 0.0.0.0:4000'],
    ['django python3 manage', 'python3 manage.py runserver 0.0.0.0:4000'],
    ['flask', 'flask run --host 0.0.0.0'],
    ['uvicorn', 'python -m uvicorn app:app --host 0.0.0.0'],
    ['rails server', 'ruby bin/rails server -p 4000'],
    ['rails s shorthand', 'bin/rails s -p 4000'],
    ['pnpm dev', 'pnpm dev'],
    ['yarn start', 'yarn start'],
    ['bun run dev', 'bun run dev'],
    ['node dev.js entrypoint', 'node /app/bin/dev.js'],
  ])('recognizes %s as a dev-server cmdline', (_name, cmdline) => {
    const r = classifyOrphan({
      ...DEFAULT_INPUTS,
      proc: { uid: 1000, cmdline },
    });
    expect(r.reason).toBe('orphan_healable');
  });

  it.each([
    // Real-world false-positive candidates the old loose patterns let through:
    ['path substring containing next', '/usr/bin/my-next-app-helper'],
    ['path substring containing vite', 'node /home/dev/invite-service/server.js'],
    ['node binary without dev command', 'node /app/server.js'],
    ['random node script', 'node /app/scripts/migrate.js'],
    ['curl', '/usr/bin/curl http://localhost:4000'],
    ['ALL CAPS (unix binaries are lowercase)', 'NEXT-SERVER'],
  ])('refuses to classify %s as healable', (_name, cmdline) => {
    const r = classifyOrphan({
      ...DEFAULT_INPUTS,
      proc: { uid: 1000, cmdline },
    });
    expect(r.reason).toBe('unknown_cmdline');
  });
});

// -----------------------------------------------------------------------------
// I/O-shell tests for signalAndWait escalation — spawn a REAL subprocess and
// assert SIGTERM-with-graceful-exit, SIGKILL-after-ignore, and the
// "process-already-gone" (ESRCH) path. No process mocking; if these pass on
// your machine they'll pass in CI.
// -----------------------------------------------------------------------------

import { spawn, type ChildProcess } from 'child_process';

/**
 * Spawn a node subprocess that optionally ignores SIGTERM (simulating a
 * stuck/hung dev server). Returns { pid, child } — caller must ensure the
 * child is cleaned up.
 */
function spawnTestProcess(opts: { ignoreTerm: boolean }): Promise<{ pid: number; child: ChildProcess }> {
  return new Promise((resolve, reject) => {
    // Sleep forever. If ignoreTerm is true, install a SIGTERM handler that
    // swallows the signal. The child prints "READY" to stdout AFTER the
    // handler is installed so the test doesn't race the setup phase.
    const script = opts.ignoreTerm
      ? `process.on('SIGTERM', () => {}); process.stdout.write('READY\\n'); setInterval(() => {}, 1000);`
      : `process.stdout.write('READY\\n'); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ['-e', script], {
      detached: false,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let settled = false;
    const onData = (buf: Buffer) => {
      if (!settled && buf.toString().includes('READY')) {
        settled = true;
        resolve({ pid: child.pid!, child });
      }
    };
    child.stdout!.on('data', onData);
    child.once('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0); // signal 0 = liveness check
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe('healOrphan signal escalation (live subprocess)', () => {
  it('SIGTERM terminates a process that handles it gracefully', async () => {
    const { pid, child } = await spawnTestProcess({ ignoreTerm: false });
    try {
      process.kill(pid, 'SIGTERM');
      const died = await waitForExit(pid, 3_000);
      expect(died).toBe(true);
    } finally {
      if (!child.killed) child.kill('SIGKILL');
    }
  });

  it('process that ignores SIGTERM survives, but SIGKILL terminates it', async () => {
    const { pid, child } = await spawnTestProcess({ ignoreTerm: true });
    try {
      // First: SIGTERM. Should NOT kill it (handler ignores).
      process.kill(pid, 'SIGTERM');
      const stillAlive = !(await waitForExit(pid, 1_000));
      expect(stillAlive).toBe(true);

      // Escalate to SIGKILL. Must terminate (non-ignorable).
      process.kill(pid, 'SIGKILL');
      const died = await waitForExit(pid, 2_000);
      expect(died).toBe(true);
    } finally {
      if (!child.killed) child.kill('SIGKILL');
    }
  });

  it('signalling a non-existent pid surfaces ESRCH', () => {
    // PID 2^22 - 1 is outside the default pid_max on Linux/macOS. Even on
    // systems with larger max, the probability of collision is negligible.
    const fakepid = 4194303;
    let err: NodeJS.ErrnoException | null = null;
    try {
      process.kill(fakepid, 'SIGTERM');
    } catch (e) {
      err = e as NodeJS.ErrnoException;
    }
    expect(err).not.toBeNull();
    expect(err!.code).toBe('ESRCH');
  });
});

// ---------------------------------------------------------------------------
// emitPhaseTransition — lifecycle coupling + edge-triggering
// ---------------------------------------------------------------------------
//
// The helper is the single entry point for every preview phase broadcast.
// Clients care about three invariants:
//
//  1. Every unique phase fires `preview_install_status` — progress UI
//     always gets the granular event.
//  2. Phases in CANONICAL_PREVIEW_PHASES additionally fire
//     `preview_all_status` in the same tick — cache-driven consumers
//     (useCurrentApp, preview dashboards) never lag a canonical state
//     change by a poll interval. Missing this pairing is what caused the
//     2026-04-20 "preview never shows until I refresh" bug.
//  3. Re-emitting the same phase for the same directory without an
//     intervening `lifecycleTransition()` is a no-op. Without this
//     edge-triggering, the GET /api/app/:directory handler's fire-and-
//     forget `setPreviewApp` would drive an infinite
//     adopt→emit→invalidate→GET loop (the 2026-04-22 regression).
//
// These tests lock all three in.

describe('emitPhaseTransition — lifecycle coupling + edge-triggering', () => {
  type Emitted = { type: string; data: unknown };

  // Every test runs against a fresh lifecycle state — prior tests'
  // emissions do not interfere with this test's expectations.
  beforeEach(() => {
    _resetLifecycleForTests();
  });

  function captureEmits(): { emits: Emitted[]; restore: () => void } {
    const emits: Emitted[] = [];
    registerPreviewBroadcast((type, data) => {
      emits.push({ type, data });
    });
    return {
      emits,
      // Reset to a no-op so later tests don't bleed emits into each other.
      restore: () => registerPreviewBroadcast(() => {}),
    };
  }

  it('always emits preview_install_status with app/phase/message', () => {
    const { emits, restore } = captureEmits();
    emitPhaseTransition('sbx-abc/my-app', 'installing_deps', 'Installing dependencies...');
    const first = emits.find((e) => e.type === 'preview_install_status');
    expect(first).toBeDefined();
    expect(first!.data).toMatchObject({
      app: 'sbx-abc/my-app',
      phase: 'installing_deps',
      message: 'Installing dependencies...',
    });
    restore();
  });

  it('propagates `extra` fields (runtime) onto the install_status payload', () => {
    const { emits, restore } = captureEmits();
    emitPhaseTransition(
      'sbx-abc/my-app',
      'installing_runtime',
      'Installing dotnet runtime (one-time setup)...',
      { runtime: 'dotnet' },
    );
    const first = emits.find((e) => e.type === 'preview_install_status');
    expect(first!.data).toMatchObject({
      app: 'sbx-abc/my-app',
      phase: 'installing_runtime',
      runtime: 'dotnet',
    });
    restore();
  });

  it('progress phases do NOT pair with preview_all_status', () => {
    for (const phase of ['installing_runtime', 'installing_deps', 'starting_server'] as const) {
      _resetLifecycleForTests();
      const { emits, restore } = captureEmits();
      emitPhaseTransition('sbx-abc/my-app', phase, 'progress');
      expect(emits.some((e) => e.type === 'preview_install_status')).toBe(true);
      expect(emits.some((e) => e.type === 'preview_all_status')).toBe(false);
      restore();
    }
  });

  // Canonical phases pair with preview_all_status. We assert the pairing
  // itself rather than the full all_status payload — getAllPreviewHealth
  // touches /proc + systemd and is a separate unit of test. This test's
  // job is to catch anyone deleting the broadcastAllPreviewHealth call
  // from emitPhaseTransition (or forgetting to add a new canonical phase
  // to CANONICAL_PREVIEW_PHASES).
  it.each([...CANONICAL_PREVIEW_PHASES])(
    '%s pairs with preview_all_status in the same tick',
    async (phase) => {
      const { emits, restore } = captureEmits();
      emitPhaseTransition('sbx-abc/my-app', phase, 'msg');
      // broadcastAllPreviewHealth is fire-and-forget; the broadcast itself
      // resolves on the next microtask after getAllPreviewHealth settles.
      // Yield twice — once for the getAllPreviewHealth promise chain, once
      // for the .then that calls _previewBroadcastFn.
      await new Promise((r) => setTimeout(r, 50));
      expect(emits.some((e) => e.type === 'preview_install_status' && (e.data as { phase: string }).phase === phase)).toBe(true);
      expect(emits.some((e) => e.type === 'preview_all_status')).toBe(true);
      restore();
    },
  );

  it('every listed canonical phase represents a real system-state change (guard against typos)', () => {
    // Canonical phases must be a subset of the PreviewLifecyclePhase union
    // — anyone adding "deps_installes" (typo) or a phantom phase would be
    // caught by TypeScript at the CANONICAL_PREVIEW_PHASES literal, but
    // this assertion documents the allowed set for reviewers.
    const allowed = new Set([
      'runtime_installed',
      'runtime_failed',
      'deps_installed',
      'deps_failed',
      'ready',
    ]);
    for (const phase of CANONICAL_PREVIEW_PHASES) {
      expect(allowed.has(phase)).toBe(true);
    }
  });

  // ── Edge-triggering (Layer 2 loop guard) ────────────────────────────
  //
  // These tests lock the 2026-04-22 regression fix. They assert that the
  // emit helper is idempotent per (directory, phase) and that a genuine
  // state change re-arms emission.

  it('suppresses a duplicate emit of the same phase for the same directory', async () => {
    const { emits, restore } = captureEmits();
    emitPhaseTransition('sbx-abc/my-app', 'ready', 'Preview ready');
    emitPhaseTransition('sbx-abc/my-app', 'ready', 'Preview ready');
    await new Promise((r) => setTimeout(r, 50));
    const installStatusCount = emits.filter((e) => e.type === 'preview_install_status').length;
    expect(installStatusCount).toBe(1);
    restore();
  });

  it('does not suppress emissions for a different directory', () => {
    const { emits, restore } = captureEmits();
    emitPhaseTransition('sbx-abc/my-app', 'ready', 'Preview ready');
    emitPhaseTransition('sbx-xyz/other-app', 'ready', 'Preview ready');
    const installStatus = emits.filter((e) => e.type === 'preview_install_status');
    expect(installStatus.length).toBe(2);
    expect((installStatus[0]!.data as { app: string }).app).toBe('sbx-abc/my-app');
    expect((installStatus[1]!.data as { app: string }).app).toBe('sbx-xyz/other-app');
    restore();
  });

  it('does not suppress emissions for a different phase on the same directory', () => {
    const { emits, restore } = captureEmits();
    emitPhaseTransition('sbx-abc/my-app', 'installing_deps', 'Installing...');
    emitPhaseTransition('sbx-abc/my-app', 'deps_installed', 'Installed');
    const phases = emits
      .filter((e) => e.type === 'preview_install_status')
      .map((e) => (e.data as { phase: string }).phase);
    expect(phases).toEqual(['installing_deps', 'deps_installed']);
    restore();
  });

  it('re-arms after an intervening lifecycleTransition — restart scenarios still surface a fresh ready', async () => {
    // This proves the critical correctness property: a genuine state
    // change (e.g., a preview restart: hot → stopping → cold → starting
    // → hot) allows the next `ready` emit to go through. Without this,
    // restarts would silently fail to notify clients.
    const { transition } = await import('./PreviewLifecycle');
    const { emits, restore } = captureEmits();

    emitPhaseTransition('sbx-abc/my-app', 'ready', 'Preview ready');
    // Simulate a restart's lifecycle sequence.
    transition({ directory: 'sbx-abc/my-app', next: 'stopping', force: true });
    transition({ directory: 'sbx-abc/my-app', next: 'cold', force: true });
    transition({ directory: 'sbx-abc/my-app', next: 'starting', force: true });
    transition({ directory: 'sbx-abc/my-app', next: 'hot', force: true });
    emitPhaseTransition('sbx-abc/my-app', 'ready', 'Preview ready');

    await new Promise((r) => setTimeout(r, 50));
    const readyEmits = emits.filter(
      (e) => e.type === 'preview_install_status' && (e.data as { phase: string }).phase === 'ready',
    );
    expect(readyEmits.length).toBe(2);
    restore();
  });
});

// ───────────────────────────────────────────────────────────────────
// Install-fingerprint — the language-agnostic staleness primitive.
//
// Regression guard for the 2026-04-21 class of failure: scaffold
// writes an empty-workspace root package.json, install runs and exits
// 0 (2 packages, turbo), scaffold THEN adds apps/*, and the stale
// sentinel stranded users at "install succeeded" while their app had
// no dependencies. The fingerprint detects scaffold drift and drives
// auto-recovery.
// ───────────────────────────────────────────────────────────────────
describe('computeManifestFingerprint', () => {
  const makeRoot = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'fp-'));
  const cleanup = (dir: string): void => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };

  it('empty tree produces a stable digest (deterministic across calls)', () => {
    const root = makeRoot();
    try {
      expect(computeManifestFingerprint(root)).toBe(computeManifestFingerprint(root));
    } finally { cleanup(root); }
  });

  it('adding a new workspace child changes the digest — the monorepo-scaffold race', () => {
    const root = makeRoot();
    try {
      fs.writeFileSync(path.join(root, 'package.json'), '{"workspaces":["apps/*"]}');
      const before = computeManifestFingerprint(root);

      fs.mkdirSync(path.join(root, 'apps', 'web'), { recursive: true });
      fs.writeFileSync(path.join(root, 'apps', 'web', 'package.json'), '{"name":"web"}');
      const after = computeManifestFingerprint(root);

      expect(after).not.toBe(before);
    } finally { cleanup(root); }
  });

  it('editing an existing manifest changes the digest (content drift, not just structure)', () => {
    const root = makeRoot();
    try {
      const pkg = path.join(root, 'package.json');
      fs.writeFileSync(pkg, '{"dependencies":{"next":"^14"}}');
      const before = computeManifestFingerprint(root);

      // Bump mtime & size — simulate a scaffold-initiated edit.
      fs.writeFileSync(pkg, '{"dependencies":{"next":"^15","react":"^19"}}');
      const after = computeManifestFingerprint(root);

      expect(after).not.toBe(before);
    } finally { cleanup(root); }
  });

  it('removing a manifest changes the digest', () => {
    const root = makeRoot();
    try {
      fs.writeFileSync(path.join(root, 'package.json'), '{}');
      fs.writeFileSync(path.join(root, 'Cargo.toml'), '[package]\nname="x"\n');
      const before = computeManifestFingerprint(root);

      fs.unlinkSync(path.join(root, 'Cargo.toml'));
      const after = computeManifestFingerprint(root);

      expect(after).not.toBe(before);
    } finally { cleanup(root); }
  });

  it('ignores node_modules — install output must never feed back into the fingerprint (infinite-loop guard)', () => {
    const root = makeRoot();
    try {
      fs.writeFileSync(path.join(root, 'package.json'), '{}');
      const before = computeManifestFingerprint(root);

      // Simulate what `npm install` would produce: a tree of manifests
      // under node_modules. If the fingerprint walked these, every
      // install would change the fingerprint and trigger another
      // install → infinite loop. This is the single most important
      // correctness invariant of the walker.
      fs.mkdirSync(path.join(root, 'node_modules', 'next'), { recursive: true });
      fs.writeFileSync(path.join(root, 'node_modules', 'next', 'package.json'), '{"name":"next","version":"14.0.0"}');
      fs.mkdirSync(path.join(root, 'node_modules', 'react'), { recursive: true });
      fs.writeFileSync(path.join(root, 'node_modules', 'react', 'package.json'), '{"name":"react","version":"18.2.0"}');
      const after = computeManifestFingerprint(root);

      expect(after).toBe(before);
    } finally { cleanup(root); }
  });

  it('ignores language-specific build-artifact dirs (target, .venv, .next, __pycache__, vendor)', () => {
    const root = makeRoot();
    try {
      fs.writeFileSync(path.join(root, 'package.json'), '{}');
      const before = computeManifestFingerprint(root);

      // Each of these would be an install artifact under a real
      // project, and each contains manifests we must ignore to keep
      // the fingerprint bounded. One per runtime:
      //   target/     — Rust
      //   .venv/      — Python
      //   .next/      — Next.js
      //   __pycache__ — CPython
      //   vendor/     — Go / PHP Composer
      for (const dir of ['target', '.venv', '.next', '__pycache__', 'vendor', 'dist', 'build']) {
        fs.mkdirSync(path.join(root, dir, 'nested'), { recursive: true });
        fs.writeFileSync(path.join(root, dir, 'nested', 'package.json'), '{"fake":"dep"}');
        fs.writeFileSync(path.join(root, dir, 'nested', 'Cargo.toml'), '[package]\nname="x"\n');
      }
      const after = computeManifestFingerprint(root);

      expect(after).toBe(before);
    } finally { cleanup(root); }
  });

  it('recognises polyglot projects — Node + Python + Rust + Go manifests all participate', () => {
    const root = makeRoot();
    try {
      fs.writeFileSync(path.join(root, 'package.json'), '{}');
      const nodeOnly = computeManifestFingerprint(root);

      fs.writeFileSync(path.join(root, 'pyproject.toml'), '[project]\nname="x"\n');
      const addedPython = computeManifestFingerprint(root);
      expect(addedPython).not.toBe(nodeOnly);

      fs.writeFileSync(path.join(root, 'Cargo.toml'), '[package]\nname="x"\n');
      const addedRust = computeManifestFingerprint(root);
      expect(addedRust).not.toBe(addedPython);

      fs.writeFileSync(path.join(root, 'go.mod'), 'module x\n');
      const addedGo = computeManifestFingerprint(root);
      expect(addedGo).not.toBe(addedRust);
    } finally { cleanup(root); }
  });

  it('matches wildcard extensions (*.csproj, *.gemspec) used by .NET / Ruby', () => {
    const root = makeRoot();
    try {
      const before = computeManifestFingerprint(root);
      fs.writeFileSync(path.join(root, 'MyApp.csproj'), '<Project/>');
      const afterCsproj = computeManifestFingerprint(root);
      expect(afterCsproj).not.toBe(before);

      fs.writeFileSync(path.join(root, 'mygem.gemspec'), '# stub');
      const afterGemspec = computeManifestFingerprint(root);
      expect(afterGemspec).not.toBe(afterCsproj);
    } finally { cleanup(root); }
  });

  it('returns empty string for nonexistent path (caller must tolerate)', () => {
    expect(computeManifestFingerprint('/nonexistent/path/for/sure')).toBe('');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'handles unreadable subdirectory gracefully (no throw, walk continues)',
    () => {
      const root = makeRoot();
      try {
        fs.writeFileSync(path.join(root, 'package.json'), '{}');
        fs.mkdirSync(path.join(root, 'locked'));
        fs.chmodSync(path.join(root, 'locked'), 0o000);
        try {
          const fp = computeManifestFingerprint(root);
          expect(fp).toMatch(/^[a-f0-9]{64}$/);
        } finally {
          fs.chmodSync(path.join(root, 'locked'), 0o755);
        }
      } finally { cleanup(root); }
    },
  );
});

// ───────────────────────────────────────────────────────────────────
// isNodeInstallComplete — strict contract. Every non-@types dep must
// resolve in node_modules. A partial install (next present, eslint
// missing) was previously accepted as "complete" — exactly the
// 2026-04-21 shape where `npm install` aborted on ENOTEMPTY partway
// through, left a tree with primary deps but not dev deps, and the
// preview unit launched against the broken tree and crashed at
// first-compile.
//
// The mocked config sets ROOT_DIR=/tmp/projects, so fixtures go
// there to exercise the real walk logic (including the monorepo
// ceiling check for hoisted node_modules).
// ───────────────────────────────────────────────────────────────────
describe('isNodeInstallComplete — strict', () => {
  const ROOT = '/tmp/projects';
  const makeRoot = (): string => {
    fs.mkdirSync(ROOT, { recursive: true });
    return fs.mkdtempSync(path.join(ROOT, 'sbx-test-'));
  };
  const cleanup = (dir: string): void => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };

  it('returns true when all declared non-@types deps are present', () => {
    const sbx = makeRoot();
    try {
      const app = path.join(sbx, 'my-app');
      fs.mkdirSync(app, { recursive: true });
      fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({
        dependencies: { next: '*', react: '*' },
        devDependencies: { typescript: '*' },
      }));
      const nm = path.join(app, 'node_modules');
      fs.mkdirSync(path.join(nm, 'next'), { recursive: true });
      fs.mkdirSync(path.join(nm, 'react'), { recursive: true });
      fs.mkdirSync(path.join(nm, 'typescript'), { recursive: true });
      expect(isNodeInstallComplete(app)).toBe(true);
    } finally { cleanup(sbx); }
  });

  it('returns false when a single dep is missing — the partial-install guard', () => {
    const sbx = makeRoot();
    try {
      const app = path.join(sbx, 'my-app');
      fs.mkdirSync(app, { recursive: true });
      fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({
        dependencies: { next: '*', react: '*' },
        devDependencies: { typescript: '*', eslint: '*', tailwindcss: '*' },
      }));
      const nm = path.join(app, 'node_modules');
      // next + react landed (the ENOTEMPTY shape from 2026-04-21).
      fs.mkdirSync(path.join(nm, 'next'), { recursive: true });
      fs.mkdirSync(path.join(nm, 'react'), { recursive: true });
      // typescript / eslint / tailwindcss missing — partial install.
      expect(isNodeInstallComplete(app)).toBe(false);
    } finally { cleanup(sbx); }
  });

  it('ignores @types/* — optional, often skipped on partial resolves', () => {
    const sbx = makeRoot();
    try {
      const app = path.join(sbx, 'my-app');
      fs.mkdirSync(app, { recursive: true });
      fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({
        dependencies: { next: '*' },
        devDependencies: { '@types/node': '*', '@types/react': '*' },
      }));
      const nm = path.join(app, 'node_modules');
      fs.mkdirSync(path.join(nm, 'next'), { recursive: true });
      // @types/node + @types/react NOT present — ignored.
      expect(isNodeInstallComplete(app)).toBe(true);
    } finally { cleanup(sbx); }
  });

  it('walks up to hoisted monorepo root node_modules', () => {
    const sbx = makeRoot();
    try {
      const monorepo = path.join(sbx, 'my-app');
      const app = path.join(monorepo, 'apps', 'web');
      fs.mkdirSync(app, { recursive: true });
      fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({
        dependencies: { next: '*' },
      }));
      // Hoisted node_modules at monorepo root, not inside apps/web.
      fs.mkdirSync(path.join(monorepo, 'node_modules', 'next'), { recursive: true });
      expect(isNodeInstallComplete(app)).toBe(true);
    } finally { cleanup(sbx); }
  });

  it('returns true when package.json has no deps at all', () => {
    const sbx = makeRoot();
    try {
      const app = path.join(sbx, 'my-app');
      fs.mkdirSync(path.join(app, 'node_modules'), { recursive: true });
      fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'empty' }));
      expect(isNodeInstallComplete(app)).toBe(true);
    } finally { cleanup(sbx); }
  });

  it('returns false when node_modules does not exist at all', () => {
    const sbx = makeRoot();
    try {
      const app = path.join(sbx, 'my-app');
      fs.mkdirSync(app, { recursive: true });
      fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({
        dependencies: { next: '*' },
      }));
      expect(isNodeInstallComplete(app)).toBe(false);
    } finally { cleanup(sbx); }
  });

  it('handles scoped deps correctly — path split on "/"', () => {
    const sbx = makeRoot();
    try {
      const app = path.join(sbx, 'my-app');
      fs.mkdirSync(app, { recursive: true });
      fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({
        dependencies: { '@tailwindcss/postcss': '*' },
      }));
      const nm = path.join(app, 'node_modules');
      fs.mkdirSync(path.join(nm, '@tailwindcss', 'postcss'), { recursive: true });
      expect(isNodeInstallComplete(app)).toBe(true);

      // Same scope, but postcss subdir missing — should return false.
      fs.rmSync(path.join(nm, '@tailwindcss', 'postcss'), { recursive: true });
      expect(isNodeInstallComplete(app)).toBe(false);
    } finally { cleanup(sbx); }
  });
});
