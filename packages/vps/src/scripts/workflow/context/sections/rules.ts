// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import type { VpsIdentity, ProductFeatures } from '../types';

import ruleWorkspace from '@vps/templates/context/rule-workspace.md';
import ruleNameProtection from '@vps/templates/context/rule-name-protection.md';
import ruleSecurity from '@vps/templates/context/rule-security.md';
import ruleSecurityProxy from '@vps/templates/context/rule-security-proxy.md';
import ruleNoDeploy from '@vps/templates/context/rule-no-deploy.md';
import ruleNoPush from '@vps/templates/context/rule-no-push.md';
import rulePreferAction from '@vps/templates/context/rule-prefer-action.md';

export function rules(id: VpsIdentity, features: ProductFeatures): string {
  const lines: string[] = ['## RULES (ALWAYS FOLLOW)'];
  let n = 1;

  lines.push(`${n++}. ${ruleWorkspace}`);
  lines.push(`${n++}. ${ruleNameProtection}`);

  if (id.product === 'shield_proxy') {
    lines.push(`${n++}. ${ruleSecurityProxy}`);
  } else {
    lines.push(`${n++}. ${ruleSecurity}`);
  }

  if (features.hasDeploy) {
    lines.push(`${n++}. ${ruleNoDeploy}`);
  }

  if (features.gates.indexOf('git') !== -1) {
    lines.push(`${n++}. ${ruleNoPush}`);
  }

  if (features.hasScaffolding) {
    lines.push(`${n++}. ${rulePreferAction}`);
  }

  return lines.join('\n');
}
