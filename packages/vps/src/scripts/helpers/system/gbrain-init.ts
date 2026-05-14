// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import content from '@vps/shell/helpers/system/gbrain-init.sh';

/**
 * gbrain first-time bootstrap script.
 * Runs as root via sudo — creates postgres DB/role, generates credentials,
 * writes env file + access token. Idempotent.
 */
export function getGbrainInitScript(): string {
  return content;
}
