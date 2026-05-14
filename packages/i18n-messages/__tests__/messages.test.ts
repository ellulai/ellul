// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { describe, it, expect } from "vitest";
import en from "../messages/en";
import ja from "../messages/ja";

function flatten(obj: unknown, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        Object.assign(out, flatten(v, p));
      } else if (typeof v === "string") {
        out[p] = v;
      }
    }
  }
  return out;
}

describe("centralized messages tree", () => {
  it("en has top-level namespaces for every shipped surface", () => {
    expect(en).toHaveProperty("brand");
    expect(en).toHaveProperty("auth");
    expect(en).toHaveProperty("tier");
    expect(en).toHaveProperty("common");
    expect(en).toHaveProperty("home");
    expect(en).toHaveProperty("pricing");
    expect(en).toHaveProperty("nav");
    expect(en).toHaveProperty("footer");
    expect(en).toHaveProperty("signIn");
    expect(en).toHaveProperty("signUp");
    expect(en).toHaveProperty("console");
  });

  it("en and ja have identical key trees", () => {
    const enKeys = new Set(Object.keys(flatten(en)));
    const jaKeys = new Set(Object.keys(flatten(ja)));
    const missing = [...enKeys].filter((k) => !jaKeys.has(k));
    const extra = [...jaKeys].filter((k) => !enKeys.has(k));
    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
  });

  it("ICU placeholders match byte-for-byte across en and ja", () => {
    const enFlat = flatten(en);
    const jaFlat = flatten(ja);
    const placeholderRx = /\{[^}]+\}/g;
    const drift: Array<{ key: string; en: string[]; ja: string[] }> = [];
    for (const [key, enVal] of Object.entries(enFlat)) {
      const jaVal = jaFlat[key];
      if (typeof jaVal !== "string") continue;
      const enP = (enVal.match(placeholderRx) ?? []).slice().sort();
      const jaP = (jaVal.match(placeholderRx) ?? []).slice().sort();
      if (JSON.stringify(enP) !== JSON.stringify(jaP)) {
        drift.push({ key, en: enP, ja: jaP });
      }
    }
    expect(drift).toEqual([]);
  });

  it("rich-text tag names match byte-for-byte across en and ja", () => {
    const enFlat = flatten(en);
    const jaFlat = flatten(ja);
    const tagRx = /<[a-z]+>|<\/[a-z]+>/gi;
    const drift: Array<{ key: string; en: string[]; ja: string[] }> = [];
    for (const [key, enVal] of Object.entries(enFlat)) {
      const jaVal = jaFlat[key];
      if (typeof jaVal !== "string") continue;
      const enT = (enVal.match(tagRx) ?? []).slice().sort();
      const jaT = (jaVal.match(tagRx) ?? []).slice().sort();
      if (JSON.stringify(enT) !== JSON.stringify(jaT)) {
        drift.push({ key, en: enT, ja: jaT });
      }
    }
    expect(drift).toEqual([]);
  });

  it("brand.tagline differs between en and ja (translation actually applied)", () => {
    expect((en.brand as { tagline: string }).tagline).not.toBe(
      (ja.brand as { tagline: string }).tagline,
    );
  });

  it("tier.hobby.name is 'Hobby' in en and translated in ja", () => {
    expect((en.tier as { hobby: { name: string } }).hobby.name).toBe("Hobby");
    expect((ja.tier as { hobby: { name: string } }).hobby.name).not.toBe("Hobby");
  });
});
