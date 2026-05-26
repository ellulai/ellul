// SPDX-License-Identifier: MIT

// Domain utilities for the flat subdomain structure.

const PLATFORM_DOMAIN = process.env.NEXT_PUBLIC_PLATFORM_DOMAIN!;
const APP_DOMAIN = process.env.NEXT_PUBLIC_APP_DOMAIN!;

export function isLocalDomain(domain: string): boolean {
  return domain === "localhost" || domain.startsWith("localhost:");
}

function localHost(): string {
  if (typeof window !== "undefined" && window.location.hostname === "localhost") {
    return window.location.host;
  }
  return "localhost";
}

// Convert a server's main domain to its code API domain.
export function getCodeDomain(serverDomain: string): string {
  if (isLocalDomain(serverDomain)) return serverDomain;
  return serverDomain.replace("-srv.", "-code.").replace("-dc.", "-dcode.");
}

// Convert a server's main domain to its dev/preview domain.
export function getDevDomain(serverDomain: string): string {
  if (isLocalDomain(serverDomain)) return serverDomain;
  const platformDomainEscaped = PLATFORM_DOMAIN.replace(/\./g, "\\.");
  return serverDomain
    .replace("-srv.", "-dev.")
    .replace("-dc.", "-ddev.")
    .replace(new RegExp(`\\.${platformDomainEscaped}$`), `.${APP_DOMAIN}`);
}

// Get the full code API URL for a server.
export function getCodeApiUrl(serverDomain: string): string {
  if (isLocalDomain(serverDomain)) return `http://${localHost()}`;
  return `https://${getCodeDomain(serverDomain)}`;
}

// Preview gateway port — must match PORT_REGISTRY.PREVIEW_GATEWAY in packages/vps.
const PREVIEW_GATEWAY_PORT = 4443;

// Get the full dev/preview URL for a server.
export function getDevUrl(serverDomain: string): string {
  if (isLocalDomain(serverDomain)) {
    const limaPort = process.env.NEXT_PUBLIC_LIMA_PREVIEW_PORT;
    if (limaPort) return `http://localhost:${limaPort}`;
    if (typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent)) {
      return `http://localhost:${PREVIEW_GATEWAY_PORT}`;
    }
    return `http://${getDevDomain(serverDomain)}`;
  }
  return `https://${getDevDomain(serverDomain)}`;
}

// Get the WebSocket URL for real-time updates.
// Local single-host: /code-ws routes to file-api (/ws is agent-bridge).
// Android Tauri: Caddy on port 8443 (WebView can't reach port 80).
export function getCodeWsUrl(serverDomain: string): string {
  if (isLocalDomain(serverDomain)) {
    if (typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent)) {
      return "ws://localhost:8443/code-ws";
    }
    return `ws://${localHost()}/code-ws`;
  }
  return `wss://${getCodeDomain(serverDomain)}/ws`;
}

// Android PRoot local mode: no cloud domain, self-hosted product.
export function isLocalServer(server: { domain?: string | null; product?: string }): boolean {
  if (server.product !== "self_hosted" && server.product !== "byos") return false;
  return !server.domain || server.domain === "localhost";
}

// Canonical server domain derivation — single source of truth.
export function resolveServerDomain(server: { domain?: string | null; ipAddress?: string | null; product?: string }): string {
  if (isLocalServer(server)) return "localhost";
  if (server.domain) return server.domain;
  if (server.ipAddress) return `${server.ipAddress.replace(/\./g, "-")}.sslip.io`;
  return "localhost";
}

// In local mode, the Android WebView can only reach its own origin.
// Service iframes must be loaded through the Next.js proxy at /srv/.
export function getLocalProxyOrigin(): string {
  if (typeof window !== "undefined") return window.location.origin;
  return "http://localhost:3000";
}

// Get the iframe-safe base URL for a server.
// Android proot: direct to Caddy on port 8443 (no Next.js proxy in production).
// Desktop Tauri dev: /srv/ prefix (Next.js dev rewrites proxy to VPS).
// Browser local: direct to Caddy on port 80 (parity with cloud).
export function getIframeBaseUrl(serverDomain: string, isTauri: boolean): string {
  if (isLocalDomain(serverDomain)) {
    if (isTauri) {
      if (typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent)) {
        return "http://localhost:8443";
      }
      return `${getLocalProxyOrigin()}/srv`;
    }
    return "http://localhost";
  }
  return `https://${serverDomain}`;
}

// Fetch wrapper for VPS shield/file-api endpoints that works in local mode.
export async function vpsFetch(
  serverDomain: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  if (typeof window === "undefined") throw new Error("vpsFetch: browser only");

  if (isLocalDomain(serverDomain)) {
    const { hasTauriInvoke, localFetch, localResponse } = await import("./local-fetch");
    if (hasTauriInvoke()) {
      const body = init?.body ? (typeof init.body === "string" ? init.body : JSON.stringify(init.body)) : null;
      return localResponse(await localFetch(init?.method || "GET", path, { body }));
    }
    return fetch(`http://${localHost()}${path}`, { ...init, credentials: "include" });
  }

  return fetch(`https://${serverDomain}${path}`, { ...init, credentials: "include" });
}

// Build the base URL for direct VPS API calls (shield, file-api, bridge).
// Browser local: direct to Caddy on port 80 (parity with cloud).
// Callers append paths via template literal: `${getVpsApiUrl(d)}/_auth/caps`
export function getVpsApiUrl(serverDomain: string): string {
  if (isLocalDomain(serverDomain)) {
    const isTauri = typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;
    if (isTauri) return `${getLocalProxyOrigin()}/srv`;
    return `http://${localHost()}`;
  }
  return `https://${serverDomain}`;
}

// Used for postMessage security validation.
export function isValidServerOrigin(origin: string): boolean {
  if (origin === "http://localhost" || origin === "http://localhost:80") return true;
  if (typeof window !== "undefined") {
    if (origin === window.location.origin) return true;
    if ((window as any).__TAURI_INTERNALS__) {
      try {
        const u = new URL(origin);
        if (u.protocol === "http:" && u.hostname === "localhost") return true;
      } catch {}
    }
  }
  return origin.endsWith(`.${PLATFORM_DOMAIN}`) || origin.endsWith(`.${APP_DOMAIN}`);
}
