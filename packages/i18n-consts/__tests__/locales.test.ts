// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { describe, it, expect } from "vitest";
import {
  ALL_LOCALES,
  DEFAULT_LOCALE,
  GLIBC_LOCALE,
  LOCALES_TO_TRANSLATE,
  LOCALE_DISPLAY,
  OG_LOCALE,
  RTL_LOCALES,
  coerceLocale,
  isLocale,
  isRtlLocale,
} from "../src/locales";

describe("locale data tables — completeness across all 6 locales", () => {
  it("ALL_LOCALES is the union of every per-locale row", () => {
    expect(new Set(Object.keys(LOCALE_DISPLAY))).toEqual(new Set(ALL_LOCALES));
    expect(new Set(Object.keys(OG_LOCALE))).toEqual(new Set(ALL_LOCALES));
    expect(new Set(Object.keys(GLIBC_LOCALE))).toEqual(new Set(ALL_LOCALES));
  });

  it.each(ALL_LOCALES)("LOCALE_DISPLAY[%s] has name + nativeName + flag", (locale) => {
    const row = LOCALE_DISPLAY[locale];
    expect(row).toBeDefined();
    expect(typeof row.name).toBe("string");
    expect(row.name.length).toBeGreaterThan(0);
    expect(typeof row.nativeName).toBe("string");
    expect(row.nativeName.length).toBeGreaterThan(0);
    expect(typeof row.flag).toBe("string");
    expect(row.flag.length).toBeGreaterThan(0);
  });

  it.each(ALL_LOCALES)("OG_LOCALE[%s] is xx_XX form", (locale) => {
    const og = OG_LOCALE[locale];
    expect(og).toMatch(/^[a-z]{2}_[A-Z]{2}$/);
  });

  it.each(ALL_LOCALES)("GLIBC_LOCALE[%s] is xx_XX.UTF-8 form", (locale) => {
    const glibc = GLIBC_LOCALE[locale];
    expect(glibc).toMatch(/^[a-z]{2}_[A-Z]{2}\.UTF-8$/);
  });

  it("DEFAULT_LOCALE is the canonical en", () => {
    expect(DEFAULT_LOCALE).toBe("en");
    expect(ALL_LOCALES).toContain(DEFAULT_LOCALE);
  });

  it("LOCALES_TO_TRANSLATE excludes en and includes every other locale", () => {
    expect(LOCALES_TO_TRANSLATE).not.toContain("en");
    for (const locale of ALL_LOCALES) {
      if (locale === DEFAULT_LOCALE) continue;
      expect(LOCALES_TO_TRANSLATE).toContain(locale);
    }
  });

  it("none of our 6 launch locales are RTL", () => {
    for (const locale of ALL_LOCALES) {
      expect(isRtlLocale(locale)).toBe(false);
    }
  });

  it("RTL_LOCALES future-proofs ar + he but they are not in ALL_LOCALES yet", () => {
    expect(RTL_LOCALES.has("ar")).toBe(true);
    expect(RTL_LOCALES.has("he")).toBe(true);
    expect((ALL_LOCALES as readonly string[]).includes("ar")).toBe(false);
    expect((ALL_LOCALES as readonly string[]).includes("he")).toBe(false);
  });

  it("isLocale + coerceLocale recognize every shipped locale and reject garbage", () => {
    for (const locale of ALL_LOCALES) {
      expect(isLocale(locale)).toBe(true);
      expect(coerceLocale(locale)).toBe(locale);
    }
    expect(isLocale("xx")).toBe(false);
    expect(isLocale(42)).toBe(false);
    expect(coerceLocale("xx")).toBe(DEFAULT_LOCALE);
    expect(coerceLocale(undefined)).toBe(DEFAULT_LOCALE);
  });

  it("native names look like the language they claim — quick mojibake guard", () => {
    expect(LOCALE_DISPLAY.ja.nativeName).toBe("日本語");
    expect(LOCALE_DISPLAY.ko.nativeName).toBe("한국어");
    expect(LOCALE_DISPLAY.de.nativeName).toBe("Deutsch");
    expect(LOCALE_DISPLAY["pt-BR"].nativeName).toBe("Português");
    expect(LOCALE_DISPLAY.fr.nativeName).toBe("Français");
  });
});
