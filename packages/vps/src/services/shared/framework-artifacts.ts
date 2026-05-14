// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Data-driven per-framework warm-artifact probes. ANY match → preview can run prodCommand against cache.

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { FrameworkDef, Runtime } from './framework';

// Single-segment globs only.
export type ArtifactProbe =
  | { kind: 'file'; path: string }
  | { kind: 'dir'; path: string }
  | { kind: 'glob'; dir: string; suffix: string };

export interface FrameworkArtifacts {
  probes: ArtifactProbe[];
  // Interpreted runtimes: source is the artifact; warm always available after install.
  alwaysWarm?: boolean;
}

// Relative to app root. Absent frameworks fall through to runtime default via artifactsFor.
export const FRAMEWORK_ARTIFACTS: Record<string, FrameworkArtifacts> = {
  // ── Frontend SSR ────────────────────────────────────────────
  'next':        { probes: [{ kind: 'file', path: '.next/BUILD_ID' }] },
  'nuxt':        { probes: [{ kind: 'dir', path: '.output/server' }] },
  'remix':       { probes: [{ kind: 'dir', path: 'build/server' }] },
  'svelte':      { probes: [{ kind: 'dir', path: '.svelte-kit/output' }] },
  'astro':       { probes: [{ kind: 'dir', path: 'dist' }] },
  'gatsby':      { probes: [{ kind: 'dir', path: 'public' }, { kind: 'dir', path: '.cache' }] },

  // ── Frontend SPA / static ───────────────────────────────────
  'vite':        { probes: [{ kind: 'dir', path: 'dist' }] },
  'cra':         { probes: [{ kind: 'dir', path: 'build' }] },
  'vue-cli':     { probes: [{ kind: 'dir', path: 'dist' }] },

  // ── Node backends ───────────────────────────────────────────
  'hono':        { probes: [{ kind: 'dir', path: 'dist' }], alwaysWarm: true },
  'express':     { probes: [{ kind: 'dir', path: 'dist' }], alwaysWarm: true },
  'fastify':     { probes: [{ kind: 'dir', path: 'dist' }], alwaysWarm: true },
  'nestjs':      { probes: [{ kind: 'dir', path: 'dist' }] },
  'node-dev':    { probes: [{ kind: 'dir', path: 'dist' }, { kind: 'dir', path: 'build' }], alwaysWarm: true },
  'node-start':  { probes: [], alwaysWarm: true },

  // ── Bun ─────────────────────────────────────────────────────
  'bun':         { probes: [{ kind: 'dir', path: 'dist' }], alwaysWarm: true },

  // ── Monorepo orchestrator ───────────────────────────────────
  'turbo':       { probes: [{ kind: 'dir', path: '.turbo' }] },

  // ── Python — dev and prod commands differ in flags only ────
  'django':      { probes: [], alwaysWarm: true },
  'fastapi':     { probes: [], alwaysWarm: true },
  'flask':       { probes: [], alwaysWarm: true },
  'streamlit':   { probes: [], alwaysWarm: true },
  'gradio':      { probes: [], alwaysWarm: true },
  'python':      { probes: [], alwaysWarm: true },
  'python-pyproject': { probes: [], alwaysWarm: true },

  // ── Ruby ────────────────────────────────────────────────────
  'rails':       { probes: [{ kind: 'dir', path: 'tmp/cache/bootsnap' }], alwaysWarm: true },
  'sinatra':     { probes: [], alwaysWarm: true },
  'ruby':        { probes: [], alwaysWarm: true },

  // ── Go ──────────────────────────────────────────────────────
  'golang':      { probes: [{ kind: 'file', path: 'app' }, { kind: 'file', path: 'bin/app' }] },

  // ── Rust ────────────────────────────────────────────────────
  'rust':        { probes: [{ kind: 'dir', path: 'target/release' }] },

  // ── BEAM ────────────────────────────────────────────────────
  'phoenix':     { probes: [{ kind: 'dir', path: '_build/prod' }], alwaysWarm: true },
  'elixir':      { probes: [{ kind: 'dir', path: '_build' }], alwaysWarm: true },

  // ── Dart / Flutter ──────────────────────────────────────────
  'flutter':     { probes: [{ kind: 'dir', path: 'build/web' }] },
  'dart':        { probes: [], alwaysWarm: true },

  // ── PHP ─────────────────────────────────────────────────────
  'laravel':     { probes: [{ kind: 'dir', path: 'bootstrap/cache' }], alwaysWarm: true },
  'php':         { probes: [], alwaysWarm: true },

  // ── .NET ────────────────────────────────────────────────────
  'dotnet':      { probes: [{ kind: 'dir', path: 'publish' }, { kind: 'dir', path: 'bin/Release' }] },

  // ── JVM ─────────────────────────────────────────────────────
  'spring-boot':         { probes: [{ kind: 'glob', dir: 'target', suffix: '.jar' }] },
  'spring-boot-gradle':  { probes: [{ kind: 'glob', dir: 'build/libs', suffix: '.jar' }] },
  'java-maven':          { probes: [{ kind: 'glob', dir: 'target', suffix: '.jar' }] },
  'java-gradle':         { probes: [{ kind: 'glob', dir: 'build/libs', suffix: '.jar' }] },

  // ── Escape hatches ──────────────────────────────────────────
  'static':      { probes: [], alwaysWarm: true },
  'procfile':    { probes: [], alwaysWarm: true },
  'custom':      { probes: [], alwaysWarm: true },
};

const RUNTIME_DEFAULT: Record<Runtime, FrameworkArtifacts> = {
  node:    { probes: [{ kind: 'dir', path: 'dist' }, { kind: 'dir', path: 'build' }] },
  python:  { probes: [], alwaysWarm: true },
  ruby:    { probes: [], alwaysWarm: true },
  go:      { probes: [{ kind: 'file', path: 'app' }] },
  rust:    { probes: [{ kind: 'dir', path: 'target/release' }] },
  elixir:  { probes: [{ kind: 'dir', path: '_build' }], alwaysWarm: true },
  dart:    { probes: [{ kind: 'dir', path: 'build' }] },
  flutter: { probes: [{ kind: 'dir', path: 'build/web' }] },
  php:     { probes: [], alwaysWarm: true },
  dotnet:  { probes: [{ kind: 'dir', path: 'publish' }] },
  java:    { probes: [{ kind: 'glob', dir: 'target', suffix: '.jar' }] },
  bun:     { probes: [{ kind: 'dir', path: 'dist' }], alwaysWarm: true },
  static:  { probes: [], alwaysWarm: true },
  custom:  { probes: [], alwaysWarm: true },
};

export function artifactsFor(
  frameworkId: string | null | undefined,
  runtime: Runtime | null | undefined,
): FrameworkArtifacts {
  if (frameworkId && FRAMEWORK_ARTIFACTS[frameworkId]) {
    return FRAMEWORK_ARTIFACTS[frameworkId]!;
  }
  if (runtime && RUNTIME_DEFAULT[runtime]) {
    return RUNTIME_DEFAULT[runtime]!;
  }
  return RUNTIME_DEFAULT.node;
}

/**
 * True when a warm production artifact exists for this app root. Pure
 * filesystem inspection; does not exec any builder. For `alwaysWarm`
 * frameworks we return true without probing — the dev/prod commands
 * differ only in env and require no build artifact.
 *
 * The optional `fsProbe` argument lets tests drive the check without a
 * real tree. Probe order matches `artifacts.probes` so callers know
 * which hit won the match for diagnostic logging.
 */
export interface WarmProbeResult {
  available: boolean;
  matchedProbe: ArtifactProbe | null;
  framework: string | null;
  runtime: Runtime | null;
}

export function probeWarmArtifact(
  appPath: string,
  framework: FrameworkDef | null,
  fsProbe: FsProbe = defaultProbe,
): WarmProbeResult {
  const runtime = framework?.runtime ?? null;
  const artifacts = artifactsFor(framework?.id ?? null, runtime);

  if (artifacts.alwaysWarm && artifacts.probes.length === 0) {
    return {
      available: true,
      matchedProbe: null,
      framework: framework?.id ?? null,
      runtime,
    };
  }

  for (const probe of artifacts.probes) {
    if (probeMatches(appPath, probe, fsProbe)) {
      return {
        available: true,
        matchedProbe: probe,
        framework: framework?.id ?? null,
        runtime,
      };
    }
  }

  if (artifacts.alwaysWarm) {
    return {
      available: true,
      matchedProbe: null,
      framework: framework?.id ?? null,
      runtime,
    };
  }

  return {
    available: false,
    matchedProbe: null,
    framework: framework?.id ?? null,
    runtime,
  };
}

// ── Probe surface ──────────────────────────────────────────────

export interface FsProbe {
  exists(absPath: string): boolean;
  isDirectory(absPath: string): boolean;
  listDir(absPath: string): string[];
}

const defaultProbe: FsProbe = {
  exists(abs) {
    try { return fs.existsSync(abs); } catch { return false; }
  },
  isDirectory(abs) {
    try { return fs.statSync(abs).isDirectory(); } catch { return false; }
  },
  listDir(abs) {
    try { return fs.readdirSync(abs); } catch { return []; }
  },
};

function probeMatches(appPath: string, probe: ArtifactProbe, fsProbe: FsProbe): boolean {
  switch (probe.kind) {
    case 'file': {
      const abs = path.join(appPath, probe.path);
      return fsProbe.exists(abs) && !fsProbe.isDirectory(abs);
    }
    case 'dir': {
      const abs = path.join(appPath, probe.path);
      return fsProbe.exists(abs) && fsProbe.isDirectory(abs);
    }
    case 'glob': {
      const abs = path.join(appPath, probe.dir);
      if (!fsProbe.exists(abs) || !fsProbe.isDirectory(abs)) return false;
      const entries = fsProbe.listDir(abs);
      return entries.some(e => e.endsWith(probe.suffix));
    }
  }
}
