// SPDX-License-Identifier: MIT

// Domain utilities for the flat subdomain structure.

const PLATFORM_DOMAIN = process.env.NEXT_PUBLIC_PLATFORM_DOMAIN!;
const APP_DOMAIN = process.env.NEXT_PUBLIC_APP_DOMAIN!;

// Convert a server's main domain to its code API domain.
export function getCodeDomain(serverDomain: string): string {
  return serverDomain.replace("-srv.", "-code.").replace("-dc.", "-dcode.");
}

// Convert a server's main domain to its dev/preview domain.
export function getDevDomain(serverDomain: string): string {
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

// Used for postMessage security validation.
export function isValidServerOrigin(origin: string): boolean {
  return origin.endsWith(`.${PLATFORM_DOMAIN}`) || origin.endsWith(`.${APP_DOMAIN}`);
}
