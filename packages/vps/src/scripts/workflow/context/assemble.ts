// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Context assembly — composes section functions into complete markdown
 * based on the product feature matrix and active context mode.
 *
 * Mode controls which layers are included:
 * - 'base'    — rules, secrets, gates, git, db, commands, security (slim — saves tokens)
 * - 'preview' — base + scaffolding, metadata, OpenAPI, dev server, styling, ports, uploads
 * - 'deploy'  — preview + deployment mechanics (future)
 *
 * The bash script auto-promotes base → preview when ellul.json has previewable: true.
 */

import type {
  VpsIdentity,
  ProductFeatures,
  ProjectState,
  DeployedApp,
  ContextMode,
} from "./types";
import { header } from "./sections/header";
import { rules } from "./sections/rules";
import {
  deployedAppsNote,
  projectSetup,
  devServer,
  metadata,
  projectChecklist,
  styling,
} from "./sections/development";
import {
  ports,
  secrets,
  sovereignGates,
  deployment,
  git,
  managedDb,
  commands,
  uploads,
  freeLimitations,
  securityCritical,
} from "./sections/operations";

function buildSections(
  id: VpsIdentity,
  features: ProductFeatures,
  project: ProjectState,
  deployedApps: DeployedApp[],
  mode: ContextMode,
): string[] {
  const wantPreview = features.hasPreview && mode !== "base";
  const wantDeploy = features.hasDeploy && mode === "deploy";
  const sections: string[] = [];

  sections.push(header(id, features, deployedApps, mode));
  sections.push(rules(id, features));

  // Development sections — only in preview/deploy mode (previewable projects)
  if (wantPreview) {
    if (features.hasScaffolding) {
      sections.push(projectSetup(project));
      sections.push(devServer(id, project));
      sections.push(metadata(features.hasDeploy));
    }

    if (features.hasScaffolding) {
      sections.push(projectChecklist(id, project));
    }

    // Preview: styling, ports
    if (features.hasStyling) sections.push(styling());
    if (features.hasPorts)
      sections.push(ports(id, features, project.previewPort));

    // Deploy semantics
    if (features.hasDeploy) sections.push(deployedAppsNote());

    if (features.hasUploads) sections.push(uploads());
  }

  if (features.hasSecrets) sections.push(secrets(id, features));
  if (features.gates.length) sections.push(sovereignGates(features));
  if (features.hasDeploy && wantDeploy) sections.push(deployment());
  sections.push(git(features));
  if (features.hasManagedDb) sections.push(managedDb(id, features));
  sections.push(commands(id, features));
  if (features.freeTier) sections.push(freeLimitations());
  sections.push(securityCritical(id));

  // Filter out empty sections (functions return '' when gated off internally)
  return sections.filter((s) => s.trim());
}

/**
 * Assemble global context markdown for the given product+tier+mode.
 */
export function assembleGlobalContext(
  id: VpsIdentity,
  features: ProductFeatures,
  deployedApps: DeployedApp[],
  mode: ContextMode = "base",
): string {
  const project: ProjectState = {
    name: "projects",
    dir: `${id.homeDir}/projects`,
    previewPort: 4000,
  };
  return buildSections(id, features, project, deployedApps, mode).join("\n\n");
}

/**
 * Assemble per-project CLAUDE.md content wrapped in ELLUL markers.
 */
export function assembleProjectContext(
  id: VpsIdentity,
  features: ProductFeatures,
  project: ProjectState,
  deployedApps: DeployedApp[],
  mode: ContextMode = "base",
): string {
  const content = buildSections(id, features, project, deployedApps, mode).join(
    "\n\n",
  );
  return `<!-- ELLUL:START — Auto-generated rules. Do not edit between these markers. -->\n${content}\n<!-- ELLUL:END -->`;
}
