// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Template hydrator — the single scaffold code path.
 *
 * Every scaffoldable framework in ellul has a complete working
 * tree under `./trees/<id>/`. Hydration is a pure file-copy with
 * placeholder interpolation:
 *
 *   1. Look up the tree in `TREE_MANIFEST` (generated at build time
 *      from the source directory — trees ship embedded in the JS
 *      bundle, no runtime FS dependency on `./trees/`).
 *   2. Walk the tree's file entries.
 *   3. For each text file, replace `{{PROJECT_NAME}}` with the
 *      caller's slug; binary files pass through as base64.
 *   4. Write to `targetDir`. Caller owns scratch / atomic-rename
 *      semantics; this function is a straight writer.
 *
 * No CLI invocations, no `npm install`, no network. A scaffold is
 * byte-identical across runs and across host machines.
 *
 * Design invariants:
 *   - Trees are checked-in source, reviewed like any other code.
 *   - The manifest is generated — edits to it are discarded on next
 *     codegen. To change a scaffold, edit files under `./trees/`.
 *   - Hydration never reads from disk at runtime. This matters on
 *     bundled deployments (tsup/esbuild) where the source `trees/`
 *     directory isn't shipped.
 *   - Relative paths only. Absolute paths or `..` in a manifest
 *     entry are a build-time bug; the hydrator throws.
 *   - The hydrator is idempotent on an empty targetDir: same input
 *     → same output, same file contents, same permissions.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { TREE_MANIFEST, type TreeManifest, type TreeEntry } from './tree-manifest.generated';

// ── Public API ───────────────────────────────────────────────────────────

export interface HydrateInput {
  /**
   * Template id — the framework's scaffold template (usually equal
   * to the framework id). Must be a key in TREE_MANIFEST.
   */
  templateId: string;
  /**
   * Absolute path to the directory files will be written into. The
   * caller owns the directory's lifecycle (create, scratch-rename,
   * cleanup on failure).
   */
  targetDir: string;
  /**
   * The user's project name slug. Substituted for `{{PROJECT_NAME}}`
   * in every text file. Must be a valid filesystem/package name
   * (`[a-z0-9][a-z0-9-]*`) — the caller is responsible for validation.
   */
  projectName: string;
}

export interface HydrateOutput {
  /** Relative paths of every file written, in walk order. */
  filesWritten: string[];
}

export class TemplateNotFoundError extends Error {
  constructor(templateId: string) {
    super(`No scaffold template registered for "${templateId}". Known: ${listTemplateIds().join(', ')}`);
    this.name = 'TemplateNotFoundError';
  }
}

export class TemplateManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateManifestError';
  }
}

/** Known template ids, sorted — useful for error messages and tests. */
export function listTemplateIds(): string[] {
  return Object.keys(TREE_MANIFEST).sort();
}

/** Returns true iff a template tree is registered for the given id. */
export function hasTemplate(templateId: string): boolean {
  return Object.prototype.hasOwnProperty.call(TREE_MANIFEST, templateId);
}

/**
 * Hydrate a scaffold template into `targetDir`. Throws
 * TemplateNotFoundError if the id is unknown; throws
 * TemplateManifestError if a tree entry has an invalid path.
 *
 * Filesystem write errors (ENOSPC, EACCES, …) propagate to the
 * caller as native Node errors — the caller is closer to knowing
 * whether they're fatal or recoverable.
 */
export function hydrateTemplate(input: HydrateInput): HydrateOutput {
  const tree = TREE_MANIFEST[input.templateId];
  if (!tree) throw new TemplateNotFoundError(input.templateId);

  let appZone = '';
  try { appZone = fs.readFileSync('/etc/ellul/app-zone', 'utf8').trim(); } catch {}
  if (!appZone) throw new Error('scaffold: /etc/ellul/app-zone missing — cannot determine preview domain');
  const substitutions = { PROJECT_NAME: input.projectName, APP_ZONE: appZone };
  const filesWritten: string[] = [];

  for (const [relPath, entry] of Object.entries(tree)) {
    assertSafeRelPath(input.templateId, relPath);
    const target = path.join(input.targetDir, relPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });

    if (entry.kind === 'text') {
      fs.writeFileSync(target, applySubstitutions(entry.content, substitutions));
    } else {
      fs.writeFileSync(target, Buffer.from(entry.content, 'base64'));
    }

    if (entry.mode) {
      fs.chmodSync(target, entry.mode);
    }

    filesWritten.push(relPath);
  }

  return { filesWritten };
}

// ── Internals ────────────────────────────────────────────────────────────

/**
 * Guard against malicious or malformed manifest entries. The
 * manifest is generated from checked-in source, but a corrupt
 * build artifact or a developer editing the generated file by
 * hand (despite the header warning) could slip in a traversal.
 * The hydrator refuses to write such an entry.
 */
function assertSafeRelPath(templateId: string, relPath: string): void {
  if (!relPath || relPath.length === 0) {
    throw new TemplateManifestError(`${templateId}: empty path in manifest`);
  }
  if (path.isAbsolute(relPath)) {
    throw new TemplateManifestError(`${templateId}:${relPath} must be relative`);
  }
  const parts = relPath.split(/[/\\]/);
  if (parts.some(p => p === '..')) {
    throw new TemplateManifestError(`${templateId}:${relPath} must not traverse via ..`);
  }
}

function applySubstitutions(contents: string, substitutions: Record<string, string>): string {
  return contents.replace(/\{\{([A-Z_][A-Z0-9_]*)\}\}/g, (match, key) => {
    const val = substitutions[key as keyof typeof substitutions];
    return typeof val === 'string' ? val : match;
  });
}

// Re-export the manifest types so callers can inspect the registry
// without importing the generated file directly.
export type { TreeManifest, TreeEntry };
