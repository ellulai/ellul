// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { describe, it, expect } from "vitest";
import {
  INDEXABLE_LOCALES_BY_SURFACE,
  NOINDEX_PATH_PATTERNS,
  REFERENCE_TRANSLATION_PATHS,
  isIndexableLocale,
  isNoIndexPath,
  isReferenceTranslationPath,
} from "../src/indexability";
import { ALL_LOCALES, type Locale } from "../src/locales";
import { SURFACES } from "../src/surfaces";

describe("indexability — gate invariants", () => {
  it("INDEXABLE_LOCALES_BY_SURFACE has a row for every Surface", () => {
    for (const surface of SURFACES) {
      expect(INDEXABLE_LOCALES_BY_SURFACE).toHaveProperty(surface);
      expect(INDEXABLE_LOCALES_BY_SURFACE[surface]).toBeInstanceOf(Set);
    }
  });

  it("private surfaces (console, vps-ui) are never indexable for any locale", () => {
    expect(INDEXABLE_LOCALES_BY_SURFACE.console.size).toBe(0);
    expect(INDEXABLE_LOCALES_BY_SURFACE["vps-ui"].size).toBe(0);
    for (const locale of ALL_LOCALES) {
      expect(isIndexableLocale("console", locale)).toBe(false);
      expect(isIndexableLocale("vps-ui", locale)).toBe(false);
    }
  });

  it("en is always indexable on public surfaces (web, docs)", () => {
    expect(isIndexableLocale("web", "en")).toBe(true);
    expect(isIndexableLocale("docs", "en")).toBe(true);
  });

  it("every member of every indexable set is a known Locale", () => {
    const allLocaleSet = new Set<string>(ALL_LOCALES);
    for (const surface of SURFACES) {
      for (const locale of INDEXABLE_LOCALES_BY_SURFACE[surface]) {
        expect(allLocaleSet.has(locale as Locale)).toBe(true);
      }
    }
  });

  it("isIndexableLocale agrees with the underlying Set", () => {
    for (const surface of SURFACES) {
      for (const locale of ALL_LOCALES) {
        expect(isIndexableLocale(surface, locale)).toBe(
          INDEXABLE_LOCALES_BY_SURFACE[surface].has(locale),
        );
      }
    }
  });

  it("noindex path patterns match expected internal-only routes", () => {
    expect(isNoIndexPath("/signup")).toBe(true);
    expect(isNoIndexPath("/signup/finish")).toBe(true);
    expect(isNoIndexPath("/api/something")).toBe(true);
    expect(isNoIndexPath("/_next/foo")).toBe(true);
    expect(isNoIndexPath("/preview/abc")).toBe(true);
    expect(isNoIndexPath("/")).toBe(false);
    expect(isNoIndexPath("/pricing")).toBe(false);
    expect(isNoIndexPath("/blog/post-slug")).toBe(false);
  });

  it("NOINDEX_PATH_PATTERNS is a non-empty list of regexes", () => {
    expect(NOINDEX_PATH_PATTERNS.length).toBeGreaterThan(0);
    for (const rx of NOINDEX_PATH_PATTERNS) {
      expect(rx).toBeInstanceOf(RegExp);
    }
  });

  it("reference-translation paths cover privacy + terms (legal-canonical-EN policy)", () => {
    expect(isReferenceTranslationPath("/privacy")).toBe(true);
    expect(isReferenceTranslationPath("/terms")).toBe(true);
    expect(isReferenceTranslationPath("/")).toBe(false);
    expect(isReferenceTranslationPath("/pricing")).toBe(false);
    expect(isReferenceTranslationPath("/privacy/foo")).toBe(false);
  });

  it("REFERENCE_TRANSLATION_PATHS is a non-empty list of regexes", () => {
    expect(REFERENCE_TRANSLATION_PATHS.length).toBeGreaterThan(0);
    for (const rx of REFERENCE_TRANSLATION_PATHS) {
      expect(rx).toBeInstanceOf(RegExp);
    }
  });
});
