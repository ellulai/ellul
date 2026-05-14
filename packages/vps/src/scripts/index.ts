// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * VPS CLI Scripts
 *
 * Shell scripts deployed to VPS as CLI tools.
 */

// Core scripts
export { getReportProgressScript } from './report-progress';
export { getTermProxyScript, getTermProxyService } from '../services/gateway/term-proxy';
export { getMountVolumeScript, getAptInstallScript, getUpdateIdentityScript, getRestoreIdentityScript, getUpdateBinaryScript, getOpencodeExecScript, getGbrainInitScript } from './helpers/system';
export { getNetnsHelperScript } from './helpers/netns';
export { getEnvShieldPreload } from './helpers/env-shield-preload';
export { getEnvLoaderScript } from './helpers/env-loader/index';
export { getAgentNamespaceScript, getNsShellScript } from './helpers/agent-namespace';
export { getSeccompExecSource } from './helpers/agent-namespace/seccomp';
export { getNsMountSource } from './helpers/agent-namespace/ns-mount';
export { getClaudeNsScript, getCodexNsScript } from './helpers/namespace-wrappers';
export {
  getDaemonSources,
  getDaemonTestSources,
  getFdPassSource,
  type DaemonSource,
} from './helpers/ellul-namespaced';
// Re-export the MCP relay source via scripts/index (a tsup top-level entry)
// so build-agent-bundles.mjs can load it from the bundled dist JS where
// tsup's `.sh → text` esbuild loader has already inlined the relay bytes.
// Importing mcp-relay-script.ts directly from build-agent-bundles fails
// because Node's native TS loader doesn't know how to resolve `.sh` files.
export { getMcpRelayScript } from '../services/backends/agent-bridge/src/application/mcp-tool/McpRelayScript';

// Domain-specific scripts
export * from './workflow';
export * from './security';
export * from './sessions';
