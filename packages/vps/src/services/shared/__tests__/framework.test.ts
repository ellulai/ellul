// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Framework-registry invariants.
 *
 * These tests lock down subtle-but-expensive footguns that cost us
 * production incidents at least once:
 *
 *   1. No `npx` (or equivalent `npm exec` / `pnpm exec` / `yarn dlx`)
 *      in any command string. `npx <cmd>` prepends npm's shared
 *      `_npx` cache dir to PATH BEFORE the project's own
 *      `node_modules/.bin/`. The cache is shared across every
 *      sandbox, every project, every past session — and once a
 *      newer-major version of a binary lands there (e.g. someone
 *      on the same host ran `npx next` at some point, pulling
 *      Next 16), every future `npx next` resolves to that cached
 *      v16 even when the project pins `^15`. `--no-install` does
 *      not clean or bypass stale caches; it only blocks NEW
 *      downloads.
 *
 *      If you hit this test, DO NOT work around it by adding
 *      `--no-install` or any other npx flag. Use the bare binary
 *      name (e.g. `next dev`) — the preview launcher prepends every
 *      ancestor `node_modules/.bin/` onto PATH so it resolves the
 *      project's pinned version.
 *
 *   2. No literal `./node_modules/.bin/<cmd>` prefix in Node
 *      devCommand/prodCommand/buildCommand fields. That prefix is
 *      wrong for any hoisted workspace layout (npm/yarn workspaces,
 *      Turborepo default): the binary lives at the workspace root's
 *      `node_modules/.bin/`, not the package-local one. Using a bare
 *      binary name lets PATH resolution find whichever level of
 *      `node_modules/.bin/` happens to carry the binary — single
 *      app, hoisted workspace, or pnpm per-package, all with the
 *      same command string.
 *
 *      The backward-compat strip in the launcher handles legacy
 *      on-disk specs, but new registry entries must not reintroduce
 *      the prefix.
 *
 *   3. Every scaffoldable framework ships a registered template
 *      tree — otherwise scaffold_project throws
 *      TemplateNotFoundError at runtime. The scaffold-template
 *      coherence suite re-asserts this from the template side;
 *      here we assert it from the framework-registry side so a
 *      framework.ts edit can't be merged without the
 *      corresponding tree.
 */

import { describe, it, expect } from 'vitest';

import { FRAMEWORKS, SCAFFOLDABLE_FRAMEWORK_IDS, getFrameworkById } from '../framework';
import { hasTemplate } from '../../../templates/scaffold';

const COMMAND_FIELDS = [
  'devCommand',
  'prodCommand',
  'buildCommand',
  'install',
  'prodInstall',
] as const;

describe('framework.ts — command string invariants', () => {
  it('no command field contains `npx ` (npx cache-poisoning vector)', () => {
    const offenders: Array<{ id: string; field: string; cmd: string }> = [];
    for (const fw of FRAMEWORKS) {
      for (const field of COMMAND_FIELDS) {
        const value = (fw as unknown as Record<string, string | null | undefined>)[field];
        if (typeof value !== 'string') continue;
        if (/\bnpx\s/.test(value)) {
          offenders.push({ id: fw.id, field, cmd: value });
        }
      }
    }
    expect(
      offenders,
      'Ban npx in command strings — see comment in framework.test.ts. ' +
        'Offenders:\n' +
        offenders.map(o => `  ${o.id}.${o.field}: ${o.cmd}`).join('\n'),
    ).toEqual([]);
  });

  it('no command field starts with a delegated-exec prefix', () => {
    // `npm exec`, `pnpm exec`, `yarn dlx`, `yarn exec` all share npx's
    // cache-poisoning characteristics to varying degrees. The registry
    // must not reach for them — bare binary names via PATH only.
    const BANNED_PREFIXES = ['npx ', 'npm exec ', 'pnpm exec ', 'yarn dlx ', 'yarn exec '];
    const offenders: Array<{ id: string; field: string; cmd: string }> = [];
    for (const fw of FRAMEWORKS) {
      for (const field of ['devCommand', 'prodCommand', 'buildCommand'] as const) {
        const value = (fw as unknown as Record<string, string | null | undefined>)[field];
        if (typeof value !== 'string') continue;
        for (const prefix of BANNED_PREFIXES) {
          if (value.startsWith(prefix)) {
            offenders.push({ id: fw.id, field, cmd: value });
          }
        }
      }
    }
    expect(
      offenders,
      `Use a bare binary name (e.g. 'next dev') — the launcher resolves it via PATH. Offenders:\n${offenders.map(o => `  ${o.id}.${o.field}: ${o.cmd}`).join('\n')}`,
    ).toEqual([]);
  });

  it('Node-runtime devCommand/prodCommand/buildCommand must not use `./node_modules/.bin/`', () => {
    // The prefix is wrong for hoisted workspace layouts — the bin lives
    // at the workspace root, not the package-local node_modules. Since
    // the preview launcher now walks ancestor `node_modules/.bin/` onto
    // PATH, the command should just name the binary.
    const offenders: Array<{ id: string; field: string; cmd: string }> = [];
    for (const fw of FRAMEWORKS) {
      if (fw.runtime !== 'node') continue;
      for (const field of ['devCommand', 'prodCommand', 'buildCommand'] as const) {
        const value = (fw as unknown as Record<string, string | null | undefined>)[field];
        if (typeof value !== 'string') continue;
        if (value.includes('./node_modules/.bin/')) {
          offenders.push({ id: fw.id, field, cmd: value });
        }
      }
    }
    expect(
      offenders,
      `Drop the './node_modules/.bin/' prefix — use the bare binary name. Offenders:\n${offenders.map(o => `  ${o.id}.${o.field}: ${o.cmd}`).join('\n')}`,
    ).toEqual([]);
  });

  it('Node-runtime devCommand first token is a bare identifier (no path separators, no env-prefix)', () => {
    // Downstream assumption: the preview launcher's pre-flight
    // `command -v` check resolves the first token through PATH. If a
    // framework ships `/usr/bin/node script.js` or `VAR=x next dev`,
    // the preflight is skipped (those shapes are explicitly allowed
    // in the launcher) — but they're not something the registry
    // should produce for Node frameworks. Keep the shape uniform.
    const offenders: Array<{ id: string; field: string; cmd: string; reason: string }> = [];
    for (const fw of FRAMEWORKS) {
      if (fw.runtime !== 'node') continue;
      const value = fw.devCommand;
      if (typeof value !== 'string' || !value.trim()) continue;
      const firstToken = value.trim().split(/\s+/)[0] ?? '';
      if (firstToken.startsWith('/') || firstToken.startsWith('./') || firstToken.startsWith('../')) {
        offenders.push({ id: fw.id, field: 'devCommand', cmd: value, reason: 'path-like first token' });
      } else if (firstToken.includes('=')) {
        offenders.push({ id: fw.id, field: 'devCommand', cmd: value, reason: 'env-prefix before binary' });
      } else if (!/^[A-Za-z0-9_@][A-Za-z0-9._@-]*$/.test(firstToken)) {
        offenders.push({ id: fw.id, field: 'devCommand', cmd: value, reason: `unexpected char in first token '${firstToken}'` });
      }
    }
    expect(
      offenders,
      `Node-runtime devCommand first token must be a bare identifier. Offenders:\n${offenders.map(o => `  ${o.id}.${o.field} (${o.reason}): ${o.cmd}`).join('\n')}`,
    ).toEqual([]);
  });
});

describe('framework.ts — scaffolder integrity', () => {
  it('every scaffoldable framework has a template registered', () => {
    const missing: Array<{ fwId: string; templateId: string }> = [];
    for (const fwId of SCAFFOLDABLE_FRAMEWORK_IDS) {
      const fw = getFrameworkById(fwId)!;
      const templateId = fw.scaffold!.template;
      if (!hasTemplate(templateId)) {
        missing.push({ fwId, templateId });
      }
    }
    expect(
      missing,
      'Scaffoldable framework without a tree:\n' +
        missing.map(m => `  ${m.fwId} → template "${m.templateId}" not in TREE_MANIFEST`).join('\n'),
    ).toEqual([]);
  });

  it('scaffold.template replaced scaffold.cmd — no framework still uses the CLI form', () => {
    const offenders: string[] = [];
    for (const fw of FRAMEWORKS) {
      if (!fw.scaffold) continue;
      if ((fw.scaffold as Record<string, unknown>).cmd !== undefined) {
        offenders.push(fw.id);
      }
    }
    expect(offenders, `Migrate scaffold.cmd → scaffold.template for: ${offenders.join(', ')}`).toEqual([]);
  });
});
