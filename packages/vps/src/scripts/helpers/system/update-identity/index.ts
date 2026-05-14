// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Server identity update script.
 * Runs as root via sudo -- updates identity files after tier migration.
 * Called by file-api's /api/update-identity daemon endpoint.
 *
 * Composed from:
 *   - identity-files: server-id, domain, owner.lock, billing-tier, metadata, keypair, env sync
 *   - caddy-regen: Caddyfile generation, validation, atomic swap
 *   - service-restart: dependency-aware restart with retry, Caddy safety trap
 */
import skeleton from '@vps/templates/helpers/system/update-identity/update-identity.sh';
import { getIdentityFilesBlock } from './identity-files';
import { getCaddyRegenBlock } from './caddy-regen';
import { getServiceRestartBlock } from './service-restart';

export function getUpdateIdentityScript(): string {
  return skeleton
    .replace('__IDENTITY_FILES__', () => getIdentityFilesBlock())
    .replace('__CADDY_REGEN__', () => getCaddyRegenBlock())
    .replace('__SERVICE_RESTART__', () => getServiceRestartBlock());
}
