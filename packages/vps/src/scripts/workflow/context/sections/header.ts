// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import type { VpsIdentity, ProductFeatures, DeployedApp, ContextMode } from '../types';

import headerShieldTpl from '@vps/templates/context/header-shield.md';

/**
 * Build the header section. Preview URL is included only when mode is not 'base'.
 */
export function header(id: VpsIdentity, features: ProductFeatures, deployedApps: DeployedApp[], mode: ContextMode = 'base'): string {
  const wantPreview = features.hasPreview && mode !== 'base';

  switch (id.product) {
    case 'cloud_platform': {
      let result = `# ellul Server (${id.domain})`;
      if (wantPreview) {
        result += `\n\nPreview: https://${id.devDomain}`;
      }
      if (features.freeTier) {
        result += '\n\nFree tier — deployment not available.';
      } else if (features.hasDeploy && wantPreview) {
        const appList = deployedApps.length
          ? deployedApps.map(app => `- ${app.name}: ${app.url} (port ${app.port})`).join('\n')
          : '(none)';
        result += `\n\n### Currently deployed:\n${appList}`;
      }
      return result;
    }
    case 'cloud_sandbox': {
      let result = `# ellul Sandbox (${id.domain})`;
      if (wantPreview) {
        result += `\n\nPreview: https://${id.devDomain}`;
        result += '\nSandbox mode: no deployments, no managed databases. Code only.';
      }
      return result;
    }
    case 'shield_proxy':
      return headerShieldTpl.replace('__DOMAIN__', () => id.domain);
  }
}
