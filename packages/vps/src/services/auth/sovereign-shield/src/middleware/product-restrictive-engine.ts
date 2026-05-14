// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Product Gate — Restrictive Engine
 *
 * Active on cloud_sandbox and shield_proxy products.
 * Default-deny for features not included in the product. Rate-limits
 * 403 rejections to prevent feature probing.
 *
 * Feature matrix:
 *   Route                          | cloud_sandbox | shield_proxy
 *   ───────────────────────────────────────────────────────────────
 *   Preview (/_auth/preview/*, /api/preview-url)  | YES  | NO
 *   Deploy  (POST /api/workflow/expose)           | NO   | NO
 *   Exec    (/_auth/exec/*)                       | YES  | YES
 *   DB      (/api/internal/db/*)                  | NO   | NO
 *   Gates   (/api/internal/gates/*, /_auth/gates/*) | YES | YES
 *   Projects (/api/internal/projects/*, /_auth/projects/*) | YES | NO
 *
 * cloud_platform is handled by the permissive engine (all features except
 * deploy on free tier).
 */

import { createMiddleware } from 'hono/factory';
import type { Product, BillingTier } from './product-types';

interface FeatureGate {
  /** Products that ARE allowed access to this route. */
  allowedProducts: ReadonlySet<Product>;
  /** Error message returned to the client. */
  error: string;
}

/** Routes that never need product checks (public, auth flow, health). */
function isExemptRoute(path: string): boolean {
  return (
    path === '/health' ||
    path === '/_auth/capabilities' ||
    path.startsWith('/_auth/login') ||
    path.startsWith('/_auth/register') ||
    path.startsWith('/_auth/challenge') ||
    path.startsWith('/_auth/verify')
  );
}

// ── Feature gate definitions ──
// Each gate lists the products that CAN access the route.
// Products not in the set are blocked.

const PREVIEW_GATE: FeatureGate = {
  allowedProducts: new Set<Product>(['cloud_platform', 'cloud_sandbox']),
  error: 'Preview requires a Cloud Platform or Cloud Sandbox product',
};

const DEPLOY_GATE: FeatureGate = {
  // Only cloud_platform can deploy, and only on paid billing — but this
  // engine only runs for non-cloud_platform products, so deploy is always blocked here.
  allowedProducts: new Set<Product>(['cloud_platform']),
  error: 'Deployment requires a Cloud Platform product',
};

const DB_GATE: FeatureGate = {
  allowedProducts: new Set<Product>(['cloud_platform']),
  error: 'Database access requires a Cloud Platform product',
};

const PROJECTS_GATE: FeatureGate = {
  allowedProducts: new Set<Product>(['cloud_platform', 'cloud_sandbox']),
  error: 'Project management requires a Cloud Platform or Cloud Sandbox product',
};

// Exec and Gates are allowed on ALL products — no gate needed.

/** Classify a route's feature gate. null = no restriction (all products allowed). */
function classifyRoute(path: string, method: string): FeatureGate | null {
  // Preview
  if (path === '/_auth/preview/authorize' || path === '/api/preview-url') {
    return PREVIEW_GATE;
  }

  // Deploy
  if (path === '/api/workflow/expose' && method === 'POST') {
    return DEPLOY_GATE;
  }

  // DB
  if (path.startsWith('/api/internal/db/')) {
    return DB_GATE;
  }

  // Projects
  if (path.startsWith('/api/internal/projects/') || path.startsWith('/_auth/projects/')) {
    return PROJECTS_GATE;
  }

  // Exec — all products allowed, no gate
  // Gates — all products allowed, no gate
  // Everything else — no restriction
  return null;
}

// ── 403 rate limiter ──
// Prevents rapid feature probing. Tighter than general API rate limit.
const REJECTION_LIMIT = 20;
const REJECTION_WINDOW_MS = 60_000;
const rejectionTracker = new Map<string, { count: number; resetTime: number }>();

function checkRejectionRateLimit(ip: string): boolean {
  const now = Date.now();
  const record = rejectionTracker.get(ip);

  if (!record || now > record.resetTime) {
    rejectionTracker.set(ip, { count: 1, resetTime: now + REJECTION_WINDOW_MS });
    return false;
  }

  record.count++;
  return record.count > REJECTION_LIMIT;
}

// Periodic cleanup to prevent memory leak from stale IPs
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rejectionTracker) {
    if (now > record.resetTime) rejectionTracker.delete(ip);
  }
}, 5 * 60_000);

function getClientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || '127.0.0.1';
}

/**
 * Create the restrictive engine middleware for a given product and billing tier.
 * Every request is classified. Gated routes are blocked if the product lacks access.
 */
export function createProductRestrictiveEngine(product: Product, billingTier: BillingTier) {
  return createMiddleware(async (c, next) => {
    c.set('product', product);
    c.set('billingTier', billingTier);

    const path = c.req.path;
    if (isExemptRoute(path)) return next();

    const gate = classifyRoute(path, c.req.method);
    if (!gate) return next();

    if (!gate.allowedProducts.has(product)) {
      const ip = getClientIp(c);
      if (checkRejectionRateLimit(ip)) {
        return c.text('Too many requests', 429);
      }
      return c.json({ error: gate.error, upgrade: true }, 403);
    }

    return next();
  });
}
