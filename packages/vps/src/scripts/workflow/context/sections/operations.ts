// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import type { VpsIdentity, ProductFeatures } from '../types';

import portsTpl from '@vps/templates/context/ports.md';
import secretsStandardTpl from '@vps/templates/context/secrets-standard.md';
import secretsOrgTpl from '@vps/templates/context/secrets-org.md';
import gatesPlatformTpl from '@vps/templates/context/gates-platform.md';
import gatesSandboxTpl from '@vps/templates/context/gates-sandbox.md';
import gatesShieldTpl from '@vps/templates/context/gates-shield.md';
import gatesAdapterTpl from '@vps/templates/context/gates-adapter.md';
import deploymentTpl from '@vps/templates/context/deployment.md';
import gitPaidTpl from '@vps/templates/context/git-paid.md';
import gitFreeTpl from '@vps/templates/context/git-free.md';
import gitProxyTpl from '@vps/templates/context/git-proxy.md';
import dbPlatformTpl from '@vps/templates/context/db-platform.md';
import commandsPlatformTpl from '@vps/templates/context/commands-platform.md';
import commandsPlatformFreeTpl from '@vps/templates/context/commands-platform-free.md';
import commandsSandboxTpl from '@vps/templates/context/commands-sandbox.md';
import commandsShieldTpl from '@vps/templates/context/commands-shield.md';
import uploadsTpl from '@vps/templates/context/uploads.md';
import freeLimitationsTpl from '@vps/templates/context/free-limitations.md';
import securityCriticalTpl from '@vps/templates/context/security-critical.md';

export function ports(id: VpsIdentity, features: ProductFeatures, previewPort: number): string {
  const appZone = id.devDomain.replace(/^[^.]+\./, '');
  const prodLine = features.hasDeploy
    ? `- Production: 3001+ (→ https://<app-name>-${id.shortId}.${appZone})`
    : '';
  return portsTpl
    .replace('__PREVIEW_PORT__', () => String(previewPort))
    .replace('__DEV_DOMAIN__', () => id.devDomain)
    .replace('__PROD_LINE__', () => prodLine)
    .replace(/\n\n\n/g, '\n');
}

export function secrets(_id: VpsIdentity, features: ProductFeatures): string {
  return features.orgScoped ? secretsOrgTpl : secretsStandardTpl;
}

export function sovereignGates(features: ProductFeatures): string {
  const { gates, orgScoped } = features;
  if (!gates.length) return '';

  if (orgScoped) return gatesAdapterTpl;
  if (gates.length === 1 && gates[0] === 'git') return gatesShieldTpl;
  if (gates.indexOf('deploy') !== -1) return gatesPlatformTpl;
  return gatesSandboxTpl;
}

export function deployment(): string {
  return deploymentTpl;
}

export function git(features: ProductFeatures): string {
  if (features.freeTier) return gitFreeTpl;
  if (!features.hasPreview) return gitProxyTpl;
  return gitPaidTpl;
}

export function managedDb(id: VpsIdentity, features: ProductFeatures): string {
  void features;
  return dbPlatformTpl
    .replace('__SVC_USER__', () => id.svcUser)
    .replace('__DOMAIN__', () => id.domain);
}

export function commands(id: VpsIdentity, features: ProductFeatures): string {
  if (features.freeTier) return commandsPlatformFreeTpl;
  if (id.product === 'cloud_platform') return commandsPlatformTpl;
  if (id.product === 'cloud_sandbox') return commandsSandboxTpl;
  if (id.product === 'shield_proxy') return commandsShieldTpl;
  return commandsPlatformTpl;
}

export function uploads(): string {
  return uploadsTpl;
}

export function freeLimitations(): string {
  return freeLimitationsTpl;
}

export function securityCritical(id: VpsIdentity): string {
  return securityCriticalTpl.replace('__HOME_DIR__', () => id.homeDir);
}
