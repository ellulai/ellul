// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Server-injected config from Caddy's /vps-config.js (loaded before app bundle).
// Fails closed: missing config = reject all origins.
function getConfig(): EllulConfig | null {
  return typeof window !== "undefined" ? window.__ELLUL_CONFIG__ ?? null : null;
}

// Trust only origins on the same platform zone (console, other VPS workbenches).
// User-deployed apps on the app zone are intentionally NOT trusted.
export function isOriginTrusted(origin: string): boolean {
  if (!origin || origin === "null") return false;
  const config = getConfig();
  if (!config) return false;
  let host: string;
  let protocol: string;
  try {
    const url = new URL(origin);
    host = url.hostname;
    protocol = url.protocol;
  } catch {
    return false;
  }
  if (protocol !== "https:") return false;
  const zone = config.platformZone;
  return host === zone || host.endsWith(`.${zone}`);
}
