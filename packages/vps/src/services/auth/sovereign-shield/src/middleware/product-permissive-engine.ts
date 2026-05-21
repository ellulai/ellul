// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Product Gate — Permissive Engine
 *
 * Active on cloud_platform (or when product file is missing/corrupted).
 * Near-zero overhead — stamps context and calls next().
 *
 * One exception: deploy (POST /api/workflow/expose) requires a paid billing
 * tier. platform_free includes all features EXCEPT deploy.
 */

import { createMiddleware } from 'hono/factory';
import type { Product, BillingTier } from './product-types';

/**
 * Create the permissive engine middleware for cloud_platform.
 * Passes through all requests except deploy on free billing tier.
 */
export function createProductPermissiveEngine(billingTier: BillingTier, product: Product = 'cloud_platform') {
  return createMiddleware(async (c, next) => {
    c.set('product', product);
    c.set('billingTier', billingTier);

    if (billingTier !== 'paid' &&
        c.req.path === '/api/workflow/expose' &&
        c.req.method === 'POST') {
      return c.json({ error: 'Deployment requires a paid tier', upgrade: true }, 403);
    }

    return next();
  });
}
