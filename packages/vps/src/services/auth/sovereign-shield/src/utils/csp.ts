// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Content Security Policy helpers
 *
 * Nonce-based CSP for auth pages to prevent XSS.
 */

import crypto from 'crypto';
import { CONSOLE_ORIGIN } from '../config';

/**
 * Generate a cryptographically random nonce for CSP script-src.
 */
export function generateCspNonce(): string {
  return crypto.randomBytes(16).toString('base64');
}

/**
 * Build a CSP header value for auth pages.
 * Uses nonce-based script-src so only inline scripts with the matching
 * nonce attribute are allowed to execute.
 */
export function getCspHeader(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'unsafe-inline'`,
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    `frame-ancestors 'self' ${CONSOLE_ORIGIN}`,
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

/**
 * Strict CSP for static error/info pages that have no scripts.
 * Blocks all script execution — defense in depth against future regressions.
 */
export function getStaticPageCspHeader(): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `frame-ancestors 'self' ${CONSOLE_ORIGIN}`,
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}
