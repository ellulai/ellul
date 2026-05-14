// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Product-aware context generation types.
 */

export type Product = 'cloud_platform' | 'cloud_sandbox' | 'shield_proxy';
export type Tier = 'free' | 'paid' | 'governance';
export type ContextMode = 'base' | 'preview' | 'deploy';

/** Runtime VPS identity — read once from /etc/ellul/ files */
export interface VpsIdentity {
  product: Product;
  tier: Tier;
  domain: string;
  devDomain: string;
  shortId: string;
  svcUser: string;
  homeDir: string;
}

/** Per-project runtime state */
export interface ProjectState {
  name: string;
  dir: string;
  previewPort: number;
  appName?: string;
  type?: string;
  framework?: string;
}

/** Deployed app metadata from ~/.ellul/apps/*.json */
export interface DeployedApp {
  name: string;
  url: string;
  port: number;
  domain: string;
  projectPath: string;
}

/** Feature flags derived from product + tier */
export interface ProductFeatures {
  hasPreview: boolean;
  hasDeploy: boolean;
  hasManagedDb: boolean;
  hasOpenApiSpec: boolean;
  hasScaffolding: boolean;
  hasStyling: boolean;
  hasPorts: boolean;
  hasSecrets: boolean;
  hasUploads: boolean;
  gates: ('env' | 'logs' | 'db' | 'git' | 'deploy')[];
  orgScoped: boolean;
  freeTier: boolean;
}
