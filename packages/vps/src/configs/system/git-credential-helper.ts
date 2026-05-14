// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import content from '@vps/configs/system/git-credential-helper.sh';

/**
 * Sovereign Credential Helper script content.
 *
 * Two credential paths:
 *   1. GIT_CREDENTIAL_SESSION env var (shield's safeGitCmd) — internal ops
 *   2. Gate flow via bridge (agent shell push) — human approval modal
 *
 * Path 2 calls bridge git-exec-authorize, which broadcasts the gate modal
 * to the console. Credentials only flow after the human approves (or the
 * user has configured allow_session / allow_always for the git gate).
 */
export function getGitCredentialHelper(): string {
  return content;
}
