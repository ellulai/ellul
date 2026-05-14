// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { describe, expect, it } from "vitest";
import {
  CAPABILITY_REGISTRY,
  advertisedCapabilityIds,
  capabilitiesForService,
  getCapability,
  type CapabilityDefinition,
} from "./registry";

const ID_FORMAT =
  /^com\.ellul\.ai\.[a-z0-9-]+\.capability\.[a-z0-9-]+\.v\d+$/;

describe("CAPABILITY_REGISTRY", () => {
  it("is non-empty", () => {
    expect(CAPABILITY_REGISTRY.length).toBeGreaterThan(0);
  });

  it.each(CAPABILITY_REGISTRY)(
    "entry $id has a valid canonical id",
    (entry: CapabilityDefinition) => {
      expect(entry.id).toMatch(ID_FORMAT);
    },
  );

  it("has no duplicate ids", () => {
    const seen = new Set<string>();
    for (const c of CAPABILITY_REGISTRY) {
      expect(seen.has(c.id), `duplicate id: ${c.id}`).toBe(false);
      seen.add(c.id);
    }
  });

  it.each(CAPABILITY_REGISTRY)(
    "entry $id encodes version in its id suffix",
    (entry: CapabilityDefinition) => {
      const suffix = `.v${entry.version}`;
      expect(entry.id.endsWith(suffix)).toBe(true);
    },
  );

  it.each(CAPABILITY_REGISTRY)(
    "entry $id encodes service in its id namespace",
    (entry: CapabilityDefinition) => {
      expect(entry.id).toContain(`.${entry.service}.capability.`);
    },
  );

  it.each(CAPABILITY_REGISTRY)(
    "entry $id has an introducedInVersion",
    (entry: CapabilityDefinition) => {
      expect(entry.introducedInVersion).toMatch(/^\d+\.\d+\.\d+/);
    },
  );

  it("deprecated entries have supersededBy pointing at a live id", () => {
    const liveIds = new Set(
      CAPABILITY_REGISTRY.filter((c) => c.lifecycle !== "deprecated").map((c) => c.id),
    );
    for (const c of CAPABILITY_REGISTRY) {
      if (c.lifecycle !== "deprecated") continue;
      expect(
        c.supersededBy,
        `${c.id} is deprecated but has no supersededBy`,
      ).toBeDefined();
      expect(
        c.deprecatedInVersion,
        `${c.id} is deprecated but has no deprecatedInVersion`,
      ).toBeDefined();
      expect(
        liveIds.has(c.supersededBy!),
        `${c.id}.supersededBy = ${c.supersededBy} but that id is not in the registry or is itself deprecated`,
      ).toBe(true);
    }
  });
});

describe("capabilitiesForService", () => {
  it("groups by service", () => {
    const enforcer = capabilitiesForService("enforcer");
    expect(enforcer.length).toBeGreaterThan(0);
    for (const c of enforcer) {
      expect(c.service).toBe("enforcer");
    }
  });

  it("returns empty for services with no entries", () => {
    expect(capabilitiesForService("watchdog")).toEqual([]);
  });
});

describe("advertisedCapabilityIds", () => {
  it("returns only non-deprecated ids for the service", () => {
    const ids = advertisedCapabilityIds("enforcer");
    for (const id of ids) {
      const def = getCapability(id);
      expect(def?.lifecycle).not.toBe("deprecated");
    }
  });
});

describe("getCapability", () => {
  it("returns the full entry for a known id", () => {
    const first = CAPABILITY_REGISTRY[0]!;
    const found = getCapability(first.id);
    expect(found).toBeDefined();
    expect(found?.id).toBe(first.id);
  });

  it("returns undefined for unknown ids", () => {
    expect(getCapability("com.ellul.ai.nope.capability.whatever.v99")).toBeUndefined();
  });
});
