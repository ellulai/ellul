// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Progress reporter script - reports provisioning progress to the API.
 *
 * @param apiUrl - The ellul API URL
 * @param aiProxyToken - The server's AI proxy token
 */

import skeleton from '@vps/templates/report-progress.sh';

export function getReportProgressScript(
  apiUrl: string,
  aiProxyToken: string
): string {
  return skeleton
    .replace('__API_URL__', () => apiUrl)
    .replace('__AI_PROXY_TOKEN__', () => aiProxyToken);
}
