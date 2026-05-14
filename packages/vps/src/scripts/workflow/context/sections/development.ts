// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import type { VpsIdentity, ProjectState } from '../types';
import { SCAFFOLDABLE_FRAMEWORK_IDS } from '@vps/shared/framework';

import projectSetupTpl from '@vps/templates/context/project-setup.md';
import devServerTpl from '@vps/templates/context/dev-server.md';
import metadataTpl from '@vps/templates/context/metadata.md';
import projectChecklistTpl from '@vps/templates/context/project-checklist.md';
import stylingTpl from '@vps/templates/context/styling.md';

/** Durable deploy note — explains deployed apps are frozen snapshots, not live code. */
export function deployedAppsNote(): string {
  return `## Deployed Apps
Deployed apps are frozen snapshots. Code edits do NOT change them. Do not deploy or redeploy unless the user explicitly asks.`;
}

export function projectSetup(project: ProjectState): string {
  return projectSetupTpl
    .split('__PREVIEW_PORT__').join(String(project.previewPort));
}

export function devServer(id: VpsIdentity, project: ProjectState): string {
  return devServerTpl
    .replace('__PREVIEW_PORT__', () => String(project.previewPort))
    .replace('__DEV_DOMAIN__', () => id.devDomain);
}

export function metadata(hasDeploy: boolean): string {
  const deployNote = hasDeploy
    ? 'After deployment, the system adds: deployedUrl, deployedDomain, deployedPort to ellul.json (frozen snapshots — code edits do NOT change the deployed site)'
    : '';
  return metadataTpl.replace('__DEPLOY_NOTE__', () => deployNote).trimEnd();
}

export function projectChecklist(id: VpsIdentity, project: ProjectState): string {
  return projectChecklistTpl
    .split('__PREVIEW_PORT__').join(String(project.previewPort))
    .split('__DEV_DOMAIN__').join(id.devDomain)
    .split('__SUPPORTED_FRAMEWORKS__').join(SCAFFOLDABLE_FRAMEWORK_IDS.join(', '));
}

export function styling(): string {
  return stylingTpl;
}
