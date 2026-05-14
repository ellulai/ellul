// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Client-side i18n primitives. Wraps `use-intl` so surfaces (Next Client
 * Components AND non-Next React surfaces like vps-ui) can import the same
 * hooks from the same place.
 *
 * `useTranslations` / `useFormatter` work identically in next-intl-wrapped
 * client components and standalone use-intl-wrapped React trees. Only the
 * provider wiring differs (NextIntlClientProvider vs IntlProvider).
 */
export {
  useTranslations,
  useFormatter,
  useLocale,
  useNow,
  useTimeZone,
  IntlProvider,
} from "use-intl";
