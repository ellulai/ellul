// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { describe, it, expect } from "vitest";
import {
  PUBLIC_SURFACES,
  SURFACES,
  isPublicSurface,
  isSurface,
} from "../src/surfaces";

describe("surfaces — registry invariants", () => {
  it("SURFACES is the documented set", () => {
    expect([...SURFACES].sort()).toEqual(
      ["console", "docs", "vps-ui", "web"].sort(),
    );
  });

  it("PUBLIC_SURFACES is a subset of SURFACES", () => {
    for (const s of PUBLIC_SURFACES) {
      expect(SURFACES).toContain(s);
    }
  });

  it("PUBLIC_SURFACES contains the surfaces actually indexed by search engines", () => {
    expect(PUBLIC_SURFACES.has("web")).toBe(true);
    expect(PUBLIC_SURFACES.has("docs")).toBe(true);
    expect(PUBLIC_SURFACES.has("console")).toBe(false);
    expect(PUBLIC_SURFACES.has("vps-ui")).toBe(false);
  });

  it.each(SURFACES)("isSurface accepts %s", (s) => {
    expect(isSurface(s)).toBe(true);
  });

  it("isSurface rejects unknown values", () => {
    expect(isSurface("api")).toBe(false);
    expect(isSurface(42)).toBe(false);
    expect(isSurface(undefined)).toBe(false);
  });

  it.each([...PUBLIC_SURFACES])("isPublicSurface accepts %s", (s) => {
    expect(isPublicSurface(s)).toBe(true);
  });

  it("isPublicSurface rejects auth-walled surfaces", () => {
    expect(isPublicSurface("console")).toBe(false);
    expect(isPublicSurface("vps-ui")).toBe(false);
  });
});
