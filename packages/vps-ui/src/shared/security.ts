// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Server-injected config from Caddy's /vps-config.js (loaded before app bundle).
// Fails closed: missing config = reject all origins.
function getConfig(): EllulConfig | null {
  return typeof window !== "undefined" ? window.__ELLUL_CONFIG__ ?? null : null;
}

function wsUrl(origin: string, path: string): string {
  const proto = origin.startsWith("https") ? "wss:" : "ws:";
  return `${proto}//${new URL(origin).host}${path}`;
}

export function getBridgeWsUrl(token: string): string {
  const cfg = getConfig();
  const origin = cfg?.wsOrigin || location.origin;
  return wsUrl(origin, `/ws?_agent_token=${encodeURIComponent(token)}`);
}

export function getCodeWsUrl(): string {
  const cfg = getConfig();
  const origin = cfg?.codeWsOrigin || cfg?.wsOrigin || location.origin;
  const path = cfg?.codeWsPath || "/ws";
  return wsUrl(origin, path);
}

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
  const zone = config.platformZone;
  if (protocol !== "https:" && !(protocol === "http:" && host === "localhost")) return false;
  return host === zone || host.endsWith(`.${zone}`);
}
