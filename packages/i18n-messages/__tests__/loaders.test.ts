// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { describe, it, expect } from "vitest";
import { ALL_LOCALES, type Locale } from "@ellul.ai/i18n-consts";
import {
  loadMessages,
  isShippedLocale,
  SHIPPED_LOCALES,
  messageLoaders,
} from "../src/loaders";

describe("messageLoaders", () => {
  it("has an entry for every locale in ALL_LOCALES", () => {
    for (const locale of ALL_LOCALES) {
      expect(messageLoaders[locale]).toBeDefined();
      expect(typeof messageLoaders[locale]).toBe("function");
    }
  });

  it("loadMessages('en') returns a non-empty tree with brand + auth + tier", async () => {
    const tree = await loadMessages("en");
    expect(tree).toHaveProperty("brand");
    expect(tree).toHaveProperty("auth");
    expect(tree).toHaveProperty("tier");
    expect(Object.keys(tree).length).toBeGreaterThan(5);
  });

  it("loadMessages('ja') returns a Japanese tree with translated brand.tagline", async () => {
    const tree = await loadMessages("ja");
    const brand = tree.brand as { tagline: string };
    expect(brand.tagline).toContain("コンピューター");
  });

  it("non-shipped locale loaders alias to English content", async () => {
    const enTree = await loadMessages("en");
    for (const locale of ALL_LOCALES) {
      if (isShippedLocale(locale)) continue;
      const tree = await loadMessages(locale as Locale);
      const enBrand = enTree.brand as { tagline: string };
      const xBrand = tree.brand as { tagline: string };
      expect(xBrand.tagline).toBe(enBrand.tagline);
    }
  });

  it("isShippedLocale agrees with SHIPPED_LOCALES set membership", () => {
    for (const locale of ALL_LOCALES) {
      expect(isShippedLocale(locale)).toBe(SHIPPED_LOCALES.has(locale));
    }
  });

  it("SHIPPED_LOCALES at minimum contains the canonical English locale", () => {
    expect(SHIPPED_LOCALES.has("en")).toBe(true);
  });
});
