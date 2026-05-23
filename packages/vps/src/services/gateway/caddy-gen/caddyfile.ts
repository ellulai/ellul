// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Caddyfile generator. Shared by provisioning (caddy.ts) + runtime CLI (ellul-caddy-gen).

import { generateCaddyHandlers } from "./handlers";

export interface CaddyfileOptions {
  /** "proxied" = Cloudflare origin certs + AOP mTLS. "direct" = Let's Encrypt ACME. "localhost" = internal TLS for self-hosted. */
  deploymentModel: "proxied" | "direct" | "localhost";
  mainDomain: string;
  codeDomain: string;
  devDomain: string;
  // Zone for o-{tag}.{platformZone} + platform-managed domains. REQUIRED.
  platformZone: string;
  // Wildcard zone for dev preview + deployed apps. REQUIRED.
  appZone: string;
  /** Console origin used in CORS + CSP frame-ancestors. REQUIRED. */
  consoleOrigin: string;
  /** Optional additional hostname (customer custom domain) served by the main handler. */
  customDomain?: string;
  // Adds o-{tag}.{platformZone}:443 to .ai block for resolveOverride SNI. From /etc/ellul/origin-tag.
  originTag?: string;
  // false (Cloud Sandbox): omits sites-enabled + app-routes.d; dev preview still included.
  canDeploy?: boolean;
  /** Use unprivileged high ports (8443/8080) instead of 443/80. Localhost model only. */
  highPorts?: boolean;
}

interface TlsConfig {
  cert: string;
  key: string;
  clientAuth?: string;
}

interface SiteBlock {
  addresses: string[];
  tls?: TlsConfig | "internal";
  handlers: string;
}

function renderTls(tls: TlsConfig | "internal"): string {
  if (tls === "internal") return "    tls internal";
  const lines = [`    tls ${tls.cert} ${tls.key}`];
  if (tls.clientAuth) {
    lines[0] += " {";
    lines.push("        client_auth {");
    lines.push("            mode require_and_verify");
    lines.push(`            trusted_ca_cert_file ${tls.clientAuth}`);
    lines.push("        }");
    lines.push("    }");
  }
  return lines.join("\n");
}

function renderSiteBlock(site: SiteBlock): string {
  const addr = site.addresses.join(", ");
  const parts = [addr + " {"];
  if (site.tls) parts.push(renderTls(site.tls));
  parts.push("");
  // SECURITY: Strip origin verification secret from responses — Cloudflare injects
  // X-Origin-Verify as a request header for origin authentication, but it must
  // never leak in responses (allows attackers to bypass origin verification).
  parts.push("    header -X-Origin-Verify");
  parts.push("");
  parts.push(site.handlers);
  parts.push("}");
  return parts.join("\n");
}

/** Admin API unix socket path (Linux only — restricts admin access to caddy group). */
export const CADDY_ADMIN_SOCK = "/run/caddy/admin.sock";

function renderGlobalOptions(
  autoHttps: boolean,
  useAdminSocket: boolean,
  platformZone: string,
): string {
  const lines = ["{"];
  if (useAdminSocket) {
    if (process.env.ELLUL_PLATFORM === 'android') {
      lines.push(`    admin 127.0.0.1:2019`);
    } else {
      lines.push(`    admin unix/${CADDY_ADMIN_SOCK}|0660`);
    }
  }
  if (!autoHttps) lines.push("    auto_https off");
  if (process.env.ELLUL_PLATFORM === 'android') lines.push("    persist_config off");
  lines.push(`    email admin@${platformZone}`);
  // Deliberately NO `servers { trusted_proxies ... }` block.
  //
  // Rationale: trust-pinning CF-Connecting-IP / X-Forwarded-For in Caddy
  // requires one of (a) a hardcoded CF IP range list that rots as CF
  // rotates ranges, or (b) a custom Caddy build bundling the third-party
  // `caddy-cloudflare-ip` plugin (not in stock Caddy — `trusted_proxies
  // cloudflare` fails with `module not registered` on the packaged
  // binary). Both carry ongoing maintenance liability.
  //
  // The real defense for IP-spoofing-based rate-limit evasion is the
  // global rate-limit backstop in `rate-limiter.ts` (20 recovery
  // attempts/hr regardless of IP). That backstop already caps
  // enumeration independent of `{client_ip}` accuracy — pinning
  // trusted_proxies here would only affect rate-limit granularity, not
  // the security bar.
  //
  // Tradeoff accepted: in proxied mode, per-IP rate limits bucket by CF
  // edge IP rather than real-client IP (one abusive user lumped with
  // others from the same CF edge). If that granularity becomes a
  // product issue, upgrade to a custom Caddy build with
  // `caddy-cloudflare-ip` — the plugin auto-refreshes from CF's API and
  // re-enable `servers { trusted_proxies cloudflare }`.
  lines.push("}");
  return lines.join("\n");
}

function replaceDomains(text: string, main: string, code: string, dev: string): string {
  return text
    .replace(/MAIN_DOMAIN/g, main)
    .replace(/CODE_DOMAIN_PLACEHOLDER/g, code)
    .replace(/DEV_DOMAIN_PLACEHOLDER/g, dev);
}

const CF_AOP_CA = "/etc/caddy/cf-origin-pull-ca.pem";

function configJsHandler(platformZone: string, appZone: string, consoleOrigin: string, wsOrigin?: string, codeWsOrigin?: string, codeWsPath?: string): string {
  const cfg: Record<string, string> = { platformZone, appZone, consoleOrigin };
  if (wsOrigin) cfg.wsOrigin = wsOrigin;
  if (codeWsOrigin) cfg.codeWsOrigin = codeWsOrigin;
  if (codeWsPath) cfg.codeWsPath = codeWsPath;
  const json = JSON.stringify(cfg);
  return [
    `    handle /vps-config.js {`,
    `        header Content-Type "application/javascript"`,
    `        header Cache-Control "no-store"`,
    `        respond \`window.__ELLUL_CONFIG__=${json};\` 200`,
    `    }`,
  ].join("\n");
}

export function generateCaddyfileContent(opts: CaddyfileOptions): string {
  const {
    deploymentModel,
    mainDomain,
    codeDomain,
    devDomain,
    platformZone,
    appZone,
    consoleOrigin,
    customDomain,
  } = opts;
  const replace = (text: string) => replaceDomains(text, mainDomain, codeDomain, devDomain);
  // If a custom domain is active on this VPS, allow it as a frame-ancestor on
  // the code viewer + preview + main handlers so a page on the customer's domain
  // can iframe those resources. 'self' + console stay in the allowlist regardless.
  const extraFrameAncestors = customDomain ? [`https://${customDomain}`] : undefined;
  const isSingleHost = deploymentModel === "localhost";
  const handlerOpts = {
    consoleOrigin,
    extraFrameAncestors,
    forceXForwardedHostRewrite: isSingleHost,
    singleHost: isSingleHost,
  };
  const localhostPort = opts.highPorts ? 8443 : 80;
  const wsOrigin = isSingleHost ? (localhostPort === 80 ? `http://localhost` : `http://localhost:${localhostPort}`) : undefined;
  const codeWsOrigin = isSingleHost ? (localhostPort === 80 ? `http://localhost` : `http://localhost:${localhostPort}`) : undefined;
  const codeWsPath = isSingleHost ? "/code-ws" : undefined;
  const configJs = configJsHandler(platformZone, appZone, consoleOrigin, wsOrigin, codeWsOrigin, codeWsPath);

  const sites: SiteBlock[] = [];

  if (deploymentModel === "localhost") {
    const httpPort = opts.highPorts ? 8443 : 80;
    const portSuffix = httpPort === 80 ? "" : `:${httpPort}`;
    sites.push({
      addresses: [`http://localhost${portSuffix}`, `http://127.0.0.1${portSuffix}`],
      tls: undefined,
      handlers: configJs + "\n" + replace(generateCaddyHandlers("all", handlerOpts)),
    });
  } else if (deploymentModel === "direct") {
    const addresses = [mainDomain, codeDomain, devDomain];
    if (customDomain) addresses.push(customDomain);
    sites.push({
      addresses,
      handlers: configJs + "\n" + replace(generateCaddyHandlers("all", handlerOpts)),
    });
  } else {
    // Two site blocks: platform-zone (srv + code) and app-zone (dev preview)
    // Both use CF origin certs + mTLS (Authenticated Origin Pulls).
    const aiTls: SiteBlock["tls"] = {
      cert: "/etc/caddy/origin.crt",
      key: "/etc/caddy/origin.key",
      clientAuth: CF_AOP_CA,
    };
    const appTls: SiteBlock["tls"] = {
      cert: "/etc/caddy/origin-app.crt",
      key: "/etc/caddy/origin-app.key",
      clientAuth: CF_AOP_CA,
    };

    const aiAddresses = [`${mainDomain}:443`, `${codeDomain}:443`];
    if (opts.originTag) {
      aiAddresses.push(`o-${opts.originTag}.${platformZone}:443`);
    }
    sites.push({
      addresses: aiAddresses,
      tls: aiTls,
      handlers: configJs + "\n" + replace(generateCaddyHandlers("ai", handlerOpts)),
    });
    // Wildcard covers ALL *.{appZone} subdomains: dev preview, deployed apps, origin hostname.
    sites.push({
      addresses: [`*.${appZone}:443`],
      tls: appTls,
      handlers: replace(generateCaddyHandlers("app", handlerOpts)),
    });

    // Customer custom domain — own site block so host matchers can target it.
    // Runs the same main handler as `{shortId}-srv` (shield + chat + terminals
    // + agent bridge). Same origin cert (*.ellul.ai) + mTLS: traffic arrives from
    // Cloudflare's edge via resolveOverride to o-{tag}.ellul.ai, so the cert
    // presented is for the origin hostname, not the customer's hostname.
    // Cloudflare handles the SNI cert for acme.com at its edge.
    if (customDomain) {
      sites.push({
        addresses: [`${customDomain}:443`],
        tls: aiTls,
        handlers: configJs + "\n" + replaceDomains(
          generateCaddyHandlers("ai", handlerOpts),
          customDomain,    // main handler matches acme.com
          codeDomain,      // code viewer stays on {shortId}-code.ellul.ai
          devDomain,
        ),
      });
    }
  }

  const canDeploy = opts.canDeploy !== false;
  const autoHttps = deploymentModel !== "direct" && deploymentModel !== "localhost";
  const parts = [
    renderGlobalOptions(autoHttps, true, platformZone),
    "",
    ...(canDeploy ? ["import /etc/caddy/sites-enabled/*.caddy", ""] : [""]),
    ...sites.map(renderSiteBlock),
    "",
  ];

  return parts.join("\n");
}
