// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Deployment Service
 *
 * Switch deployment model (proxied/direct) by regenerating
 * the Caddyfile and updating TLS certificates.
 *
 * Called via bridge endpoint (passkey-authenticated).
 */

import { execSync, execFileSync } from 'child_process';
import fs from 'fs';
import { reloadCaddy } from '@vps/shared/caddy';
import { generateCaddyfileContent } from '@vps/services/gateway/caddy-gen/caddyfile';
import type { VpsDeploymentModel } from '@vps/shared/constants';
import { PLATFORM_ZONE, APP_ZONE } from '../../config';

export interface DeploymentSwitchOpts {
  model: VpsDeploymentModel;
  domain: string;
  serverId?: string;
  cfOriginCert?: string;
  cfOriginKey?: string;
  cfAppOriginCert?: string;
  cfAppOriginKey?: string;
}

const CADDYFILE = '/etc/caddy/Caddyfile';
const DOMAIN_FILE = '/etc/ellul/domain';
const SERVER_ID_FILE = '/etc/ellul-bootstrap/server-id';
const ORIGIN_TAG_FILE = '/etc/ellul/origin-tag';

/**
 * Write a certificate file with proper ownership.
 */
function writeCert(path: string, content: string, mode: number): void {
  fs.writeFileSync(path, content);
  fs.chmodSync(path, mode);
  try { execFileSync('chown', ['caddy:caddy', path], { timeout: 3_000, stdio: 'pipe' }); } catch {}
}

/**
 * Detect current deployment model from Caddyfile.
 * Binary: auto_https off = proxied (CF origin certs + mTLS), else = direct (Let's Encrypt).
 */
function detectCurrentModel(): VpsDeploymentModel {
  try {
    const caddyfile = fs.readFileSync(CADDYFILE, 'utf8');
    if (caddyfile.includes('auto_https off')) return 'proxied';
  } catch {}
  return 'direct';
}

/**
 * Read current short server ID (first 8 chars).
 */
function getShortId(): string {
  try {
    return fs.readFileSync(SERVER_ID_FILE, 'utf8').trim().slice(0, 8);
  } catch {
    return '';
  }
}

/**
 * Compute code and dev subdomains for a given model and short ID.
 */
function computeSubdomains(model: VpsDeploymentModel, shortId: string): { code: string; dev: string } {
  const prefix = model === 'direct' ? 'd' : '';
  return {
    code: `${shortId}-${prefix}code.${PLATFORM_ZONE}`,
    dev: `${shortId}-${prefix}dev.${APP_ZONE}`,
  };
}

/**
 * Switch the deployment model. Handles:
 * - Same-model domain update (in-place replace, preserve Caddyfile)
 * - Model switch (regenerate Caddyfile via generateCaddyfileContent)
 * - Origin cert rotation
 * - State file updates
 * - Sovereign-shield restart + Caddy reload
 */
export async function switchDeployment(opts: DeploymentSwitchOpts): Promise<{ success: boolean; error?: string }> {
  // Validate domain — must be a valid hostname (letters, digits, dots, hyphens only)
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(opts.domain)) {
    return { success: false, error: 'Invalid domain format' };
  }

  const currentModel = detectCurrentModel();
  const oldDomain = (() => { try { return fs.readFileSync(DOMAIN_FILE, 'utf8').trim(); } catch { return ''; } })();
  const oldShortId = getShortId();

  const newShortId = opts.serverId ? opts.serverId.slice(0, 8) : oldShortId;
  if (!newShortId) {
    return { success: false, error: 'Cannot determine server ID' };
  }

  const newSubs = computeSubdomains(opts.model, newShortId);

  // Write origin certs if provided (*.ellul.ai)
  if (opts.cfOriginCert) writeCert('/etc/caddy/origin.crt', opts.cfOriginCert, 0o644);
  if (opts.cfOriginKey) writeCert('/etc/caddy/origin.key', opts.cfOriginKey, 0o600);
  // App origin certs (*.ellul.app)
  if (opts.cfAppOriginCert) writeCert('/etc/caddy/origin-app.crt', opts.cfAppOriginCert, 0o644);
  if (opts.cfAppOriginKey) writeCert('/etc/caddy/origin-app.key', opts.cfAppOriginKey, 0o600);

  if (opts.model === currentModel && oldDomain) {
    // Same model: replace domains in-place (preserves full Caddyfile structure)
    if (oldDomain !== opts.domain) {
      const oldSubs = computeSubdomains(currentModel, oldShortId);
      try {
        let caddyContent = fs.readFileSync(CADDYFILE, 'utf8');
        caddyContent = caddyContent.split(oldDomain).join(opts.domain);
        caddyContent = caddyContent.split(oldSubs.code).join(newSubs.code);
        caddyContent = caddyContent.split(oldSubs.dev).join(newSubs.dev);
        fs.writeFileSync(CADDYFILE, caddyContent);
      } catch (e) {
        return { success: false, error: `Domain replace failed: ${(e as Error).message}` };
      }
    }
  } else {
    // Model switch: regenerate Caddyfile from scratch
    // Download AOP CA cert for proxied model
    if (opts.model === 'proxied') {
      if (!fs.existsSync('/etc/caddy/cf-origin-pull-ca.pem')) {
        try {
          execSync(
            'curl -sS https://developers.cloudflare.com/ssl/static/authenticated_origin_pull_ca.pem -o /etc/caddy/cf-origin-pull-ca.pem',
            { timeout: 10_000 }
          );
          execSync('chown caddy:caddy /etc/caddy/cf-origin-pull-ca.pem', { timeout: 3_000 });
        } catch {}
      }
    }

    try {
      const originTag = (() => {
        try { return fs.readFileSync(ORIGIN_TAG_FILE, 'utf8').trim() || undefined; } catch { return undefined; }
      })();

      const { PLATFORM_ZONE, APP_ZONE, CONSOLE_ORIGIN } = await import('../../config');
      let customDomain: string | undefined;
      try {
        const cd = fs.readFileSync('/etc/ellul/custom-domain', 'utf8').trim();
        if (cd) customDomain = cd;
      } catch {}

      const caddyGenOutput = generateCaddyfileContent({
        deploymentModel: opts.model,
        mainDomain: opts.domain,
        codeDomain: newSubs.code,
        devDomain: newSubs.dev,
        platformZone: PLATFORM_ZONE,
        appZone: APP_ZONE,
        consoleOrigin: CONSOLE_ORIGIN,
        customDomain,
        originTag,
      });
      fs.writeFileSync(CADDYFILE, caddyGenOutput);
      // 664 so subsequent regens from shield's startup path (and other
      // caddy-group members) don't hit EACCES. See main.ts:regen and
      // provisioning/caddy-main.sh for the full rationale.
      fs.chmodSync(CADDYFILE, 0o664);
    } catch (e) {
      return { success: false, error: `Caddyfile generation failed: ${(e as Error).message}` };
    }
  }

  // Update state files AFTER Caddyfile (so retries can find old domains)
  if (opts.serverId) {
    const currentId = (() => { try { return fs.readFileSync(SERVER_ID_FILE, 'utf8').trim(); } catch { return ''; } })();
    if (opts.serverId !== currentId) {
      fs.writeFileSync(SERVER_ID_FILE, opts.serverId);
    }
  }
  fs.writeFileSync(DOMAIN_FILE, opts.domain);

  // Restart sovereign-shield to pick up new domain (WebAuthn + CORS)
  try {
    execSync('systemctl restart ellul-sovereign-shield 2>/dev/null || true', { timeout: 15_000 });
  } catch {}

  // Wait for shield to boot, then reload Caddy via admin API
  try {
    await new Promise(r => setTimeout(r, 2000));
    await reloadCaddy();
  } catch (e) {
    return { success: false, error: `Caddy reload failed: ${(e as Error).message}` };
  }

  return { success: true };
}
