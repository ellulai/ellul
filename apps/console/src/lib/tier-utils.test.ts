// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
  isFreeTier,
  isShieldProxyTier,
  isPaidTier,
  isHibernatingTier,
  getProductForTier,
  canShowContext,
  canShowSettingsTab,
  canShowServerSettingsTab,
  type Product,
} from "./tier-utils";

describe("isFreeTier", () => {
  it("returns true for free", () => {
    expect(isFreeTier("free")).toBe(true);
  });

  it("returns true for cloud_platform:free", () => {
    expect(isFreeTier("cloud_platform:free")).toBe(true);
  });

  it("returns false for pro", () => {
    expect(isFreeTier("pro")).toBe(false);
  });

  it("returns false for cloud_platform:pro", () => {
    expect(isFreeTier("cloud_platform:pro")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isFreeTier(undefined)).toBe(false);
  });
});

describe("isShieldProxyTier", () => {
  it("returns true for shield_proxy", () => {
    expect(isShieldProxyTier("shield_proxy")).toBe(true);
  });

  it("returns true for shield_proxy:pro", () => {
    expect(isShieldProxyTier("shield_proxy:pro")).toBe(true);
  });

  it("returns false for cloud_platform", () => {
    expect(isShieldProxyTier("cloud_platform")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isShieldProxyTier(undefined)).toBe(false);
  });
});

describe("isPaidTier", () => {
  it("returns false for free", () => {
    expect(isPaidTier("free")).toBe(false);
  });

  it("returns false for cloud_platform:free", () => {
    expect(isPaidTier("cloud_platform:free")).toBe(false);
  });

  it("returns true for pro", () => {
    expect(isPaidTier("pro")).toBe(true);
  });

  it("returns true for cloud_platform:pro", () => {
    expect(isPaidTier("cloud_platform:pro")).toBe(true);
  });

  it("returns false for undefined", () => {
    expect(isPaidTier(undefined)).toBe(false);
  });
});

describe("isHibernatingTier", () => {
  it("returns true for free", () => {
    expect(isHibernatingTier("free")).toBe(true);
  });

  it("returns true for cloud_platform:free", () => {
    expect(isHibernatingTier("cloud_platform:free")).toBe(true);
  });

  it("returns true for shield_proxy", () => {
    expect(isHibernatingTier("shield_proxy")).toBe(true);
  });

  it("returns true for shield_proxy:pro", () => {
    expect(isHibernatingTier("shield_proxy:pro")).toBe(true);
  });

  it("returns false for cloud_platform:pro", () => {
    expect(isHibernatingTier("cloud_platform:pro")).toBe(false);
  });

  it("returns false for pro", () => {
    expect(isHibernatingTier("pro")).toBe(false);
  });
});

describe("getProductForTier", () => {
  it("maps shield_proxy to shield_proxy", () => {
    expect(getProductForTier("shield_proxy")).toBe("shield_proxy");
  });

  it("maps shield_proxy:pro to shield_proxy", () => {
    expect(getProductForTier("shield_proxy:pro")).toBe("shield_proxy");
  });

  it("maps cloud_platform to cloud_platform", () => {
    expect(getProductForTier("cloud_platform")).toBe("cloud_platform");
  });

  it("maps cloud_platform:free to cloud_platform", () => {
    expect(getProductForTier("cloud_platform:free")).toBe("cloud_platform");
  });

  it("maps cloud_platform:pro to cloud_platform", () => {
    expect(getProductForTier("cloud_platform:pro")).toBe("cloud_platform");
  });

  it("defaults to cloud_platform for undefined", () => {
    expect(getProductForTier(undefined)).toBe("cloud_platform");
  });
});

describe("canShowContext", () => {
  const contextIds = ["workspace", "deployed", "database", "observability", "settings"];
  const products: Product[] = ["shield_proxy", "cloud_platform"];

  const expected: Record<string, Record<Product, boolean>> = {
    workspace: { cloud_platform: true, shield_proxy: false },
    deployed: { cloud_platform: false, shield_proxy: false },
    database: { cloud_platform: false, shield_proxy: false },
    observability: { cloud_platform: false, shield_proxy: false },
    settings: { cloud_platform: true, shield_proxy: true },
  };

  for (const contextId of contextIds) {
    for (const product of products) {
      it(`${contextId} x ${product} -> ${expected[contextId]![product]}`, () => {
        expect(canShowContext(contextId, product)).toBe(expected[contextId]![product]);
      });
    }
  }
});

describe("canShowSettingsTab", () => {
  const tabIds = ["context", "security", "secrets", "git", "claw"];
  const products: Product[] = ["shield_proxy", "cloud_platform"];

  const expected: Record<string, Record<string, boolean>> = {
    context: { cloud_platform: true, shield_proxy: false },
    security: { cloud_platform: true, shield_proxy: true },
    secrets: { cloud_platform: true, shield_proxy: true },
    git: { cloud_platform: true, shield_proxy: false },
    claw: { cloud_platform: true, shield_proxy: false },
  };

  for (const tabId of tabIds) {
    for (const product of products) {
      it(`${tabId} x ${product} -> ${expected[tabId]![product]}`, () => {
        expect(canShowSettingsTab(tabId, product)).toBe(expected[tabId]![product]);
      });
    }
  }
});

describe("canShowServerSettingsTab", () => {
  const tabIds = ["general", "billing", "context", "appearance"];
  const products: Product[] = ["shield_proxy", "cloud_platform"];

  const expected: Record<string, Record<string, boolean>> = {
    general: { cloud_platform: true, shield_proxy: true },
    billing: { cloud_platform: true, shield_proxy: true },
    context: { cloud_platform: true, shield_proxy: true },
    appearance: { cloud_platform: true, shield_proxy: false },
  };

  for (const tabId of tabIds) {
    for (const product of products) {
      it(`${tabId} x ${product} -> ${expected[tabId]![product]}`, () => {
        expect(canShowServerSettingsTab(tabId, product)).toBe(expected[tabId]![product]);
      });
    }
  }
});
