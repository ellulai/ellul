// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Server-side i18n primitives. Wraps next-intl/server so surfaces can
 * import everything they need from a single package.
 *
 * Use this in Server Components, Server Actions, and route handlers.
 * For Client Components, use `@ellul.ai/i18n/client` instead.
 */
export {
  getTranslations,
  getMessages,
  getLocale,
  getFormatter,
  getNow,
  getTimeZone,
  setRequestLocale,
} from "next-intl/server";
export { NextIntlClientProvider } from "next-intl";
