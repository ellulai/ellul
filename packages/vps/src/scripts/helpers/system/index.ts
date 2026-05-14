// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * System helper scripts — privileged scripts deployed to /usr/local/bin/ on VPS servers.
 * These are called via sudo by the service user for specific operations.
 */

export { getMountVolumeScript } from './mount-volume/index';
export { getUpdateIdentityScript } from './update-identity/index';
export { getRestoreIdentityScript } from './restore-identity';
export { getAptInstallScript } from './apt-install';
export { getUpdateBinaryScript } from './update-binary';
export { getOpencodeExecScript } from './opencode-exec';
export { getGbrainInitScript } from './gbrain-init';
