// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import type { Locale } from "@ellul.ai/i18n-consts";

export const LOCALE_COOKIE_NAME = "NEXT_LOCALE";
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function getLocaleCookieDomain(): string | undefined {
  if (typeof process === "undefined") return undefined;
  if (process.env.NODE_ENV !== "production") return undefined;
  return process.env.NEXT_PUBLIC_COOKIE_DOMAIN || ".ellul.ai";
}

export function writeLocaleCookie(locale: Locale): void {
  if (typeof document === "undefined") return;
  const parts = [
    `${LOCALE_COOKIE_NAME}=${encodeURIComponent(locale)}`,
    "path=/",
    `max-age=${LOCALE_COOKIE_MAX_AGE}`,
    "samesite=lax",
  ];
  const domain = getLocaleCookieDomain();
  if (domain) parts.push(`domain=${domain}`);
  if (typeof location !== "undefined" && location.protocol === "https:") {
    parts.push("secure");
  }
  document.cookie = parts.join("; ");
}
