// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import content from '@vps/shell/security/verify.sh';

/**
 * Verification script - outputs server security status.
 */
export function getVerifyScript(): string {
  return content;
}
