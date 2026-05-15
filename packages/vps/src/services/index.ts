// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * VPS Services Index
 *
 * Unified exports for all VPS service bundles.
 *
 * Architecture:
 *   gateway/     — Network edge (Caddy config, terminal proxy)
 *   auth/        — Authentication boundary (sovereign-shield)
 *   backends/    — Application services (file-api, agent-bridge)
 *   daemons/     — Background processes (enforcer, watchdog)
 *   shared/      — Cross-service utilities
 */

// ── Auth (sovereign-shield — passkey, JWT, PoP, sessions, tier-gate) ──
export {
  getSovereignShieldScript,
  getSovereignShieldService,
} from './auth/sovereign-shield/bundle';

// ── Gateway (network edge) ──
export { getCaddyGenScript } from './gateway/caddy-gen/bundle';
export { generateCaddyfileContent, CADDY_ADMIN_SOCK, type CaddyfileOptions } from './gateway/caddy-gen/caddyfile';
export { getTermProxyScript, getTermProxyService } from './gateway/term-proxy';

// ── Backends (application services behind the gateway) ──
export {
  getFileApiScript,
  getFileApiService,
} from './backends/file-api/bundle';

export {
  getAgentBridgeScript,
  getAgentBridgeService,
  getAgentBridgeSocketUnit,
} from './backends/agent-bridge/bundle';

// ── Daemons (background processes) ──
export {
  getEnforcerScript,
  getEnforcerService,
} from './daemons/enforcer/bundle';

export {
  getWatchdogService,
  getWatchdogScript,
} from './daemons/watchdog/index';

export {
  getNamespacedDaemonService,
  getNamespacedDaemonTarball,
} from './daemons/ellul-namespaced/bundle';

// ── AI Tools (opt-in, VPS-local feature toggle) ──
export {
  getGbrainService,
  computeGbrainHeapCap,
} from './backends/gbrain/bundle';
