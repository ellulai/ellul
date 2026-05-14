// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Scaffold template system — public API.
 *
 * Every scaffoldable framework ships a complete file tree under
 * `./trees/<id>/`. The hydrator walks the tree, substitutes
 * `{{PROJECT_NAME}}`, writes to the target scratch dir. No CLI
 * invocations, no network, no per-framework exception paths.
 *
 * Design invariants (enforced by `__tests__/coherence.test.ts`):
 *   1. Every frontend tree's landing file contains the canonical
 *      copy from `./landing`. A change to landing.ts fails the test
 *      until all trees update.
 *   2. Every Node template ships a package.json parseable by
 *      JSON.parse.
 *   3. Every tree id declared as scaffoldable in
 *      `@vps/shared/framework` has a matching tree directory.
 *   4. No tree ships a hardcoded color utility that bypasses the
 *      token system (`bg-black`, `dark:bg-*`, raw hex in class).
 */

export { DESIGN_TOKENS, type DesignTokens } from './design-tokens';
export { LANDING_COPY, allLandingPhrases } from './landing';
export {
  hydrateTemplate,
  listTemplateIds,
  hasTemplate,
  TemplateNotFoundError,
  TemplateManifestError,
  type HydrateInput,
  type HydrateOutput,
  type TreeManifest,
  type TreeEntry,
} from './hydrate';
