// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import content from '@vps/shell/workflow/service-installer.sh';
import { APT_SERVICE_PACKAGES } from '../../pinned-versions';

/**
 * Service installer tool - just-in-time database/service installation with resource checking.
 */
export function getServiceInstallerScript(): string {
  return content
    .split('__APT_POSTGRESQL__').join(APT_SERVICE_PACKAGES.postgresql.join(' '))
    .split('__APT_REDIS__').join(APT_SERVICE_PACKAGES.redis.join(' '))
    .split('__APT_MARIADB__').join(APT_SERVICE_PACKAGES.mariadb.join(' '));
}
