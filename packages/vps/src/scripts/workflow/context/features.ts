// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Product feature matrix.
 *
 * Single source of truth for what each product+tier combination supports.
 * Section functions check these flags — no product strings scattered through code.
 */

import type { Product, Tier, ProductFeatures } from './types';

type GateType = ProductFeatures['gates'][number];

const ALL_GATES: GateType[] = ['env', 'logs', 'db', 'git', 'deploy'];

const MATRIX: Record<Product, (tier: Tier) => ProductFeatures> = {
  cloud_platform: (tier) => ({
    hasPreview: true,
    hasDeploy: tier !== 'free',
    hasManagedDb: tier !== 'free',
    hasOpenApiSpec: true,
    hasScaffolding: true,
    hasStyling: true,
    hasPorts: true,
    hasSecrets: true,
    hasUploads: true,
    gates: tier === 'free' ? [] : ALL_GATES,
    orgScoped: false,
    freeTier: tier === 'free',
  }),

  cloud_sandbox: () => ({
    hasPreview: true,
    hasDeploy: false,
    hasManagedDb: false,
    hasOpenApiSpec: false,
    hasScaffolding: true,
    hasStyling: true,
    hasPorts: true,
    hasSecrets: true,
    hasUploads: true,
    gates: ['env', 'logs', 'git'],
    orgScoped: false,
    freeTier: false,
  }),

  shield_proxy: () => ({
    hasPreview: false,
    hasDeploy: false,
    hasManagedDb: false,
    hasOpenApiSpec: false,
    hasScaffolding: false,
    hasStyling: false,
    hasPorts: false,
    hasSecrets: false,
    hasUploads: false,
    gates: ['git'],
    orgScoped: false,
    freeTier: false,
  }),

};

export function resolveFeatures(product: Product, tier: Tier): ProductFeatures {
  return MATRIX[product](tier);
}
