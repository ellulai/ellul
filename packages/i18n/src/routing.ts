// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { defineRouting } from "next-intl/routing";
import { createNavigation } from "next-intl/navigation";
import { notFound as nextNotFound } from "next/navigation";
import type { Locale } from "@ellul.ai/i18n-consts";
import { ALL_LOCALES, DEFAULT_LOCALE } from "@ellul.ai/i18n-consts";
import { LOCALE_COOKIE_NAME, getLocaleCookieDomain } from "./cookie";

export interface CreateI18nRoutingOptions {
  locales?: readonly Locale[];
  defaultLocale?: Locale;
  localePrefix?: "always" | "as-needed" | "never";
  localeDetection?: boolean;
}

export function createI18nRouting(options: CreateI18nRoutingOptions = {}) {
  const cookieDomain = getLocaleCookieDomain();
  const routing = defineRouting({
    locales: options.locales ?? ALL_LOCALES,
    defaultLocale: options.defaultLocale ?? DEFAULT_LOCALE,
    localeDetection: options.localeDetection ?? true,
    localePrefix: options.localePrefix ?? "as-needed",
    localeCookie: {
      name: LOCALE_COOKIE_NAME,
      ...(cookieDomain ? { domain: cookieDomain } : {}),
      maxAge: 60 * 60 * 24 * 365,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    },
  });

  const navigation = createNavigation(routing);

  return {
    routing,
    navigation,
    notFound: nextNotFound,
  };
}
