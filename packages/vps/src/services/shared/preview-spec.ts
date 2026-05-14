// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Preview spec — agent-owned per-app contract at <appPath>/.ellul/preview.json.
// Fallback: package.json.scripts.dev (with warning). Resource limits live on systemd unit, not spec.

import * as fs from 'fs';
import * as path from 'path';

import type { FrameworkDef } from './framework';

export type PreviewRuntime =
  | 'node'
  | 'python'
  | 'ruby'
  | 'go'
  | 'rust'
  | 'php'
  | 'dotnet'
  | 'java'
  | 'elixir'
  | 'dart'
  | 'flutter'
  | 'bun'
  | 'static';

// 'hot' = devCommand (HMR, high RSS); 'warm' = prodCommand (lower RSS, picked under memory pressure).
export type PreviewMode = 'hot' | 'warm';

export interface PreviewSpec {
  /** Forward-compat version tag. */
  version: 1;
  /** Drives PATH setup and identification only — not framework logic. */
  runtime: PreviewRuntime;
  /** Dev command run by the instance launcher. Use $PORT / $HOST to interpolate. */
  start: string;
  /** Port the dev command binds to. */
  port: number;
  // ELLUL_PREVIEW_MODE env overrides persisted spec (admission override without disk write).
  mode?: PreviewMode;
  prodStart?: string;
  // $PORT / $HOST interpolated at exec time. Required for FLASK_DEBUG, GRADIO_SERVER_PORT, etc.
  // (2026-04-19 post-mortem: Gradio bound 7860 regardless of spec.port without this.)
  env?: Record<string, string>;
  prodEnv?: Record<string, string>;
  /** Optional explicit OpenAPI docs path (e.g. "/docs"). Probe is the fallback. */
  openApiPath?: string;
  /** Server runs but console doesn't render a preview panel (pure backends without OpenAPI). */
  headless?: boolean;
}

const SPEC_DIR = '.ellul';
const SPEC_FILE = 'preview.json';

function normalizeRuntime(runtime: FrameworkDef['runtime']): PreviewRuntime {
  switch (runtime) {
    case 'node':
    case 'python':
    case 'ruby':
    case 'go':
    case 'rust':
    case 'php':
    case 'dotnet':
    case 'java':
    case 'elixir':
    case 'dart':
    case 'flutter':
    case 'bun':
    case 'static':
      return runtime;
    case 'custom':
      return 'node';
    default:
      return 'node';
  }
}

// $PORT stays literal (re-interpolated at launch). $MODULE (FastAPI) resolved here vs disk
// (2026-04-19 incident: literal $MODULE caused uvicorn ":app" parse failure).
export function defaultSpecForFramework(fw: FrameworkDef, port: number, appPath?: string): PreviewSpec {
  let start = fw.devCommand;
  let prodStart: string | undefined = fw.prodCommand && fw.prodCommand !== fw.devCommand
    ? fw.prodCommand
    : undefined;
  if (appPath && start.includes('$MODULE')) {
    // Lazy import to avoid a cycle with framework.ts at module load.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { resolveModule } = require('./framework') as typeof import('./framework');
    const mod = resolveModule(appPath);
    start = start.replace(/\$MODULE/g, mod);
    if (prodStart && prodStart.includes('$MODULE')) {
      prodStart = prodStart.replace(/\$MODULE/g, mod);
    }
  }

  // Collect framework env — base `env` plus dev-specific overrides.
  // Intentionally use dev over prod here since this is the preview
  // spec; deploy writes its own prod-env spec separately. Leave
  // `$PORT` / `$HOST` placeholders intact; the launcher interpolates
  // them once at exec time against the current spec.port, so changing
  // the port is still a one-field edit.
  const env: Record<string, string> = { ...(fw.env ?? {}), ...(fw.devEnv ?? {}) };
  // Prod env overrides live in a separate bag — applied by the
  // launcher only when spec.mode === 'warm'. Keeps the dev surface
  // clean (no RAILS_ENV=production leaking into hot mode on rollback).
  const prodEnv: Record<string, string> = { ...(fw.prodEnv ?? {}) };

  const spec: PreviewSpec = {
    version: 1,
    runtime: normalizeRuntime(fw.runtime),
    start,
    port,
  };
  if (prodStart) spec.prodStart = prodStart;
  if (Object.keys(env).length > 0) spec.env = env;
  if (Object.keys(prodEnv).length > 0) spec.prodEnv = prodEnv;
  if (fw.headless) spec.headless = true;
  return spec;
}

/** Absolute path to the spec file inside an app directory. */
export function specPath(appPath: string): string {
  return path.join(appPath, SPEC_DIR, SPEC_FILE);
}

// Shape mismatch → null; launcher falls back with warning.
export function readSpec(appPath: string): PreviewSpec | null {
  const file = specPath(appPath);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  if (p.version !== 1) return null;
  if (typeof p.runtime !== 'string') return null;
  if (typeof p.start !== 'string' || !p.start.trim()) return null;
  if (typeof p.port !== 'number' || !Number.isFinite(p.port) || p.port <= 0) return null;
  if (p.openApiPath !== undefined && typeof p.openApiPath !== 'string') return null;
  if (p.headless !== undefined && typeof p.headless !== 'boolean') return null;
  if (p.mode !== undefined && p.mode !== 'hot' && p.mode !== 'warm') return null;
  if (p.prodStart !== undefined && (typeof p.prodStart !== 'string' || !p.prodStart.trim())) return null;
  const envBag = (value: unknown): Record<string, string> | null => {
    if (value === undefined) return null;
    if (!value || typeof value !== 'object') return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v !== 'string') return null;
      out[k] = v;
    }
    return out;
  };
  const envParsed = envBag(p.env);
  const prodEnvParsed = envBag(p.prodEnv);
  return {
    version: 1,
    runtime: p.runtime as PreviewRuntime,
    start: p.start,
    port: p.port,
    ...(p.mode === 'warm' ? { mode: 'warm' as const } : p.mode === 'hot' ? { mode: 'hot' as const } : {}),
    ...(typeof p.prodStart === 'string' ? { prodStart: p.prodStart } : {}),
    ...(envParsed ? { env: envParsed } : {}),
    ...(prodEnvParsed ? { prodEnv: prodEnvParsed } : {}),
    ...(typeof p.openApiPath === 'string' ? { openApiPath: p.openApiPath } : {}),
    ...(p.headless === true ? { headless: true } : {}),
  };
}

// Atomic write: tmp → fsync → rename.
export function writeSpec(appPath: string, spec: PreviewSpec): void {
  const dir = path.join(appPath, SPEC_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, SPEC_FILE);
  const tmp = `${target}.tmp.${process.pid}`;
  const fd = fs.openSync(tmp, 'w', 0o644);
  try {
    fs.writeSync(fd, JSON.stringify(spec, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
}

// Fallback for unrecognized frameworks: `<pm> run dev|start`. Null if neither script exists.
export function inferFromPackageJson(appPath: string, port: number): PreviewSpec | null {
  const pkgJsonPath = path.join(appPath, 'package.json');
  let pkgRaw: string;
  try {
    pkgRaw = fs.readFileSync(pkgJsonPath, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(pkgRaw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const scripts = (parsed as Record<string, unknown>).scripts;
  if (!scripts || typeof scripts !== 'object') return null;
  const scriptMap = scripts as Record<string, unknown>;
  // Prefer `dev` (explicit dev server). Fall back to `start` (many
  // Express/Hono/Node backends only ship a start script).
  let scriptName: 'dev' | 'start' | null = null;
  if (typeof scriptMap.dev === 'string' && scriptMap.dev.trim()) scriptName = 'dev';
  else if (typeof scriptMap.start === 'string' && scriptMap.start.trim()) scriptName = 'start';
  if (!scriptName) return null;

  // Lazy import — framework.ts is heavy and this function only runs on
  // the cold inference path.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { detectPackageManager } = require('./framework') as typeof import('./framework');
  // Boundary: $HOME/projects/<sandbox>/. appPath always lives under
  // $HOME/projects, so the first two path components after projects/
  // give us the sandbox directory; fall back to $HOME if the shape
  // isn't recognisable.
  const home = process.env.HOME ?? '/';
  const projectsBoundary = path.join(home, 'projects');
  let boundary = home;
  if (appPath.startsWith(projectsBoundary + path.sep)) {
    const rel = appPath.slice(projectsBoundary.length + 1);
    const sandbox = rel.split(path.sep)[0];
    if (sandbox) boundary = path.join(projectsBoundary, sandbox);
  }
  const pmInfo = detectPackageManager(appPath, boundary);
  const runtime: PreviewRuntime = pmInfo.pm === 'bun' ? 'bun' : 'node';
  const spec: PreviewSpec = {
    version: 1,
    runtime,
    start: `${pmInfo.scriptRunner} ${scriptName}`,
    port,
    env: { HOST: '0.0.0.0', PORT: '$PORT' },
  };
  return spec;
}

// Two-tier: framework registry → package.json scripts. null → UI prompts for manual command.
export function inferSpecFromRepo(appPath: string, port: number): PreviewSpec | null {
  // Lazy import to avoid a cycle — framework.ts is heavy and pulls in fs.
  // This function is called once per clone, performance is irrelevant.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { detectFramework } = require('./framework') as typeof import('./framework');
  const fw = detectFramework(appPath);
  const spec = fw ? defaultSpecForFramework(fw, port, appPath) : inferFromPackageJson(appPath, port);
  if (!spec) return null;
  try {
    writeSpec(appPath, spec);
  } catch {
    return null;
  }
  return spec;
}
