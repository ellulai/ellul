// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * SSH hardening configuration for ellul servers.
 * Disables password auth and root login, enforces key-based auth.
 */

import sshdConfig from '@vps/configs/system/sshd.conf';
import authorizedKeysScript from '@vps/configs/system/ssh-authorized-keys.sh';
import fail2banConfig from '@vps/configs/system/fail2ban.conf';
import unattendedUpgradesConfig from '@vps/configs/system/unattended-upgrades.conf';
import autoUpgradesConfig from '@vps/configs/system/auto-upgrades.conf';

export function getSshHardeningConfig(): string {
  return sshdConfig;
}

/**
 * SSH authorized keys lookup command.
 * Executed by sshd as root via AuthorizedKeysCommand.
 * File is 0700 root:root — agent cannot execute or read.
 * Reads from 0600 root:root key store — agent has zero visibility.
 */
export function getSshAuthorizedKeysCommand(): string {
  return authorizedKeysScript;
}

/**
 * Fail2ban configuration for SSH protection.
 */
export function getFail2banConfig(): string {
  return fail2banConfig;
}

/**
 * Unattended upgrades configuration for automatic security updates.
 */
export function getUnattendedUpgradesConfig(): string {
  return unattendedUpgradesConfig;
}

/**
 * Auto-upgrades periodic configuration.
 */
export function getAutoUpgradesConfig(): string {
  return autoUpgradesConfig;
}
