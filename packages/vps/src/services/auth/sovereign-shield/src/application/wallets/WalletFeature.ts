// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Wallet Feature Flag
 *
 * Guards all wallet subsystem code paths. The entire wallet infrastructure
 * (keypair, ledger, proxy endpoints, gate type) is unreachable unless
 * /etc/ellul/features/wallet exists on disk.
 *
 * No automated process creates this file — it must be placed manually
 * to enable the feature.
 */

import fs from 'fs';
import { WALLET_FEATURE_FILE } from '../../config';

let cachedEnabled: boolean | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 30_000; // 30 seconds

export function isWalletEnabled(): boolean {
  const now = Date.now();
  if (cachedEnabled !== null && now - cachedAt < CACHE_TTL_MS) {
    return cachedEnabled;
  }
  cachedEnabled = fs.existsSync(WALLET_FEATURE_FILE);
  cachedAt = now;
  return cachedEnabled;
}
