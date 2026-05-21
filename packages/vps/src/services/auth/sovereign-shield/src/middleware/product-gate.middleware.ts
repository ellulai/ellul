// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Product Gate — Two-Engine Architecture
 *
 * Replaces the billing gate with product-based feature gating. Features are
 * determined by PRODUCT (what was purchased), not billing tier (how much was paid).
 *
 * Selects one of two completely independent engines at process start:
 *
 *   product-restrictive-engine.ts — Active on cloud_sandbox, shield_proxy.
 *     Default-deny for features not included in the product. Rate-limits 403 rejections.
 *
 *   product-permissive-engine.ts — Active on cloud_platform (or missing/invalid file).
 *     Near-zero overhead. All features unlocked except deploy on free billing tier.
 *
 * Engine selection:
 *   Read /etc/ellul/product ONCE at process start.
 *   - "cloud_platform", missing file, or invalid → Permissive Engine
 *   - "cloud_sandbox", "shield_proxy" → Restrictive Engine
 *
 *   Read /etc/ellul/billing-tier ONCE at process start (still needed for deploy
 *   sub-check on cloud_platform and for session policy / svcUser detection).
 *   - "free", "paid" (or missing → "paid")
 *
 *   Sovereign-shield is restarted by the enforcer after any tier/product change,
 *   so runtime re-reads are unnecessary.
 */

import fs from 'fs';
import { createProductRestrictiveEngine } from './product-restrictive-engine';
import { createProductPermissiveEngine } from './product-permissive-engine';
import type { Product, BillingTier } from './product-types';

export type { Product, BillingTier };

const PRODUCT_FILE = '/etc/ellul/product';
const BILLING_TIER_FILE = '/etc/ellul/billing-tier';

const VALID_PRODUCTS = new Set<Product>(['cloud_platform', 'cloud_sandbox', 'shield_proxy', 'byos']);
const VALID_TIERS = new Set<BillingTier>(['free', 'paid']);

/**
 * Read product ONCE at process start from the VPS config file.
 *
 * The file is root:root 644 — the service user (coder/dev) cannot modify it.
 * Written by provisioning and update-identity (both root-only operations).
 *
 * Fallback on missing/corrupted file: 'cloud_platform' (permissive).
 * Rationale: a missing file means provisioning hasn't written it yet or the
 * VPS predates the product gate. Defaulting to the most permissive product
 * ensures no user is locked out. The enforcer's boot validation writes
 * "product_missing" to /etc/ellul/boot-failures, triggering an ops alert.
 */
function resolveProduct(): Product {
  try {
    const raw = fs.readFileSync(PRODUCT_FILE, 'utf8').trim();
    if (VALID_PRODUCTS.has(raw as Product)) {
      console.log(`[product-gate] Resolved product: "${raw}"`);
      return raw as Product;
    }
    console.error(`[product-gate] Unknown product value "${raw}" in ${PRODUCT_FILE} — defaulting to cloud_platform (Permissive Engine)`);
    return 'cloud_platform';
  } catch {
    console.error(`[product-gate] Cannot read ${PRODUCT_FILE} — defaulting to cloud_platform (Permissive Engine)`);
    return 'cloud_platform';
  }
}

/**
 * Read billing tier ONCE at process start from the VPS config file.
 *
 * Still needed for:
 *   - Deploy sub-check on cloud_platform (only paid tiers can deploy)
 *   - Session policy TTLs (per-billing-tier configuration)
 *   - Downstream context (svcUser detection, memory limits)
 *
 * Fallback on missing/corrupted file: 'paid' (permissive).
 * Same rationale as the original billing gate — a missing file must not lock
 * users out. On web_locked tier, the user has no SSH — defaulting to 'free'
 * would lock them out with no recovery path.
 */
function resolveBillingTier(): BillingTier {
  try {
    const raw = fs.readFileSync(BILLING_TIER_FILE, 'utf8').trim();
    if (VALID_TIERS.has(raw as BillingTier)) {
      console.log(`[product-gate] Resolved billing tier: "${raw}"`);
      return raw as BillingTier;
    }
    console.error(`[product-gate] Unknown tier value "${raw}" in ${BILLING_TIER_FILE} — defaulting to paid`);
    return 'paid';
  } catch {
    console.error(`[product-gate] Cannot read ${BILLING_TIER_FILE} — defaulting to paid`);
    return 'paid';
  }
}

/** The product for this process lifetime. Immutable after boot. */
export const PRODUCT: Product = resolveProduct();

/** The billing tier for this process lifetime. Immutable after boot. */
export const BILLING_TIER: BillingTier = resolveBillingTier();

/** The active middleware — engine selected at boot, immutable for process lifetime. */
export const productGateMiddleware = PRODUCT === 'cloud_platform' || PRODUCT === 'byos'
  ? createProductPermissiveEngine(BILLING_TIER, PRODUCT)
  : createProductRestrictiveEngine(PRODUCT, BILLING_TIER);
