// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * @ellul.ai/vps
 *
 * VPS utilities, scripts, and service bundles for ellul servers.
 *
 * Service architecture:
 *   gateway/     — Network edge (Caddy config, terminal proxy)
 *   auth/        — Authentication boundary (sovereign-shield)
 *   backends/    — Application services (file-api, agent-bridge)
 *   daemons/     — Background processes (enforcer, watchdog)
 */

export {
  CAPABILITIES,
  FEATURE_DESCRIPTIONS,
  type VpsCapabilities,
} from './version';

// Auth service (sovereign-shield — passkey, JWT, PoP, sessions, tier-gate)
export {
  getSovereignShieldScript,
  getSovereignShieldService,
  getVpsAuthScript,
  getVpsAuthService,
  getVpsAuthPrereqService,
  getDowngradeScript,
  getWebLockedSwitchScript,
  getResetAuthScript,
  getTierSwitchHelperScript,
} from './services/auth/sovereign-shield/bundle';

// Backend services
export {
  getFileApiScript,
  getFileApiService,
} from './services/backends/file-api/bundle';

export {
  getAgentBridgeScript,
  getAgentBridgeService,
  getAgentBridgeSocketUnit,
} from './services/backends/agent-bridge/bundle';

// Daemon services
export {
  getEnforcerScript,
  getEnforcerService,
} from './services/daemons/enforcer/bundle';
