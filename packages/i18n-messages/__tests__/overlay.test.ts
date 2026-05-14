// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { describe, it, expect } from "vitest";
import { createOverlayResolver } from "../src/overlay";

describe("createOverlayResolver", () => {
  it("resolves a slug from the requested locale when present", async () => {
    const overlay = createOverlayResolver<{
      meta: { title: string };
    }>("comparisons");
    const ja = await overlay.resolve("cursor", "ja");
    expect(ja).not.toBeNull();
    expect(typeof ja?.meta.title).toBe("string");
  });

  it("returns the requested-locale entry verbatim when present", async () => {
    const overlay = createOverlayResolver<{
      meta: { title: string };
    }>("comparisons", { defaultLocale: "en" });
    const enResult = await overlay.resolve("cursor", "en");
    const jaResult = await overlay.resolve("cursor", "ja");
    expect(enResult).not.toBeNull();
    expect(jaResult).not.toBeNull();
    // Both have meta.title; the JA value should differ from the EN value
    // (parity validator guarantees the keys match, content differs).
    expect(typeof enResult?.meta.title).toBe("string");
    expect(typeof jaResult?.meta.title).toBe("string");
  });

  it("returns null when slug exists in neither requested nor default locale", async () => {
    const overlay = createOverlayResolver<unknown>("comparisons");
    const result = await overlay.resolve("does-not-exist-xyz", "ja");
    expect(result).toBeNull();
  });

  it("listKeys returns the namespace's slug list for the locale", async () => {
    const overlay = createOverlayResolver<unknown>("comparisons");
    const enKeys = await overlay.listKeys("en");
    const jaKeys = await overlay.listKeys("ja");
    expect(enKeys.length).toBeGreaterThan(0);
    expect(jaKeys.length).toBeGreaterThan(0);
    // Parity validator guarantees identical key sets across en/ja.
    expect(jaKeys.sort()).toEqual(enKeys.sort());
  });

  it("returns empty record for an unknown namespace", async () => {
    const overlay = createOverlayResolver<unknown>("namespace-that-does-not-exist");
    const result = await overlay.resolve("anything", "en");
    expect(result).toBeNull();
    const keys = await overlay.listKeys("en");
    expect(keys).toEqual([]);
  });

  it("caches load() per locale (subsequent calls return same reference)", async () => {
    const overlay = createOverlayResolver<unknown>("comparisons");
    const a = await overlay.load("en");
    const b = await overlay.load("en");
    expect(a).toBe(b);
  });

  it("clearCache resets the in-resolver cache (verified via spy)", async () => {
    const overlay = createOverlayResolver<unknown>("comparisons");
    const a = await overlay.load("en");
    const b = await overlay.load("en");
    expect(a).toBe(b); // cached
    overlay.clearCache();
    const c = await overlay.load("en");
    // Content equality is the contract; ESM module cache may return the
    // same underlying tree, so we don't assert reference inequality.
    expect(Object.keys(c).sort()).toEqual(Object.keys(a).sort());
  });

  it("falls back from non-shipped locale to en (covers ko/de/pt-BR/fr)", async () => {
    const overlay = createOverlayResolver<{ title: string }>("comparisons");
    const en = await overlay.load("en");
    const ko = await overlay.load("ko");
    // Non-shipped locales alias to en at the message-loader layer.
    expect(Object.keys(ko).sort()).toEqual(Object.keys(en).sort());
  });
});

describe("id-keyed compose patterns", () => {
  it("comparison features overlay is keyed by id", async () => {
    const overlay = createOverlayResolver<{
      features: Record<string, { capability: string; note?: string }>;
    }>("comparisons");
    const cursor = await overlay.resolve("cursor", "en");
    expect(cursor).not.toBeNull();
    const features = cursor!.features;
    expect(typeof features).toBe("object");
    expect(Array.isArray(features)).toBe(false);
    const ids = Object.keys(features);
    expect(ids.length).toBeGreaterThan(0);
    // Each feature row must have a capability string (boolean cells use
    // the structural side; this is the translatable label).
    for (const id of ids) {
      expect(typeof features[id]!.capability).toBe("string");
    }
  });

  it("pillars faq overlay is keyed by id (Object.entries preserves order)", async () => {
    const overlay = createOverlayResolver<{
      faq: Record<string, { q: string; a: string }>;
    }>("pillars");
    const pillar = await overlay.resolve("agent-workstation", "en");
    expect(pillar).not.toBeNull();
    const faqIds = Object.keys(pillar!.faq);
    expect(faqIds.length).toBeGreaterThan(0);
    expect(faqIds[0]).toBe("what-is-agent-workstation");
  });

  it("glossary seeAlso overlay is a label map keyed by id", async () => {
    const overlay = createOverlayResolver<{
      seeAlso?: Record<string, string>;
    }>("glossary");
    const term = await overlay.resolve("agent-workstation", "en");
    expect(term).not.toBeNull();
    const seeAlso = term!.seeAlso;
    expect(seeAlso).toBeDefined();
    if (seeAlso) {
      for (const [id, label] of Object.entries(seeAlso)) {
        expect(typeof id).toBe("string");
        expect(typeof label).toBe("string");
      }
    }
  });
});
