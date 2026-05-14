// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Scaffold-tree manifest codegen.
 *
 * Walks `src/templates/scaffold/trees/<id>/` and emits
 * `src/templates/scaffold/tree-manifest.generated.ts` — a typed
 * constant mapping templateId → { relPath → fileEntry }.
 *
 * Why codegen rather than runtime FS reads:
 *   - The vps package ships as tsup-bundled ESM. `__dirname`-
 *     relative reads work in dev but break in the bundle, where
 *     the single-file output lives in `dist/` and the source
 *     `trees/` directory isn't deployed. Embedding trees as JS
 *     string constants makes the manifest survive any bundler.
 *   - Deterministic: one edit under trees/ → one manifest diff.
 *     PR reviewers see exactly which files changed.
 *   - Typed end-to-end: hydrate.ts imports TreeManifest from this
 *     generated file; TypeScript catches a missing templateId at
 *     the callsite, not at scaffold time.
 *
 * Run via: `pnpm run build:scaffold-manifest` (wired in package.json
 * prebuild). The CI guardrail test asserts the committed manifest
 * matches a fresh codegen — an un-rebuilt manifest fails CI.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TREES_DIR = path.resolve(__dirname, '..', 'trees');
const OUTPUT_FILE = path.resolve(__dirname, '..', 'tree-manifest.generated.ts');

// File extensions that are binary — content encoded as base64 in the
// manifest, decoded on hydrate. Everything else is utf-8 text and
// receives `{{PLACEHOLDER}}` substitution.
const BINARY_EXTENSIONS = new Set<string>([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.avif',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.wasm', '.so', '.dylib', '.dll',
  '.mp3', '.mp4', '.webm', '.ogg',
  '.zip', '.gz', '.tar', '.pdf',
]);

interface ManifestEntry {
  kind: 'text' | 'binary';
  content: string;
  mode?: number;
}

type Manifest = Record<string, Record<string, ManifestEntry>>;

function walk(dir: string, relFromTemplate: string, sink: Record<string, ManifestEntry>): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = relFromTemplate ? `${relFromTemplate}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      walk(abs, rel, sink);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      const stat = fs.statSync(abs);
      const isExec = !!(stat.mode & 0o111);
      if (BINARY_EXTENSIONS.has(ext)) {
        const e: ManifestEntry = { kind: 'binary', content: fs.readFileSync(abs).toString('base64') };
        if (isExec) e.mode = 0o755;
        sink[rel] = e;
      } else {
        const e: ManifestEntry = { kind: 'text', content: fs.readFileSync(abs, 'utf8') };
        if (isExec) e.mode = 0o755;
        sink[rel] = e;
      }
    } else if (entry.isSymbolicLink()) {
      throw new Error(`Symlinks not supported in template trees: ${abs}`);
    }
  }
}

function buildManifest(): Manifest {
  if (!fs.existsSync(TREES_DIR)) return {};
  const templateIds = fs.readdirSync(TREES_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();
  const manifest: Manifest = {};
  for (const id of templateIds) {
    const entries: Record<string, ManifestEntry> = {};
    walk(path.join(TREES_DIR, id), '', entries);
    manifest[id] = entries;
  }
  return manifest;
}

function emit(manifest: Manifest): string {
  const header = [
    '// SPDX-License-Identifier: BUSL-1.1',
    '// Copyright (c) 2025 ellul.ai. All rights reserved.',
    '',
    '/* eslint-disable */',
    '// ╔══════════════════════════════════════════════════════════════════╗',
    '// ║ GENERATED FILE — DO NOT EDIT BY HAND                            ║',
    '// ║ Source:  src/templates/scaffold/trees/                          ║',
    '// ║ Rebuild: pnpm -w -F @ellul.ai/vps run build:scaffold-manifest   ║',
    '// ╚══════════════════════════════════════════════════════════════════╝',
    '',
    "export interface TreeEntry {",
    "  kind: 'text' | 'binary';",
    "  /** Text: utf-8 source. Binary: base64-encoded bytes. */",
    "  content: string;",
    "  /** POSIX file mode (e.g. 0o755). Omitted = default (0o644). */",
    "  mode?: number;",
    "}",
    '',
    "export type TreeManifest = Record<string, Record<string, TreeEntry>>;",
    '',
    "export const TREE_MANIFEST: TreeManifest = ",
  ].join('\n');

  const body = JSON.stringify(manifest, null, 2);
  return `${header}${body};\n`;
}

function main(): void {
  const manifest = buildManifest();
  const output = emit(manifest);
  fs.writeFileSync(OUTPUT_FILE, output);
  const fileCount = Object.values(manifest).reduce((n, t) => n + Object.keys(t).length, 0);
  const treeCount = Object.keys(manifest).length;
  // eslint-disable-next-line no-console
  console.log(`[build-tree-manifest] wrote ${OUTPUT_FILE} — ${treeCount} templates, ${fileCount} files`);
}

main();
