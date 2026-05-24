// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * IP Binding Utilities
 *
 * IP binding prevents stolen confirmation tokens from being used at different
 * locations. The threat model is cross-network token replay, NOT same-subnet
 * co-tenants (those already share routing infrastructure).
 *
 * Exact-IP binding breaks legitimate users behind CGNAT / carrier NAT / VPN
 * egress pools where the public IP rotates between adjacent addresses within
 * a /24 (IPv4) or /64 (IPv6). We compare binding *classes* instead:
 *
 *   - IPv4: /24 — matches all ISP CGNAT rotations and load-balanced egress
 *   - IPv6: /64 — the standard end-site prefix
 *
 * Device possession (PoP HMAC) remains the hard gate; IP binding is a
 * secondary filter against cross-network replay only.
 *
 * When behind Cloudflare (gateway mode), IP checks are skipped entirely —
 * the "IP" seen by the VPS is the CF edge, not the user.
 */

/**
 * Check if the server is behind Cloudflare (gateway mode).
 * When true, IP binding should be skipped for confirmation/recovery flows.
 */
export function isBehindCloudflare(headers: { get(name: string): string | null | undefined }): boolean {
  return process.env.DEPLOYMENT_MODEL === 'gateway' ||
    headers.get('cf-connecting-ip') != null;
}

/**
 * Reduce an IP to its binding class.
 *
 * IPv4 → first three octets (/24). Accepts dotted-quad.
 * IPv6 → first four groups (/64). `::` compression is expanded first so
 *        compressed addresses class correctly.
 * Malformed input is returned unchanged (forces exact-match fallback).
 */
export function ipBindingClass(ip: string): string {
  if (!ip) return ip;
  if (ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1') return 'loopback';
  if (ip.includes(':')) return expandIPv6Prefix(ip, 4);
  const parts = ip.split('.');
  if (parts.length !== 4) return ip;
  return parts.slice(0, 3).join('.');
}

function expandIPv6Prefix(ip: string, groups: number): string {
  const bare = ip.split('%')[0] ?? ip;
  const doubleIdx = bare.indexOf('::');
  let parts: string[];
  if (doubleIdx === -1) {
    parts = bare.split(':');
  } else {
    const head = bare.slice(0, doubleIdx).split(':').filter(Boolean);
    const tail = bare.slice(doubleIdx + 2).split(':').filter(Boolean);
    const zeros = Array(Math.max(0, 8 - head.length - tail.length)).fill('0');
    parts = [...head, ...zeros, ...tail];
  }
  if (parts.length < groups) return bare;
  return parts.slice(0, groups).map(p => p.toLowerCase()).join(':');
}

/**
 * Check if an IP mismatch should block the request.
 * True iff both IPs are present, we are not behind CF, and the binding
 * classes (/24 or /64) differ.
 */
export function shouldRejectIpMismatch(
  expectedIp: string | null | undefined,
  actualIp: string | null | undefined,
  headers: { get(name: string): string | null | undefined },
): boolean {
  if (!expectedIp || !actualIp) return false;
  if (isBehindCloudflare(headers)) return false;
  return ipBindingClass(expectedIp) !== ipBindingClass(actualIp);
}

/**
 * True when IPs differ at exact level but share a binding class.
 * Callers use this to log a benign CGNAT/VPN drift instead of rejecting.
 */
export function isIntraClassDrift(
  expectedIp: string | null | undefined,
  actualIp: string | null | undefined,
): boolean {
  if (!expectedIp || !actualIp) return false;
  if (expectedIp === actualIp) return false;
  return ipBindingClass(expectedIp) === ipBindingClass(actualIp);
}
