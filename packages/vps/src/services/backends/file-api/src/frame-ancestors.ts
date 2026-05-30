// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.
//
// Single source of the CSP `frame-ancestors` allowlist for sandbox-served UI.
// file-api is the ONLY emitter of frame-ancestors on the tenant data path (the
// tenant Caddy reverse-proxies and passes this CSP through untouched), so this
// is the one place the allowlist is resolved.
//
// Two files, two jobs:
//   /etc/ellul/console-origins  — the per-tenant framing allowlist (space- or
//     newline-separated bare origins). Authoritative when present + non-empty.
//   /etc/ellul/console-origin   — shield's single-origin source of truth and the
//     first-party default. Used only as the fallback when the plural file is absent.

import * as fs from 'fs';

// Overridable for tests; default to the canonical /etc/ellul paths.
const originsFile = (): string => process.env.CONSOLE_ORIGINS_PATH || '/etc/ellul/console-origins';
const originFile = (): string => process.env.CONSOLE_ORIGIN_PATH || '/etc/ellul/console-origin';

/** Allowed framing origins (bare, never including `'self'`). Tenant list, else the singular fallback. */
export function frameAncestorOrigins(): string[] {
  try {
    const list = fs
      .readFileSync(originsFile(), 'utf8')
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length > 0) return list;
  } catch {
    /* plural file absent — fall through to the singular */
  }
  try {
    const single = fs.readFileSync(originFile(), 'utf8').trim();
    if (single) return [single];
  } catch {
    /* neither file present */
  }
  return [];
}

/** The full `frame-ancestors` directive VALUE: `'self'` + the allowed origins. */
export function frameAncestorsValue(): string {
  return ["'self'", ...frameAncestorOrigins()].join(' ');
}
