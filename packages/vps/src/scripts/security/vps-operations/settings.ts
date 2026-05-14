// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import content from '@vps/shell/security/vps-operations/settings.sh';

/**
 * ellul-settings - Settings are managed via the dashboard
 *
 * Terminal and SSH settings require passkey authentication (physical device).
 * This prevents AI agents from changing settings programmatically.
 */

export function getSettingsScript(): string {
  return content;
}
