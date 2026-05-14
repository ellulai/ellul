// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Static Routes
 *
 * Serves static assets like session-pop.js and vendored libraries.
 *
 * Endpoints:
 * - GET /_auth/static/session-pop.js         - PoP client library
 * - GET /_auth/static/simplewebauthn-browser.js - Vendored @simplewebauthn/browser@11.0.0
 */

import type { Hono } from 'hono';
import { SESSION_POP_JS } from '../auth/pop';
import { SIMPLEWEBAUTHN_BROWSER_JS } from '../vendor/simplewebauthn-browser-content';
import BRIDGE_CLIENT_JS_TEMPLATE from '../static/bridge-client.js';
import { VALID_OPERATIONS } from '../../../../../auth/valid-operations';
import { PLATFORM_ZONE, APP_ZONE, CONSOLE_ORIGIN } from '../config';

// Substitute placeholders in bridge-client.js at module load time.
// The .js file can't import TS at runtime, so we stamp it once per service startup.
//   __VALID_OPERATIONS__   — JSON array of allowed confirm-operation names
//   __DASHBOARD_ORIGINS__  — JSON array of trusted parent origins (console)
//   __SUBDOMAIN_PATTERN__  — regex source (as JSON string) matching platform + app zone subdomains
function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const subdomainPatternSource =
  `^https://[a-zA-Z0-9-]+\\.(${escapeForRegex(PLATFORM_ZONE)}|${escapeForRegex(APP_ZONE)})$`;

// Dashboard origins: console + platform apex (e.g. https://console.ellul.ai
// + https://ellul.ai). The landing page at the apex can embed the bridge iframe,
// so apex must be trusted. Preserves the previous hardcoded behavior.
const DASHBOARD_ORIGINS = [CONSOLE_ORIGIN, `https://${PLATFORM_ZONE}`];

const BRIDGE_CLIENT_JS = BRIDGE_CLIENT_JS_TEMPLATE
  .replace('__VALID_OPERATIONS__', JSON.stringify(VALID_OPERATIONS))
  .replace('__DASHBOARD_ORIGINS__', JSON.stringify(DASHBOARD_ORIGINS))
  .replace('__SUBDOMAIN_PATTERN__', JSON.stringify(subdomainPatternSource));

/**
 * Register static asset routes on Hono app
 */
export function registerStaticRoutes(app: Hono): void {
  /**
   * Serve session-pop.js - client-side PoP library
   */
  app.get('/_auth/static/session-pop.js', (c) => {
    c.header('Content-Type', 'application/javascript');
    // no-cache: browser must revalidate on every load. The PoP client is security-critical
    // and must always match the server's expected behavior. Stale cached versions cause
    // "atob" errors when the HMAC key format changes between deployments.
    c.header('Cache-Control', 'no-cache, must-revalidate');
    return c.body(SESSION_POP_JS);
  });

  /**
   * Serve vendored @simplewebauthn/browser — eliminates CDN supply-chain risk
   * Content is embedded at build time via TypeScript import (no runtime file reading)
   */
  app.get('/_auth/static/simplewebauthn-browser.js', (c) => {
    c.header('Content-Type', 'application/javascript');
    c.header('Cache-Control', 'public, max-age=86400');
    return c.body(SIMPLEWEBAUTHN_BROWSER_JS);
  });

  /**
   * Serve bridge-client.js - bridge iframe client-side module
   */
  app.get('/_auth/static/bridge-client.js', (c) => {
    c.header('Content-Type', 'application/javascript');
    c.header('Cache-Control', 'no-store');
    return c.body(BRIDGE_CLIENT_JS);
  });
}
