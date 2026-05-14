// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { describe, it, expect } from "vitest";
import { decideLocaleRedirect } from "./locale-redirect";

describe("decideLocaleRedirect", () => {
  it("URL wins and persists when path has explicit locale and DB pref differs", () => {
    expect(
      decideLocaleRedirect({
        urlLocale: "ja",
        hasExplicitLocaleInPath: true,
        user: { preferredLocale: "en" },
      }),
    ).toEqual({ kind: "url", locale: "ja", persist: true });
  });

  it("URL wins without persisting when explicit locale matches DB pref", () => {
    expect(
      decideLocaleRedirect({
        urlLocale: "ja",
        hasExplicitLocaleInPath: true,
        user: { preferredLocale: "ja" },
      }),
    ).toEqual({ kind: "url", locale: "ja", persist: false });
  });

  it("URL wins and persists when DB pref is missing or invalid", () => {
    expect(
      decideLocaleRedirect({
        urlLocale: "ja",
        hasExplicitLocaleInPath: true,
        user: { preferredLocale: null },
      }),
    ).toEqual({ kind: "url", locale: "ja", persist: true });

    expect(
      decideLocaleRedirect({
        urlLocale: "ja",
        hasExplicitLocaleInPath: true,
        user: { preferredLocale: "xx-bogus" },
      }),
    ).toEqual({ kind: "url", locale: "ja", persist: true });

    expect(
      decideLocaleRedirect({
        urlLocale: "ja",
        hasExplicitLocaleInPath: true,
        user: undefined,
      }),
    ).toEqual({ kind: "url", locale: "ja", persist: true });
  });

  it("DB pref wins when URL has no explicit prefix — does NOT persist (no silent overwrite)", () => {
    // The exact bug class we want to prevent: a user with preferredLocale=ja
    // clears cookies and lands on /sign-up (default English route). We must
    // honor their saved Japanese preference, not flip it to English.
    const decision = decideLocaleRedirect({
      urlLocale: "en",
      hasExplicitLocaleInPath: false,
      user: { preferredLocale: "ja" },
    });
    expect(decision).toEqual({ kind: "db", locale: "ja" });
    // RedirectDecision.kind === "db" carries no `persist` field, so no
    // PATCH is reachable from this branch by construction.
  });

  it("falls through to middleware default when no URL locale and no DB pref", () => {
    expect(
      decideLocaleRedirect({
        urlLocale: "en",
        hasExplicitLocaleInPath: false,
        user: { preferredLocale: null },
      }),
    ).toEqual({ kind: "default" });

    expect(
      decideLocaleRedirect({
        urlLocale: "en",
        hasExplicitLocaleInPath: false,
        user: undefined,
      }),
    ).toEqual({ kind: "default" });
  });

  it("rejects an invalid URL locale even when path looks explicit", () => {
    // Defense in depth: even if someone navigates the router to a bogus
    // [locale] segment, we never call persist with an unvalidated value.
    expect(
      decideLocaleRedirect({
        urlLocale: "xx-bogus",
        hasExplicitLocaleInPath: true,
        user: { preferredLocale: "ja" },
      }),
    ).toEqual({ kind: "db", locale: "ja" });
  });
});
