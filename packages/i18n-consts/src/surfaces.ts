// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Registry of user-facing translatable surfaces. Each surface has its own
 * messages file, its own indexability gate (where applicable), and its own
 * CDN path under `${TRANSLATIONS_CDN_URL}/<surface>/<locale>.json`.
 *
 * Add a new surface here when it joins the i18n pipeline. Adding a surface
 * is a deliberate decision — see TRANSLATIONS.md in @ellul.ai/i18n-messages.
 */
export const SURFACES = [
  "web",
  "console",
  "vps-ui",
  "docs",
] as const;

export type Surface = (typeof SURFACES)[number];

export function isSurface(value: unknown): value is Surface {
  return typeof value === "string" && (SURFACES as readonly string[]).includes(value);
}

/**
 * Whether a surface is publicly indexed by search engines. Console and
 * vps-ui are auth-walled and never indexed; web and docs are public.
 */
export const PUBLIC_SURFACES: ReadonlySet<Surface> = new Set([
  "web",
  "docs",
]);

export function isPublicSurface(surface: Surface): boolean {
  return PUBLIC_SURFACES.has(surface);
}
