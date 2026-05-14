// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Documentation & Welcome Configs
 *
 * Generates CLAUDE.md seed files at provisioning time using the shared context module.
 * These are overwritten by ellul-ctx at runtime with full product-aware context.
 */

import { assembleGlobalContext, assembleProjectContext } from '../../scripts/workflow/context/assemble';
import { resolveFeatures } from '../../scripts/workflow/context/features';
import type { VpsIdentity, Product, Tier } from '../../scripts/workflow/context/types';

function buildIdentity(domain: string, tier: string, svcHome: string, appZone?: string): VpsIdentity {
  const product = tierToProduct(tier);
  const billingTier = (tier === 'starter' || tier === 'platform_free') ? 'free' as Tier : 'paid' as Tier;
  let devDomain: string;
  if (domain === '__DOMAIN__') {
    devDomain = '__DEV_DOMAIN__';
  } else {
    const platformZone = domain.replace(/^[^.]+\./, '');
    const targetAppZone = appZone || platformZone;
    devDomain = domain.replace('-srv.', '-dev.').replace('-dc.', '-ddev.').replace(`.${platformZone}`, `.${targetAppZone}`);
  }
  const shortId = (domain.match(/^([a-f0-9]{8})-/) || ['', domain.split('.')[0]])[1] || '';
  const svcUser = billingTier === 'free' ? 'coder' : 'dev';

  return { product, tier: billingTier, domain, devDomain, shortId, svcUser, homeDir: svcHome };
}

function tierToProduct(tier: string): Product {
  if (tier.indexOf('sandbox') === 0) return 'cloud_sandbox';
  if (tier.indexOf('shield') === 0) return 'shield_proxy';
  return 'cloud_platform';
}

/**
 * Global CLAUDE.md for home directory.
 * Seed content written at provisioning — overwritten by ellul-ctx at runtime.
 */
export function getGlobalClaudeMd(domain: string, tier?: string, svcHome: string = '/home/dev', appZone?: string): string {
  const id = buildIdentity(domain, tier || 'platform_standard', svcHome, appZone);
  const features = resolveFeatures(id.product, id.tier);
  return assembleGlobalContext(id, features, []);
}

/**
 * CLAUDE.md for the projects root directory.
 * Seed content written at provisioning — overwritten by ellul-ctx at runtime.
 */
export function getProjectsClaudeMd(tier?: string, domain?: string, appZone?: string): string {
  const id = buildIdentity(domain || '__DOMAIN__', tier || 'platform_standard', '/home/dev', appZone);
  const features = resolveFeatures(id.product, id.tier);
  const project = { name: 'projects', dir: `${id.homeDir}/projects`, previewPort: 4000 };
  return assembleProjectContext(id, features, project, []);
}
