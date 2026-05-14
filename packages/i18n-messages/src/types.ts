// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import type messages from "../messages/en";

/**
 * The full shape of the canonical English message tree. Used by surfaces
 * to type-augment the global `IntlMessages` interface so `t("key.path")`
 * checks at compile time and autocomplete works in IDEs.
 *
 * Surfaces opt in by adding a single line to a `.d.ts` in their src tree:
 *
 *   import "@ellul.ai/i18n-messages/types";
 *
 * That import triggers the `declare global` below and binds
 * next-intl's / use-intl's message-key checking to this canonical tree.
 */
export type AppMessages = typeof messages;

declare global {
  // The next-intl / use-intl inference surface. Augmenting an interface
  // (rather than redeclaring a type) lets multiple sources contribute,
  // but here we have a single canonical tree.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface IntlMessages extends AppMessages {}
}
