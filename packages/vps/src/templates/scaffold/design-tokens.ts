// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Scaffold Design Tokens — single source of truth.
 *
 * Every frontend scaffold template (Next, Vite, Nuxt, SvelteKit, Astro, …)
 * reads its theme from THIS object. The CSS generator emits these values
 * as CSS custom properties; the page-component generator references the
 * same names as Tailwind v4 semantic tokens (`bg-background`, `text-foreground`).
 *
 * One edit here re-themes every framework's scaffold. Components never
 * hardcode colors — they reference tokens, so `user agent edits globals.css`
 * and `user agent edits page.tsx` converge on the same visible UI.
 *
 * Enterprise contract:
 *   - No scaffold template may hardcode a color utility that bypasses the
 *     token system (e.g. `dark:bg-black`). The coherence test in
 *     __tests__/coherence.test.ts enforces this.
 *   - Scaffolds ship a SINGLE color scheme (no `@media (prefers-color-scheme: dark)`
 *     override). A dark media-query block silently shadows single-value edits
 *     when the browser's OS theme is dark — breaking the "edit --background
 *     and see the page change" promise. Runtime themes are opt-in on top.
 *   - Token names are stable across framework versions. Adding a new token
 *     is additive; removing a token is a breaking change requiring a
 *     migration for every generated template.
 *   - CSS names (`--background`) and Tailwind names (`bg-background`) are
 *     derived from the SAME key so they can never drift.
 */

/**
 * Canonical token set. Keys become `--${key}` in CSS and `bg-${key}` /
 * `text-${key}` (as applicable) in Tailwind v4's `@theme inline` block.
 */
export const DESIGN_TOKENS = {
  colors: {
    background: '#ffffff',
    foreground: '#171717',
  } satisfies Record<string, string>,
  /**
   * Font CSS-var names exposed by each framework's bundler integration.
   * Generators use these to wire the Tailwind `font-sans` / `font-mono`
   * tokens to whatever the scaffold's font loader produced.
   */
  fonts: {
    sans: '--font-geist-sans',
    mono: '--font-geist-mono',
  } as const,
  /**
   * Fallback font stack used by `body` when the framework's font var
   * isn't yet defined (SSR first paint, missing font provider, etc.).
   */
  fontFallback:
    'Arial, Helvetica, sans-serif',
} as const;

export type DesignTokens = typeof DESIGN_TOKENS;
