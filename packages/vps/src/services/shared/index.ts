// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Shared utilities for VPS services.
 *
 * These utilities eliminate code duplication across:
 * - sovereign-shield
 * - file-api
 * - enforcer
 * - agent-bridge
 * - term-proxy
 */

// Constants
export * from './constants';

// Shield internal API client (for file-api, agent-bridge, enforcer)
export {
  callShieldInternal,
  shieldGet,
  shieldPost,
  setShieldServiceName,
} from './shield-client';

// Caddy admin API
export { reloadCaddy } from './caddy';

// Tier utilities
export {
  getCurrentTier,
  setTier,
  isStandardTier,
  isWebLockedTier,
  isPasskeyRequired,
} from './tier';

// Credential utilities
export {
  getServerId,
  getApiUrl,
  getDomain,
  getOwnerId,
  setOwnerId,
  getJwtSecret,
  getServerCredentials,
  type ServerCredentials,
} from './credentials';

// Framework detection & registry
export {
  FRAMEWORKS,
  detectFramework,
  detectPackageManager,
  findAppRoot,
  getStartCommand,
  getInstallCommand,
  resolveModule,
  generateBashDetectFramework,
  generateBashGetCommand,
  generateBashWaitForInstall,
  generateBashStackDetect,
  type FrameworkDef,
  type Runtime,
  type PackageManager,
  type PackageManagerInfo,
} from './framework';

// Memory budget — framework-aware dev-server RSS profile, host-aware
// reservation split, control-plane heap caps, PostgreSQL sizing.
export {
  FRAMEWORK_MEMORY,
  PER_PREVIEW_CEILING_MB,
  PER_PREVIEW_FLOOR_MB,
  PREVIEW_SLICE_PERCENT,
  computeFrameworkCgroupCaps,
  computeMemoryBudget,
  computeNodeHeapCaps,
  computePostgresMemory,
  estimatePreviewPeakMB,
  estimatePreviewSteadyMB,
  frameworkMemoryProfile,
  hotPreviewsCap,
  type BudgetOptions,
  type FrameworkCgroupCaps,
  type FrameworkMemoryProfile,
  type MemoryBudget,
  type NodeHeapCaps,
  type PostgresMemoryProfile,
} from './memory-budget';

// Preview lifecycle mode (hot/warm) — public so scripts / admission
// calls outside file-api can produce spec-compatible records without
// coupling to the file-api package.
export type { PreviewMode, PreviewSpec, PreviewRuntime } from './preview-spec';

// Framework-agnostic warm artifact detection — which build outputs
// mean a given framework can start in production mode without a
// rebuild. Covers frontend SSR/SPA, backend servers, JVM, CLR,
// interpreted runtimes, and compiled natives uniformly.
export {
  FRAMEWORK_ARTIFACTS,
  artifactsFor,
  probeWarmArtifact,
  type ArtifactProbe,
  type FrameworkArtifacts,
  type FsProbe,
  type WarmProbeResult,
} from './framework-artifacts';
