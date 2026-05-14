// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { describe, it, expect } from 'vitest';

import {
  FRAMEWORK_ARTIFACTS,
  artifactsFor,
  probeWarmArtifact,
  type FsProbe,
} from '../framework-artifacts';
import { FRAMEWORKS } from '../framework';

function fakeFs(files: Set<string>, dirs: Set<string>): FsProbe {
  return {
    exists: (p) => files.has(p) || dirs.has(p),
    isDirectory: (p) => dirs.has(p),
    listDir: (p) => {
      const entries: string[] = [];
      const prefix = p.endsWith('/') ? p : `${p}/`;
      for (const f of files) {
        if (f.startsWith(prefix) && !f.slice(prefix.length).includes('/')) {
          entries.push(f.slice(prefix.length));
        }
      }
      return entries;
    },
  };
}

describe('framework-artifacts: registry coverage', () => {
  it('has an entry for every framework in the registry', () => {
    for (const fw of FRAMEWORKS) {
      expect(FRAMEWORK_ARTIFACTS[fw.id], `missing artifact config for ${fw.id}`)
        .toBeDefined();
    }
  });

  it('artifactsFor returns a non-null entry for every runtime fallback', () => {
    const runtimes = ['node', 'python', 'ruby', 'go', 'rust', 'java', 'dotnet', 'bun', 'php', 'static'] as const;
    for (const r of runtimes) {
      const a = artifactsFor(null, r);
      expect(a).toBeDefined();
      expect(a.probes).toBeInstanceOf(Array);
    }
  });
});

describe('framework-artifacts: probeWarmArtifact', () => {
  const nextFw = FRAMEWORKS.find(f => f.id === 'next')!;
  const honoFw = FRAMEWORKS.find(f => f.id === 'hono')!;
  const springMavenFw = FRAMEWORKS.find(f => f.id === 'spring-boot')!;
  const djangoFw = FRAMEWORKS.find(f => f.id === 'django')!;
  const goFw = FRAMEWORKS.find(f => f.id === 'golang')!;

  it('returns available=true for alwaysWarm frameworks without probing', () => {
    const r = probeWarmArtifact('/app', djangoFw, fakeFs(new Set(), new Set()));
    expect(r.available).toBe(true);
    expect(r.framework).toBe('django');
  });

  it('Next.js: requires .next/BUILD_ID', () => {
    const probe = fakeFs(
      new Set(['/app/.next/BUILD_ID']),
      new Set(['/app/.next']),
    );
    const r = probeWarmArtifact('/app', nextFw, probe);
    expect(r.available).toBe(true);
  });

  it('Next.js: .next dir without BUILD_ID is not enough', () => {
    const probe = fakeFs(new Set(), new Set(['/app/.next']));
    const r = probeWarmArtifact('/app', nextFw, probe);
    expect(r.available).toBe(false);
  });

  it('Spring Boot: glob match on target/*.jar', () => {
    const probe = fakeFs(
      new Set(['/app/target/app-1.0.jar']),
      new Set(['/app/target']),
    );
    const r = probeWarmArtifact('/app', springMavenFw, probe);
    expect(r.available).toBe(true);
    expect(r.matchedProbe?.kind).toBe('glob');
  });

  it('Spring Boot: empty target dir returns unavailable', () => {
    const probe = fakeFs(new Set(), new Set(['/app/target']));
    const r = probeWarmArtifact('/app', springMavenFw, probe);
    expect(r.available).toBe(false);
  });

  it('Go: either root binary or bin/app satisfies', () => {
    const withRoot = fakeFs(new Set(['/app/app']), new Set());
    expect(probeWarmArtifact('/app', goFw, withRoot).available).toBe(true);

    const withBinDir = fakeFs(new Set(['/app/bin/app']), new Set(['/app/bin']));
    expect(probeWarmArtifact('/app', goFw, withBinDir).available).toBe(true);

    const neither = fakeFs(new Set(), new Set());
    expect(probeWarmArtifact('/app', goFw, neither).available).toBe(false);
  });

  it('Hono / backends: alwaysWarm is true even with no dist/', () => {
    const r = probeWarmArtifact('/app', honoFw, fakeFs(new Set(), new Set()));
    expect(r.available).toBe(true);
  });

  it('unknown framework falls through to runtime default', () => {
    const r = probeWarmArtifact(
      '/app',
      { ...goFw, id: 'unknown-go-fork', runtime: 'go' },
      fakeFs(new Set(['/app/app']), new Set()),
    );
    expect(r.available).toBe(true);
  });

  it('null framework returns unavailable but non-throwing', () => {
    const r = probeWarmArtifact('/app', null, fakeFs(new Set(), new Set()));
    expect(typeof r.available).toBe('boolean');
  });
});
