// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * SSH key setup script - allows users to add SSH keys after provisioning.
 * Creates the sovereign lock file after first key install, preventing
 * future key injection via the platform.
 */

import setupContent from '@vps/shell/security/setup-ssh-key.sh';
import addContent from '@vps/shell/security/add-ssh-key.sh';
import shieldMgrContent from '@vps/shell/security/shield-ssh-key-mgr.sh';

export function getSetupSshKeyScript(): string {
  return setupContent;
}

/**
 * Helper script for users to add additional SSH keys after sovereign lock.
 * Handles the chattr unlock/lock cycle automatically.
 */
export function getAddSshKeyScript(): string {
  return addContent;
}

/**
 * Sudo wrapper called by sovereign-shield to manage authorized_keys.
 * Runs as root via shield-runner sudoers entry — see shield-runner-setup.sh.
 * Handles add/remove/list with strict input validation, vault-source-aware
 * writes, and chattr immutability.
 */
export function getShieldSshKeyMgrScript(): string {
  return shieldMgrContent;
}
