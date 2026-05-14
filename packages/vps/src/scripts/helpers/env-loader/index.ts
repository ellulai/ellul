// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import content from '@vps/shell/helpers/env-loader.sh';

/**
 * Environment Loader Script
 *
 * Returns the contents of ellul-env-loader.sh for deployment to VPS.
 * Deployed to /usr/local/bin/ellul-env-loader.sh (root:root 755).
 *
 * Reads NUL-delimited KEY=VALUE pairs from stdin, exports them as
 * environment variables, then exec's the command passed as arguments.
 *
 * SECURITY: Uses NUL-delimited read instead of eval to prevent shell
 * metacharacter injection. A malicious secret value like $(rm -rf /)
 * is treated as a literal string, never executed. Secrets never appear
 * in /proc/<pid>/cmdline or /proc/<pid>/environ of the parent.
 *
 * Shield sends secrets as: KEY=value\0KEY2=value2\0
 */

export function getEnvLoaderScript(): string {
  return content;
}
