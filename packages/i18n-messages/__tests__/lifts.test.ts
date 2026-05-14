// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Coverage tests for the namespaces and keys added during the JA-blueprint
// translation pass. They guard against silent drift when a future locale
// (ko, de, pt-BR, fr) is added: every key here must exist in en + ja and
// every future-locale parity check must keep them aligned.

import { describe, it, expect } from "vitest";
import { loadMessages } from "../src/loaders";

const REQUIRED_RAW_MD_KEYS = [
  "labelPublished",
  "labelUpdated",
  "labelLastUpdated",
  "labelVendor",
  "labelPricing",
  "labelTag",
  "labelRaw",
  "labelSynonyms",
  "headingContext",
  "headingRelated",
  "headingSeeAlso",
  "headingFaq",
  "headingCapabilities",
  "headingCapabilitiesOnEllul",
  "headingFeatureComparison",
  "headingPricing",
  "headingVerdict",
  "headingWhenToUse",
  "valueYes",
  "valueNo",
  "tableCapability",
  "tableAdvantage",
  "tableTier",
  "labelFundamentalDifference",
  "whereStrong",
  "whereEllulStronger",
  "useWhen",
  "useEllulWhen",
  "agentsHubHeader",
  "agentsHubIntro",
  "stubStatus",
  "advantageEllul",
  "advantageCompetitor",
  "advantageTie",
] as const;

const REQUIRED_OG_DETAIL_KEYS = [
  "vsDetail",
  "solutionsDetail",
  "agentsDetail",
  "mcpDetail",
] as const;

const REQUIRED_WEB_DOCS_SECTIONS = [
  "meta",
  "layout",
  "mission",
  "gettingStarted",
  "useCases",
  "security",
  "architecture",
  "cta",
] as const;

const REQUIRED_WEB_DOCS_STEP_IDS = [
  "create-account",
  "launch-sandbox",
  "build-with-ai",
] as const;

const REQUIRED_WEB_DOCS_USE_CASE_IDS = [
  "agent-security",
  "financial-isolation",
  "platform-embedding",
  "compliance",
] as const;

const REQUIRED_WEB_DOCS_SECURITY_IDS = [
  "capability-report",
  "liveness-ping",
  "manual-mode",
  "self-hash-attest",
  "self-test",
  "sha256-drift-check",
  "signed-manifest",
] as const;

const REQUIRED_WEB_DOCS_ARCH_IDS = [
  "foundry",
  "control",
  "studio",
  "core-invariant",
] as const;

describe("home.meta lifts", () => {
  for (const locale of ["en", "ja"] as const) {
    it(`${locale}: home.meta.keywords[] is non-empty array`, async () => {
      const m = (await loadMessages(locale)) as {
        home: { meta: { keywords: string[] } };
      };
      expect(Array.isArray(m.home.meta.keywords)).toBe(true);
      expect(m.home.meta.keywords.length).toBeGreaterThan(5);
      for (const k of m.home.meta.keywords) {
        expect(typeof k).toBe("string");
        expect(k.length).toBeGreaterThan(0);
      }
    });

    it(`${locale}: home.llmsTxt.summary is non-empty string`, async () => {
      const m = (await loadMessages(locale)) as {
        home: { llmsTxt: { summary: string } };
      };
      expect(typeof m.home.llmsTxt.summary).toBe("string");
      expect(m.home.llmsTxt.summary.length).toBeGreaterThan(20);
    });

    it(`${locale}: home.softwareSchema.applicationSubCategory present`, async () => {
      const m = (await loadMessages(locale)) as {
        home: { softwareSchema: { applicationSubCategory: string } };
      };
      expect(typeof m.home.softwareSchema.applicationSubCategory).toBe(
        "string",
      );
      expect(m.home.softwareSchema.applicationSubCategory.length).toBeGreaterThan(
        0,
      );
    });
  }

  it("ja keywords are JA, not EN copy", async () => {
    const ja = (await loadMessages("ja")) as {
      home: { meta: { keywords: string[] } };
    };
    const en = (await loadMessages("en")) as {
      home: { meta: { keywords: string[] } };
    };
    // At least one keyword should differ from EN (translated, not copied).
    const intersection = ja.home.meta.keywords.filter((k) =>
      en.home.meta.keywords.includes(k),
    );
    expect(intersection.length).toBeLessThan(en.home.meta.keywords.length);
  });
});

describe("pages.rawMd labels", () => {
  for (const locale of ["en", "ja"] as const) {
    it(`${locale}: pages.rawMd has all required label keys`, async () => {
      const m = (await loadMessages(locale)) as {
        pages: { rawMd: Record<string, unknown> };
      };
      for (const key of REQUIRED_RAW_MD_KEYS) {
        expect(m.pages.rawMd).toHaveProperty(key);
        expect(typeof m.pages.rawMd[key]).toBe("string");
      }
    });

    it(`${locale}: pages.mcpHub.rawMd has labelKind, labelVendor, intro, header`, async () => {
      const m = (await loadMessages(locale)) as {
        pages: {
          mcpHub: { rawMd: Record<string, string> };
        };
      };
      for (const key of [
        "header",
        "intro",
        "labelKind",
        "labelVendor",
        "labelRaw",
        "stubStatus",
      ] as const) {
        expect(m.pages.mcpHub.rawMd).toHaveProperty(key);
        expect(typeof m.pages.mcpHub.rawMd[key]).toBe("string");
      }
    });
  }

  it("vs raw.md template placeholders preserved across locales", async () => {
    for (const locale of ["en", "ja"] as const) {
      const m = (await loadMessages(locale)) as {
        pages: { rawMd: { whereStrong: string; useWhen: string } };
      };
      // Both must contain {name} placeholder for runtime substitution.
      expect(m.pages.rawMd.whereStrong).toContain("{name}");
      expect(m.pages.rawMd.useWhen).toContain("{name}");
    }
  });
});

describe("og.json detail-fallback namespaces", () => {
  for (const locale of ["en", "ja"] as const) {
    it(`${locale}: og has all detail-fallback namespaces`, async () => {
      const m = (await loadMessages(locale)) as {
        og: Record<string, Record<string, string>>;
      };
      for (const key of REQUIRED_OG_DETAIL_KEYS) {
        expect(m.og).toHaveProperty(key);
        expect(typeof m.og[key]).toBe("object");
      }
    });

    it(`${locale}: og.vsDetail has subtitleFallback`, async () => {
      const m = (await loadMessages(locale)) as {
        og: { vsDetail: { subtitleFallback: string } };
      };
      expect(typeof m.og.vsDetail.subtitleFallback).toBe("string");
      expect(m.og.vsDetail.subtitleFallback.length).toBeGreaterThan(0);
    });

    it(`${locale}: og.solutionsDetail / agentsDetail / mcpDetail have titleFallback + eyebrowFallback + subtitleFallback`, async () => {
      const m = (await loadMessages(locale)) as {
        og: Record<string, Record<string, string>>;
      };
      for (const key of [
        "solutionsDetail",
        "agentsDetail",
        "mcpDetail",
      ] as const) {
        expect(typeof m.og[key].titleFallback).toBe("string");
        expect(typeof m.og[key].eyebrowFallback).toBe("string");
        expect(typeof m.og[key].subtitleFallback).toBe("string");
      }
    });

    it(`${locale}: og.blogTag.subtitleTemplate contains {label} placeholder`, async () => {
      const m = (await loadMessages(locale)) as {
        og: { blogTag: { subtitleTemplate: string } };
      };
      expect(m.og.blogTag.subtitleTemplate).toContain("{label}");
    });
  }
});

describe("webDocs namespace", () => {
  for (const locale of ["en", "ja"] as const) {
    it(`${locale}: webDocs has all top-level sections`, async () => {
      const m = (await loadMessages(locale)) as {
        webDocs: Record<string, unknown>;
      };
      for (const section of REQUIRED_WEB_DOCS_SECTIONS) {
        expect(m.webDocs).toHaveProperty(section);
      }
    });

    it(`${locale}: webDocs.gettingStarted.steps has all required ids`, async () => {
      const m = (await loadMessages(locale)) as {
        webDocs: {
          gettingStarted: {
            steps: Record<string, { step: string; title: string; desc: string }>;
          };
        };
      };
      for (const id of REQUIRED_WEB_DOCS_STEP_IDS) {
        expect(m.webDocs.gettingStarted.steps).toHaveProperty(id);
        expect(
          typeof m.webDocs.gettingStarted.steps[id].title,
        ).toBe("string");
        expect(typeof m.webDocs.gettingStarted.steps[id].desc).toBe("string");
      }
    });

    it(`${locale}: webDocs.useCases.items has all required ids`, async () => {
      const m = (await loadMessages(locale)) as {
        webDocs: {
          useCases: { items: Record<string, { title: string; desc: string }> };
        };
      };
      for (const id of REQUIRED_WEB_DOCS_USE_CASE_IDS) {
        expect(m.webDocs.useCases.items).toHaveProperty(id);
      }
    });

    it(`${locale}: webDocs.security.items has all required ids`, async () => {
      const m = (await loadMessages(locale)) as {
        webDocs: {
          security: {
            items: Record<
              string,
              { name: string; desc: string; capabilityId: string }
            >;
          };
        };
      };
      for (const id of REQUIRED_WEB_DOCS_SECURITY_IDS) {
        expect(m.webDocs.security.items).toHaveProperty(id);
        // capabilityId is a schema.org-style namespaced id and must stay
        // literal across locales.
        expect(m.webDocs.security.items[id].capabilityId).toMatch(
          /^com\.ellul\.ai\.enforcer\.capability\./,
        );
      }
    });

    it(`${locale}: webDocs.architecture.items has all required ids`, async () => {
      const m = (await loadMessages(locale)) as {
        webDocs: {
          architecture: {
            items: Record<string, { component: string; desc: string }>;
          };
        };
      };
      for (const id of REQUIRED_WEB_DOCS_ARCH_IDS) {
        expect(m.webDocs.architecture.items).toHaveProperty(id);
      }
    });
  }

  it("webDocs.security capabilityId is identical across locales (schema.org id)", async () => {
    const en = (await loadMessages("en")) as {
      webDocs: {
        security: { items: Record<string, { capabilityId: string }> };
      };
    };
    const ja = (await loadMessages("ja")) as {
      webDocs: {
        security: { items: Record<string, { capabilityId: string }> };
      };
    };
    for (const id of REQUIRED_WEB_DOCS_SECURITY_IDS) {
      expect(ja.webDocs.security.items[id].capabilityId).toBe(
        en.webDocs.security.items[id].capabilityId,
      );
    }
  });
});

describe("translation completeness — JA must not be EN-copy on key namespaces", () => {
  // JA-specific characters (hiragana / katakana / kanji ranges) — at least
  // one must appear in each translatable string surface.
  const JA_CHAR_RE = /[぀-ヿ一-鿿]/;

  it("home.meta.title and description are JA in ja locale", async () => {
    const ja = (await loadMessages("ja")) as {
      home: { meta: { title: string; description: string } };
    };
    expect(JA_CHAR_RE.test(ja.home.meta.title)).toBe(true);
    expect(JA_CHAR_RE.test(ja.home.meta.description)).toBe(true);
  });

  it("blog entries titles+summaries are JA in ja locale", async () => {
    const ja = (await loadMessages("ja")) as {
      blog: Record<string, { title: string; summary: string }>;
    };
    const structural = new Set(["index", "pagination", "tag", "rss"]);
    const slugs = Object.keys(ja.blog).filter((s) => !structural.has(s));
    expect(slugs.length).toBeGreaterThanOrEqual(15);
    for (const slug of slugs) {
      expect(JA_CHAR_RE.test(ja.blog[slug]!.title)).toBe(true);
      expect(JA_CHAR_RE.test(ja.blog[slug]!.summary)).toBe(true);
    }
  });

  it("promptEngineering chrome and faq are JA in ja locale", async () => {
    const ja = (await loadMessages("ja")) as {
      promptEngineering: {
        page: { title: string; subhead: string };
        faq: Record<string, { q: string; a: string }>;
      };
    };
    expect(JA_CHAR_RE.test(ja.promptEngineering.page.title)).toBe(true);
    expect(JA_CHAR_RE.test(ja.promptEngineering.page.subhead)).toBe(true);
    for (const f of Object.values(ja.promptEngineering.faq)) {
      expect(JA_CHAR_RE.test(f.q)).toBe(true);
      expect(JA_CHAR_RE.test(f.a)).toBe(true);
    }
  });
});
