// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { type ReactNode, useEffect } from "react";
import { IntlProvider } from "use-intl";
import { isRtlLocale } from "@ellul.ai/i18n-consts";
import { getMessagesForLocale } from "./messages";
import { useLocaleResolution } from "./useLocale";

export function IntlRoot({ children }: { children: ReactNode }) {
  const { locale, injectionMissing } = useLocaleResolution();
  const messages = getMessagesForLocale(locale);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.lang = locale;
    document.documentElement.dir = isRtlLocale(locale) ? "rtl" : "ltr";
  }, [locale]);

  return (
    <IntlProvider locale={locale} messages={messages} timeZone="UTC">
      {injectionMissing ? <LocaleInjectionBanner /> : null}
      {children}
    </IntlProvider>
  );
}

function LocaleInjectionBanner() {
  return (
    <div
      role="status"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 2147483647,
        padding: "6px 12px",
        background: "#7c2d12",
        color: "#fed7aa",
        font: "12px/1.4 system-ui, sans-serif",
        textAlign: "center",
        borderBottom: "1px solid #9a3412",
      }}
    >
      Locale unavailable — using English. The VPS host did not inject
      <code style={{ margin: "0 4px" }}>window.__SHIELD_SETTINGS__.locale</code>.
      Reload; if this persists, contact support.
    </div>
  );
}
