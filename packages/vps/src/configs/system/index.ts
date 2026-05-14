// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * System Configuration Generators
 *
 * Core system configurations: bash, git, SSH, security.
 */

export { getGlobalGitignore } from "./gitignore";
export { getPreCommitHook } from "./pre-commit-hook";
export { getPrePushHook } from "./pre-push-hook";
export { getGitCredentialHelper } from "./git-credential-helper";
export { getGitWrapper } from "./git-wrapper";
export {
  getSshHardeningConfig,
  getSshAuthorizedKeysCommand,
  getFail2banConfig,
  getUnattendedUpgradesConfig,
  getAutoUpgradesConfig,
} from "./ssh-hardening";
export { getBashrcConfig, getMotdScript } from "./bashrc";
export { getPreviewUnitsSudoers } from "./sudoers-preview-units";
