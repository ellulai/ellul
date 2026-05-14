// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Identity file writes bash block — updates server-id, domain, owner.lock,
 * billing-tier, product, security-tier, metadata.json, heartbeat keypair,
 * and /etc/default/ellul.
 *
 * Returns a bash fragment. Expects all argument variables to be set by caller:
 *   SERVER_ID, DOMAIN, USER_ID, BILLING_TIER, PRODUCT, DEPLOYMENT_MODEL, SECURITY_TIER
 *   log() helper function
 */

import content from '@vps/shell/helpers/system/update-identity/identity-files.sh';

export function getIdentityFilesBlock(): string {
  return content;
}
