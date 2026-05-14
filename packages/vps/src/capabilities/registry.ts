// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Central capability registry — the single source of truth for every
// VPS-advertised feature flag. Both the VPS build output and the
// console consume this file directly; there is no secondary location
// where capability strings can drift.
//
// Adding a capability:
//   1. Append an entry to CAPABILITY_REGISTRY below.
//   2. Ship a VPS release that implements it (the build script reads
//      this file and bakes the id into the manifest).
//   3. Gate the frontend feature with useVpsCapability(CapabilityId.*).
//   4. Document the user-facing name and description on the docs site
//      (apps/web/src/app/docs/page.tsx — Security features section).
//
// Deprecating a capability:
//   1. Flip lifecycle to "deprecated" and set supersededBy + deprecatedInVersion.
//   2. Leave the entry in place — callers that still reference it see
//      a console warning (in dev) and the dashboard UI enumerates it
//      in the deprecated section.
//   3. Remove the entry only after every consumer has migrated.

export type CapabilityLifecycle = "alpha" | "beta" | "ga" | "deprecated";

export type CapabilityService =
  | "enforcer"
  | "agent-bridge"
  | "file-api"
  | "watchdog"
  | "term-proxy"
  | "sovereign-shield"
  | "ide";

export interface CapabilityDefinition {
  /** Canonical wire-format id: com.ellul.ai.<service>.capability.<feature>.v<N> */
  readonly id: string;
  readonly service: CapabilityService;
  readonly feature: string;
  readonly version: number;
  readonly lifecycle: CapabilityLifecycle;
  /** First VPS release that advertised this capability. */
  readonly introducedInVersion: string;
  /** Populated when lifecycle=deprecated. */
  readonly deprecatedInVersion?: string;
  /** Canonical id of the replacement. Required when lifecycle=deprecated. */
  readonly supersededBy?: string;
}

export const CAPABILITY_REGISTRY = [
  {
    id: "com.ellul.ai.enforcer.capability.liveness-ping.v1",
    service: "enforcer",
    feature: "liveness-ping",
    version: 1,
    lifecycle: "ga",
    introducedInVersion: "0.1.2",
  },
  {
    id: "com.ellul.ai.enforcer.capability.sha256-drift-check.v1",
    service: "enforcer",
    feature: "sha256-drift-check",
    version: 1,
    lifecycle: "ga",
    introducedInVersion: "0.1.5",
  },
  {
    id: "com.ellul.ai.enforcer.capability.self-hash-attest.v1",
    service: "enforcer",
    feature: "self-hash-attest",
    version: 1,
    lifecycle: "ga",
    introducedInVersion: "0.1.4",
  },
  {
    id: "com.ellul.ai.enforcer.capability.manual-mode.v1",
    service: "enforcer",
    feature: "manual-mode",
    version: 1,
    lifecycle: "ga",
    introducedInVersion: "0.1.0",
  },
  {
    id: "com.ellul.ai.enforcer.capability.signed-manifest.v1",
    service: "enforcer",
    feature: "signed-manifest",
    version: 1,
    lifecycle: "ga",
    introducedInVersion: "0.1.0",
  },
  {
    id: "com.ellul.ai.enforcer.capability.self-test.v1",
    service: "enforcer",
    feature: "self-test",
    version: 1,
    lifecycle: "ga",
    introducedInVersion: "0.1.0",
  },
  {
    id: "com.ellul.ai.enforcer.capability.capability-report.v1",
    service: "enforcer",
    feature: "capability-report",
    version: 1,
    lifecycle: "ga",
    introducedInVersion: "0.1.6",
  },
] as const satisfies readonly CapabilityDefinition[];

export type CapabilityId = (typeof CAPABILITY_REGISTRY)[number]["id"];

const REGISTRY_BY_ID = new Map<string, CapabilityDefinition>(
  CAPABILITY_REGISTRY.map((c) => [c.id, c]),
);

export function getCapability(id: string): CapabilityDefinition | undefined {
  return REGISTRY_BY_ID.get(id);
}

export function capabilitiesForService(
  service: CapabilityService,
): readonly CapabilityDefinition[] {
  return CAPABILITY_REGISTRY.filter((c) => c.service === service);
}

// Wire-format ids a given service should advertise on ping — filters
// out deprecated entries so a release that's still shipping a
// transition capability doesn't claim both v1 and v2 indefinitely.
export function advertisedCapabilityIds(service: CapabilityService): string[] {
  return capabilitiesForService(service)
    .filter((c) => c.lifecycle !== "deprecated")
    .map((c) => c.id);
}
