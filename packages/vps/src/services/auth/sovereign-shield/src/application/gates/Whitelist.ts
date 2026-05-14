// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Whitelist Service
 *
 * Resolves which network destinations a shielded app is allowed to reach.
 * Builds the AllowedDestination[] list for nftables egress whitelist.
 *
 * Resolution priority per secret:
 *   1. User-specified allowedDestinations from DB (highest priority)
 *   2. Auto-parse URL values (DATABASE_URL, REDIS_URL, etc.)
 *   3. Well-known API key prefix match (STRIPE_SECRET_KEY → stripe endpoints)
 *   4. Fallback: warn that no destinations detected for this secret
 */

import type { AllowedDestination } from '../process/Netns';

// ── Well-known API key → destination mappings ──

const WELL_KNOWN: Record<string, AllowedDestination[]> = {
  STRIPE: [
    { host: 'api.stripe.com', port: 443, protocol: 'tcp' },
    { host: 'files.stripe.com', port: 443, protocol: 'tcp' },
  ],
  OPENAI: [
    { host: 'api.openai.com', port: 443, protocol: 'tcp' },
  ],
  ANTHROPIC: [
    { host: 'api.anthropic.com', port: 443, protocol: 'tcp' },
  ],
  RESEND: [
    { host: 'api.resend.com', port: 443, protocol: 'tcp' },
  ],
  CLERK: [
    { host: 'api.clerk.com', port: 443, protocol: 'tcp' },
    { host: 'api.clerk.dev', port: 443, protocol: 'tcp' },
  ],
  TWILIO: [
    { host: 'api.twilio.com', port: 443, protocol: 'tcp' },
  ],
  SENDGRID: [
    { host: 'api.sendgrid.com', port: 443, protocol: 'tcp' },
  ],
  SUPABASE: [
    { host: '*.supabase.co', port: 443, protocol: 'tcp' },
  ],
  FIREBASE: [
    { host: 'firebaseio.com', port: 443, protocol: 'tcp' },
    { host: 'googleapis.com', port: 443, protocol: 'tcp' },
  ],
  NEON: [
    { host: '*.neon.tech', port: 5432, protocol: 'tcp' },
  ],
  PLANETSCALE: [
    { host: '*.connect.psdb.cloud', port: 443, protocol: 'tcp' },
  ],
  UPSTASH: [
    { host: '*.upstash.io', port: 443, protocol: 'tcp' },
  ],
  TURSO: [
    { host: '*.turso.io', port: 443, protocol: 'tcp' },
  ],
  CONVEX: [
    { host: '*.convex.cloud', port: 443, protocol: 'tcp' },
  ],
  POSTMARK: [
    { host: 'api.postmarkapp.com', port: 443, protocol: 'tcp' },
  ],
  MAILGUN: [
    { host: 'api.mailgun.net', port: 443, protocol: 'tcp' },
  ],
  PUSHER: [
    { host: '*.pusher.com', port: 443, protocol: 'tcp' },
  ],
  ALGOLIA: [
    { host: '*.algolia.net', port: 443, protocol: 'tcp' },
    { host: '*.algolianet.com', port: 443, protocol: 'tcp' },
  ],
  SENTRY: [
    { host: '*.sentry.io', port: 443, protocol: 'tcp' },
  ],
  CLOUDINARY: [
    { host: 'api.cloudinary.com', port: 443, protocol: 'tcp' },
    { host: 'res.cloudinary.com', port: 443, protocol: 'tcp' },
  ],
  AWS: [
    { host: '*.amazonaws.com', port: 443, protocol: 'tcp' },
  ],
};

// ── Default port by protocol ──

function defaultPort(protocol: string): number {
  switch (protocol.replace(':', '').toLowerCase()) {
    case 'https': return 443;
    case 'http': return 80;
    case 'postgresql':
    case 'postgres': return 5432;
    case 'mysql': return 3306;
    case 'redis':
    case 'rediss': return 6379;
    case 'mongodb':
    case 'mongodb+srv': return 27017;
    case 'amqp':
    case 'amqps': return 5672;
    default: return 443;
  }
}

// ── URL parsing ──

/**
 * Try to parse a secret value as a URL and extract the destination.
 * Handles connection strings: postgresql://, mysql://, redis://, mongodb://, amqp://, https://
 */
function parseUrlDestination(value: string): AllowedDestination | null {
  try {
    const url = new URL(value);
    if (!url.hostname) return null;
    const port = url.port ? parseInt(url.port, 10) : defaultPort(url.protocol);
    return { host: url.hostname, port, protocol: 'tcp' };
  } catch {
    return null;
  }
}

// ── Well-known key matching ──

/**
 * Match a secret name against well-known API key patterns.
 * e.g. STRIPE_SECRET_KEY → STRIPE, OPENAI_API_KEY → OPENAI
 */
function matchWellKnown(secretName: string): AllowedDestination[] {
  const upper = secretName.toUpperCase();
  for (const [prefix, destinations] of Object.entries(WELL_KNOWN)) {
    if (upper.includes(prefix)) {
      return destinations;
    }
  }
  return [];
}

// ── User override parsing ──

/**
 * Parse user-specified destinations string.
 * Format: JSON array of "host:port" strings, or "host" (defaults to 443/tcp).
 */
function parseUserOverrides(json: string | null | undefined): AllowedDestination[] {
  if (!json) return [];
  try {
    const items: string[] = JSON.parse(json);
    return items.map((item) => {
      const [host, portStr] = item.split(':');
      return {
        host: host!,
        port: portStr ? parseInt(portStr, 10) : 443,
        protocol: 'tcp' as const,
      };
    });
  } catch {
    return [];
  }
}

// ── Main resolver ──

/**
 * Resolve all allowed destinations for a set of secrets.
 *
 * @param secrets      Map of secret name → value
 * @param overrides    Optional per-secret user overrides (secret name → JSON destinations string)
 * @returns            Deduplicated list of allowed destinations
 */
export function resolveDestinations(
  secrets: Map<string, string>,
  overrides?: Record<string, string | null>,
): AllowedDestination[] {
  const destinations: AllowedDestination[] = [];
  const seen = new Set<string>();

  function addDest(dest: AllowedDestination): void {
    const key = `${dest.host}:${dest.port}:${dest.protocol}`;
    if (seen.has(key)) return;
    seen.add(key);
    destinations.push(dest);
  }

  for (const [name, value] of secrets) {
    // Priority 1: User overrides
    if (overrides?.[name]) {
      for (const dest of parseUserOverrides(overrides[name])) {
        addDest(dest);
      }
      continue; // User override takes priority — skip auto-detection
    }

    // Priority 2: Auto-parse URL values
    const urlDest = parseUrlDestination(value);
    if (urlDest) {
      addDest(urlDest);
      continue; // URL parsed successfully — skip well-known match
    }

    // Priority 3: Well-known API key prefix match
    const wellKnown = matchWellKnown(name);
    if (wellKnown.length > 0) {
      for (const dest of wellKnown) addDest(dest);
      continue;
    }

    // Fallback: log warning (no destinations detected)
    console.warn(`[whitelist] No destination detected for secret: ${name}`);
  }

  return destinations;
}
