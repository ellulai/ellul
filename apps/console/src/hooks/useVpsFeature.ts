// SPDX-License-Identifier: MIT
"use client";

import { useContext } from "react";
import { VpsCapabilitiesContext } from "@/providers/VpsCapabilitiesProvider";

// Check if the connected VPS supports a specific feature.
export function useVpsFeature(feature: string): boolean {
  const caps = useContext(VpsCapabilitiesContext);
  return caps?.features?.includes(feature) ?? false;
}

// Returns false when capabilities haven't loaded (safe default = don't use endpoint).
export function useVpsEndpoint(endpoint: string, minVersion = 1): boolean {
  const caps = useContext(VpsCapabilitiesContext);
  return (caps?.endpoints[endpoint] ?? 0) >= minVersion;
}
