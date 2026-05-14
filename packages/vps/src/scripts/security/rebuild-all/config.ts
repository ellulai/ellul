// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * config.ts -- VPS configuration reading from /etc/ellul/ files.
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── Constants ──────────────────────────────────────────────────────
export const REPO_DIR = '/opt/ellul';
export const ENFORCER_LIB_DIR = path.join(REPO_DIR, 'src', 'services', 'daemons', 'enforcer', 'lib');

// ─── Config reading ─────────────────────────────────────────────────

export interface VpsConfig {
  serverId: string;
  domain: string;
  apiUrl: string;
  aiProxyToken: string;
  billingTier: string;
  product: string;
}

export function readConfig(): VpsConfig {
  const read = (file: string): string => {
    try {
      return fs.readFileSync(file, 'utf8').trim();
    } catch {
      return '';
    }
  };
  return {
    serverId: read('/etc/ellul-bootstrap/server-id'),
    domain: read('/etc/ellul/domain'),
    apiUrl: read('/etc/ellul/api-url'),
    aiProxyToken: read('/etc/ellul-bootstrap/ai-proxy-token'),
    billingTier: read('/etc/ellul/billing-tier') || 'paid',
    product: read('/etc/ellul/product') || 'cloud_platform',
  };
}
