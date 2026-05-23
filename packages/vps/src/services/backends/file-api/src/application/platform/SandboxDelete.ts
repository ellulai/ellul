// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// never sees a ghost)

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

import { PREVIEW_LIMITS } from '@vps/shared/constants';

import { previewPlatform } from '../preview/PreviewPlatform';
import { recordStop } from '../preview/PreviewTracking';
import { withPreviewLock } from '../preview/PreviewMutex';
import { deleteMetrics } from '../preview/PreviewMetrics';
import { portRegistryKeysForPrefix } from '../preview/Preview';

// Paths derived from HOME at call time, not load time. Lets tests set
const getHome = (): string => process.env['HOME'] || '/home/dev';
const getDefaultRoot = (): string => path.resolve(getHome(), 'projects');
const getInstallMarkerDir = (): string => path.resolve(getHome(), '.ellul/apps');

export type DeleteStepId =
  | 'preflight'
  | 'drain'
  | 'release'
  | 'markers'
  | 'remove'
  | 'verify'
  | 'systemd-gc';

export interface DeleteStepResult {
  step: DeleteStepId;
  ok: boolean;
  // Seconds to execute (for observability).
  elapsedMs: number;
  // Non-fatal warnings — e.g. file-didn't-exist on a markers rm.
  warnings: string[];
  // The raw error if !ok.
  error?: string;
}

export interface DeleteResult {
  directory: string;
  ok: boolean;
  steps: DeleteStepResult[];
  // The first failed step, if any — convenient for error surfacing.
  failedAt?: DeleteStepId;
}

export interface DeleteContext {
  // Caller-provided logger.
  log: (level: 'info' | 'warn' | 'error', msg: string, ctx?: Record<string, unknown>) => void;
  // Passed in because Caddy state lives in the caller; we don't want
  releaseRoutes: () => Promise<string[] /* warnings */>;
  // Called during step 'release' to free the port registry entry.
  releasePort: () => void;
  // pass because shield already removed the tree. Pass true when
  skipFsRm?: boolean;
}

// Public entrypoint.
export async function deleteApp(
  directory: string,
  ctx: DeleteContext,
  root: string = getDefaultRoot(),
): Promise<DeleteResult> {
  // same sandbox would otherwise race each other's `fs.rm` and
  deleteMetrics.start();
  try {
    const result = await withPreviewLock(
      directory,
      PREVIEW_LIMITS.DELETE_STOP_TIMEOUT_MS * 3,
      () => deleteCore(directory, ctx, root),
    );
    if (result.ok) deleteMetrics.complete();
    else deleteMetrics.fail(result.failedAt ?? 'unknown');
    return result;
  } catch (err) {
    deleteMetrics.fail('mutex-timeout');
    throw err;
  }
}

async function deleteCore(
  directory: string,
  ctx: DeleteContext,
  root: string,
): Promise<DeleteResult> {
  const result: DeleteResult = {
    directory,
    ok: true,
    steps: [],
  };

  // 1. preflight — normalize + safety
  const preflight = await runStep('preflight', async () => {
    if (!directory || directory.includes('..') || path.isAbsolute(directory)) {
      throw new Error(`unsafe directory: ${directory}`);
    }
    const abs = path.join(root, directory);
    // don't trip the prefix check at test time.
    try {
      const realRoot = fs.realpathSync(root);
      const real = fs.realpathSync(abs);
      if (!real.startsWith(realRoot + path.sep) && real !== realRoot) {
        throw new Error(`directory outside root: ${real}`);
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw err;
    }
    return { warnings: [] };
  });
  result.steps.push(preflight);
  if (!preflight.ok) return fail(result, 'preflight');

  // children — deleting `sbx-xyz` must stop `sbx-xyz/my-app`)
  const drain = await runStep('drain', async () => {
    const warnings: string[] = [];
    const targets = targetInstancesFor(directory, root);
    for (const t of targets) {
      try {
        await previewPlatform.stopUnit(t);
      } catch (err) {
        warnings.push(`stopUnit(${t}) failed: ${(err as Error).message}`);
      }
      recordStop(t);
      await waitForInactive(t, PREVIEW_LIMITS.DELETE_STOP_TIMEOUT_MS, warnings);
      // Clear the framework cgroup dropin so /etc/systemd/system/ellul-preview@<inst>.service.d/
      // doesn't accumulate stale framework caps after the project's gone.
      try {
        const cleared = await previewPlatform.clearFrameworkDropin(t);
        if (!cleared.ok) warnings.push(`clearFrameworkDropin(${t}) failed: ${cleared.error ?? 'unknown'}`);
      } catch (err) {
        warnings.push(`clearFrameworkDropin(${t}) errored: ${(err as Error).message}`);
      }
    }
    return { warnings };
  });
  result.steps.push(drain);
  if (!drain.ok) return fail(result, 'drain');

  // 3. release — Caddy, ports, snapshot, active-pointer
  const release = await runStep('release', async () => {
    const warnings: string[] = [];
    try {
      const ww = await ctx.releaseRoutes();
      warnings.push(...ww);
    } catch (err) {
      warnings.push(`releaseRoutes failed: ${(err as Error).message}`);
    }
    try {
      ctx.releasePort();
    } catch (err) {
      warnings.push(`releasePort failed: ${(err as Error).message}`);
    }
    try {
      const previewAppPath = path.join(getHome(), '.ellul', 'preview-app');
      const marker = fs.readFileSync(previewAppPath, 'utf8').trim();
      if (marker && (marker === directory || marker.startsWith(directory + '/'))) {
        fs.writeFileSync(previewAppPath, '');
        ctx.log('info', 'sandbox-delete: cleared stale preview-app marker', { marker, directory });
      }
    } catch {}
    return { warnings };
  });
  result.steps.push(release);
  if (!release.ok) return fail(result, 'release');

  // 4. markers — ~/.ellul/apps/<dir>__<app>.install.*  and any
  const markers = await runStep('markers', async () => {
    const warnings: string[] = [];
    try {
      if (fs.existsSync(getInstallMarkerDir())) {
        const prefix = directory.replace(/\//g, '__') + '__';
        const bareSandbox = directory.replace(/\//g, '__');
        const entries = fs.readdirSync(getInstallMarkerDir());
        for (const name of entries) {
          if (
            name.startsWith(prefix) ||
            name === `${bareSandbox}.install.log` ||
            name === `${bareSandbox}.install.exit` ||
            name === `${bareSandbox}.install.lock` ||
            name.startsWith(`${bareSandbox}.`) ||
            name.startsWith(`${bareSandbox}__`)
          ) {
            try {
              fs.unlinkSync(path.join(getInstallMarkerDir(), name));
            } catch (err: unknown) {
              const code = (err as NodeJS.ErrnoException).code;
              if (code !== 'ENOENT') {
                warnings.push(`unlink ${name}: ${(err as Error).message}`);
              }
            }
          }
        }
      }
    } catch (err) {
      warnings.push(`marker scan failed: ${(err as Error).message}`);
    }
    return { warnings };
  });
  result.steps.push(markers);
  if (!markers.ok) return fail(result, 'markers');

  // 5. remove — rm -rf app dir (retried)
  const remove = await runStep('remove', async () => {
    if (ctx.skipFsRm) return { warnings: ['skipFsRm=true — shield-side delete already removed tree'] };
    const abs = path.join(root, directory);
    if (!fs.existsSync(abs)) return { warnings: ['directory already absent'] };
    const warnings: string[] = [];
    try {
      await withRetry('fs.rm', async () => {
        fs.rmSync(abs, { recursive: true, force: true });
        if (fs.existsSync(abs)) {
          throw new Error(`fs.rm reported success but ${abs} still exists`);
        }
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES' || (err as Error).message?.includes('EPERM') || (err as Error).message?.includes('EACCES')) {
        warnings.push(`fs.rm EPERM — escalating to root via spawn-scope`);
        const sanitized = directory.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
        execSync(
          `sudo /usr/local/bin/ellul-spawn-scope ellul-user-workload.slice ellul-install-rm-${sanitized} '' -- /bin/rm -rf '${abs.replace(/'/g, "'\\''")}'`,
          { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        if (fs.existsSync(abs)) {
          throw new Error(`root rm -rf reported success but ${abs} still exists`);
        }
      } else {
        throw err;
      }
    }
    return { warnings };
  });
  result.steps.push(remove);
  if (!remove.ok) return fail(result, 'remove');

  // 6. verify — cross-check everything is actually gone
  const verify = await runStep('verify', async () => {
    const warnings: string[] = [];
    const abs = path.join(root, directory);
    if (!ctx.skipFsRm && fs.existsSync(abs)) {
      throw new Error(`post-delete: ${abs} still exists`);
    }
    // Any unit still active for this directory or its children?
    for (const t of targetInstancesFor(directory, root)) {
      const st = await previewPlatform.unitStatus(t).catch(() => null);
      if (st && (st.ActiveState === 'active' || st.ActiveState === 'activating')) {
        throw new Error(`post-delete: unit ${t} is still ${st.ActiveState}`);
      }
    }
    return { warnings };
  });
  result.steps.push(verify);
  if (!verify.ok) return fail(result, 'verify');

  // 7. systemd-gc — reset-failed so the unit is not re-resurrected
  const gc = await runStep('systemd-gc', async () => {
    const warnings: string[] = [];
    for (const t of targetInstancesFor(directory, root)) {
      try {
        await previewPlatform.resetFailed(t);
      } catch (err) {
        warnings.push(`reset-failed ${t}: ${(err as Error).message}`);
      }
    }
    return { warnings };
  });
  result.steps.push(gc);
  if (!gc.ok) return fail(result, 'systemd-gc');

  ctx.log('info', 'sandbox-delete: completed', {
    directory,
    steps: result.steps.map(s => ({ step: s.step, ms: s.elapsedMs })),
  });
  return result;
}

// ── Step helpers ────────────────────────────────────────────────

async function runStep(
  step: DeleteStepId,
  body: () => Promise<{ warnings: string[] }>,
): Promise<DeleteStepResult> {
  const t0 = Date.now();
  try {
    const { warnings } = await body();
    return { step, ok: true, elapsedMs: Date.now() - t0, warnings };
  } catch (err) {
    return {
      step,
      ok: false,
      elapsedMs: Date.now() - t0,
      warnings: [],
      error: (err as Error).message,
    };
  }
}

function fail(result: DeleteResult, step: DeleteStepId): DeleteResult {
  result.ok = false;
  result.failedAt = step;
  return result;
}

async function waitForInactive(
  directory: string,
  timeoutMs: number,
  warnings: string[],
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const st = await previewPlatform.unitStatus(directory);
      if (!st || st.ActiveState === 'inactive' || st.ActiveState === 'failed') return;
    } catch {
      return; // no unit / can't query → treat as inactive
    }
    await sleep(200);
  }
  warnings.push(`unit for ${directory} still active after ${timeoutMs}ms — systemd KillMode=mixed will enforce`);
}

async function withRetry(label: string, fn: () => Promise<void>): Promise<void> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < PREVIEW_LIMITS.DELETE_RETRY_ATTEMPTS; attempt++) {
    try {
      await fn();
      return;
    } catch (err) {
      lastErr = err as Error;
      const code = (err as NodeJS.ErrnoException).code;
      // Non-retriable paths: refuse to spin on a genuine hard error
      if (code === 'EPERM' || code === 'EACCES') break;
      const backoff = PREVIEW_LIMITS.DELETE_RETRY_BASE_BACKOFF_MS * Math.pow(2, attempt);
      await sleep(backoff);
    }
  }
  throw lastErr ?? new Error(`${label} failed after ${PREVIEW_LIMITS.DELETE_RETRY_ATTEMPTS} attempts`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// set of instance names whose unit we must stop. A sandbox delete
// must also drain every app beneath it. Uses both filesystem scan AND
// port registry because shield may have deleted the tree before drain runs.
function targetInstancesFor(directory: string, root: string = getDefaultRoot()): string[] {
  const targets = new Set<string>();
  targets.add(directory);

  const abs = path.join(root, directory);
  try {
    scanDirsRecursive(abs, directory, targets, 0);
  } catch {}

  try {
    for (const key of portRegistryKeysForPrefix(directory)) targets.add(key);
  } catch {}

  return Array.from(targets);
}

function scanDirsRecursive(absDir: string, relDir: string, targets: Set<string>, depth: number): void {
  if (depth > 5) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
    const childRel = `${relDir}/${e.name}`;
    targets.add(childRel);
    scanDirsRecursive(path.join(absDir, e.name), childRel, targets, depth + 1);
  }
}
