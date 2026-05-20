// SPDX-License-Identifier: MIT

// Domain utilities for the flat subdomain structure.

const PLATFORM_DOMAIN = process.env.NEXT_PUBLIC_PLATFORM_DOMAIN!;
const APP_DOMAIN = process.env.NEXT_PUBLIC_APP_DOMAIN!;

// Convert a server's main domain to its code API domain.
export function getCodeDomain(serverDomain: string): string {
  if (serverDomain.startsWith("localhost")) return serverDomain;
  return serverDomain.replace("-srv.", "-code.").replace("-dc.", "-dcode.");
}

// Convert a server's main domain to its dev/preview domain.
export function getDevDomain(serverDomain: string): string {
  if (serverDomain.startsWith("localhost")) return serverDomain;
  const platformDomainEscaped = PLATFORM_DOMAIN.replace(/\./g, "\\.");
  return serverDomain
    .replace("-srv.", "-dev.")
    .replace("-dc.", "-ddev.")
    .replace(new RegExp(`\\.${platformDomainEscaped}$`), `.${APP_DOMAIN}`);
}

// Get the full code API URL for a server.
export function getCodeApiUrl(serverDomain: string): string {
  return `https://${getCodeDomain(serverDomain)}`;
}

// Get the full dev/preview URL for a server.
export function getDevUrl(serverDomain: string): string {
  return `https://${getDevDomain(serverDomain)}`;
}

// Get the WebSocket URL for real-time updates.
export function getCodeWsUrl(serverDomain: string): string {
  return `wss://${getCodeDomain(serverDomain)}/ws`;
}

// Android PRoot local mode: no cloud domain, self-hosted product.
export function isLocalServer(server: { domain?: string | null; product?: string }): boolean {
  return !server.domain && server.product === "self_hosted";
}

// Canonical server domain derivation — single source of truth.
export function resolveServerDomain(server: { domain?: string | null; ipAddress?: string | null; product?: string }): string {
  if (isLocalServer(server)) return "localhost:8443";
  if (server.domain) return server.domain;
  if (server.ipAddress) return `${server.ipAddress.replace(/\./g, "-")}.sslip.io`;
  return "localhost:8443";
}

// Used for postMessage security validation.
export function isValidServerOrigin(origin: string): boolean {
  if (origin === "https://localhost:8443") return true;
  return origin.endsWith(`.${PLATFORM_DOMAIN}`) || origin.endsWith(`.${APP_DOMAIN}`);
}
