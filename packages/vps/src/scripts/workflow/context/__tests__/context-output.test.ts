// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Context output regression test.
 *
 * Verifies product-aware context generation for each product+tier.
 * Catches un-escaping errors and content leaks between products.
 */

import { assembleGlobalContext } from '../assemble';
import { resolveFeatures } from '../features';
import type { VpsIdentity, Product, Tier, DeployedApp } from '../types';

function makeId(product: Product, tier: Tier): VpsIdentity {
  return {
    product,
    tier,
    domain: 'abc12345-srv.ellul.ai',
    devDomain: 'abc12345-dev.ellul.app',
    shortId: 'abc12345',
    svcUser: tier === 'free' ? 'coder' : 'dev',
    homeDir: tier === 'free' ? '/home/coder' : '/home/dev',
  };
}

const DEPLOYED: DeployedApp[] = [
  { name: 'my-app', url: 'https://my-app-abc12345.ellul.app', port: 3001, domain: 'my-app-abc12345.ellul.app', projectPath: '/home/dev/projects/my-app' },
];

describe('cloud_platform paid', () => {
  const id = makeId('cloud_platform', 'paid');
  const features = resolveFeatures('cloud_platform', 'paid');
  const output = assembleGlobalContext(id, features, DEPLOYED);

  it('includes deploy section', () => expect(output).toContain('ellul-expose'));
  it('includes managed DB', () => expect(output).toContain('ellul-install postgres'));
  it('includes all 5 gates', () => {
    for (const g of ['env', 'logs', 'db', 'git', 'deploy']) expect(output).toContain(`\`${g}\``);
  });
  it('includes preview URL', () => expect(output).toContain('abc12345-dev.ellul.app'));
  it('includes deployed apps', () => expect(output).toContain('my-app'));
  it('includes styling', () => expect(output).toContain('Tailwind'));
  it('includes production ports', () => expect(output).toContain('3001+'));
});

describe('cloud_platform free', () => {
  const id = makeId('cloud_platform', 'free');
  const features = resolveFeatures('cloud_platform', 'free');
  const output = assembleGlobalContext(id, features, []);

  it('excludes deploy', () => expect(output).not.toContain('ellul-expose'));
  it('excludes managed DB', () => expect(output).not.toContain('ellul-install'));
  it('includes free limitations', () => expect(output).toContain('Free Tier Limitations'));
  it('includes preview URL', () => expect(output).toContain('abc12345-dev.ellul.app'));
});

describe('cloud_sandbox', () => {
  const id = makeId('cloud_sandbox', 'paid');
  const features = resolveFeatures('cloud_sandbox', 'paid');
  const output = assembleGlobalContext(id, features, []);

  it('excludes deploy', () => expect(output).not.toContain('ellul-expose'));
  it('excludes managed DB', () => expect(output).not.toContain('ellul-install'));
  it('excludes deploy gate', () => expect(output).toContain('not available in Sandbox'));
  it('includes preview URL', () => expect(output).toContain('abc12345-dev.ellul.app'));
  it('includes styling', () => expect(output).toContain('Tailwind'));
  it('includes Sandbox header', () => expect(output).toContain('Sandbox'));
});

describe('shield_proxy', () => {
  const id = makeId('shield_proxy', 'paid');
  const features = resolveFeatures('shield_proxy', 'paid');
  const output = assembleGlobalContext(id, features, []);

  it('excludes preview', () => expect(output).not.toContain('abc12345-dev.ellul.app'));
  it('excludes deploy', () => expect(output).not.toContain('ellul-expose'));
  it('excludes managed DB', () => expect(output).not.toContain('ellul-install'));
  it('excludes scaffolding', () => expect(output).not.toContain('create-next-app'));
  it('excludes styling', () => expect(output).not.toContain('Tailwind'));
  it('only has git gate', () => {
    expect(output).toContain('`git`');
    expect(output).not.toContain('`env`');
  });
  it('includes Shield header', () => expect(output).toContain('Shield Gateway'));
});

describe('content isolation', () => {
  it('all products include security section', () => {
    for (const p of ['cloud_platform', 'cloud_sandbox', 'shield_proxy'] as Product[]) {
      const out = assembleGlobalContext(makeId(p, 'paid'), resolveFeatures(p, 'paid'), []);
      expect(out).toContain('CRITICAL SECURITY');
    }
  });

  it('all products include workspace boundary', () => {
    for (const p of ['cloud_platform', 'cloud_sandbox', 'shield_proxy'] as Product[]) {
      const out = assembleGlobalContext(makeId(p, 'paid'), resolveFeatures(p, 'paid'), []);
      expect(out).toContain('WORKSPACE BOUNDARY');
    }
  });

  it('no product has undefined or __PLACEHOLDER__ in output', () => {
    for (const p of ['cloud_platform', 'cloud_sandbox', 'shield_proxy'] as Product[]) {
      const out = assembleGlobalContext(makeId(p, 'paid'), resolveFeatures(p, 'paid'), []);
      expect(out).not.toContain('undefined');
      expect(out).not.toContain('__');
    }
  });
});
