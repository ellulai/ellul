// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import content from '@vps/shell/helpers/system/update-binary.sh';
import { BINARY_VERSIONS, BINARY_HASHES } from '../../../pinned-versions';

/**
 * Binary update helper script.
 * Runs as root via sudo -- downloads a binary from an allowlisted GitHub repo
 * and atomically replaces the existing binary at a validated path.
 *
 * Security model:
 *   - Only allowlisted binaries can be updated (hardcoded name->repo+arch map)
 *   - Only GitHub releases URLs accepted (prevents arbitrary downloads)
 *   - Download to temp dir, verify executable, then atomic replace to /usr/local/bin
 *   - No user-controlled paths reach the filesystem
 */
export function getUpdateBinaryScript(): string {
  return content
    .split('__ZEROCLAW_VERSION__').join(BINARY_VERSIONS.zeroclaw)
    .split('__OPENCODE_VERSION__').join(BINARY_VERSIONS.opencode)
    .split('__CURSOR_VERSION__').join(BINARY_VERSIONS.cursorAgent)
    .split('__CURSOR_SHA_AMD64__').join(BINARY_HASHES.cursorAgent!.amd64)
    .split('__CURSOR_SHA_ARM64__').join(BINARY_HASHES.cursorAgent!.arm64);
}
