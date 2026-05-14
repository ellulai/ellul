// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import type { Locale } from "@ellul.ai/i18n-consts";
import en from "@ellul.ai/i18n-messages/messages/en";
import ja from "@ellul.ai/i18n-messages/messages/ja";

type MessageTree = typeof en;

/**
 * Vite consumers static-import the centralized message tree per locale.
 * Webpack/Vite bundles only the locales referenced here. Locales without a
 * shipped translation alias to English content; the locale itself is still
 * tagged correctly via `<html lang>` and metadata.
 */
const TREES: Record<Locale, MessageTree> = {
  en,
  ja,
  ko: en,
  de: en,
  "pt-BR": en,
  fr: en,
};

export function getMessagesForLocale(locale: Locale): MessageTree {
  return TREES[locale];
}
