// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * VPS Capabilities — runtime feature discovery surface.
 *
 * CAPABILITIES is exposed at GET /_auth/capabilities. The dashboard
 * and API read it to decide which UI to show and which endpoints to
 * call.
 *
 * Component versions are delivered out-of-band through the signed
 * agent manifest (apps/api/src/services/agent-manifest.service.ts)
 * and recorded on the VPS at /etc/ellul/shield-data/.agent-versions.json.
 *
 * Rules for CAPABILITIES: add freely, edit carefully (bump endpoint
 * version), remove never.
 */

export const CAPABILITIES = {
  endpoints: {
    '/_auth/session': 1,
    '/_auth/terminal/authorize': 1,
    '/_auth/terminal/validate': 1,
    '/_auth/code/authorize': 1,
    '/_auth/code/validate': 1,
    '/_auth/agent/authorize': 1,
    '/_auth/agent/validate': 1,
    '/_auth/tier/switch': 1,
    '/_auth/tier/current': 1,
    '/_auth/keys': 1,
    '/_auth/passkey/register-options': 1,
    '/_auth/passkey/register': 1,
    '/_auth/passkey/auth-options': 1,
    '/_auth/passkey/auth': 1,
    '/_auth/pop/bind': 1,
    '/_auth/bridge': 1,
    '/_auth/server/can-delete': 1,
    '/_auth/server/authorize-delete': 1,
    '/_auth/git/authorize-link': 1,
    '/_auth/git/verify-link-token': 1,
    '/_auth/git/authorize-unlink': 1,
    '/_auth/git/verify-unlink-token': 1,
    '/_auth/secrets': 1,
    '/_auth/bridge/settings': 1,
    '/_auth/bridge/toggle-terminal': 1,
    '/_auth/bridge/toggle-ssh': 1,
    '/_auth/bridge/kill-ports': 1,
    '/_auth/bridge/git-action': 1,
    '/_auth/bridge/switch-deployment': 1,
    '/_auth/bridge/confirm-infra': 1,
    '/_auth/bridge/reset-heartbeat': 1,
    '/api/backup-identity': 1,
    '/api/restore-identity': 1,
  },
  features: [
    'passkey',
    'pop',
    'ssh-keys',
    'tier-switch',
    'terminal-tokens',
    'code-browser',
    'agent-bridge',
    'git-link-passkey',
    'secrets',
    'settings-local',
    'bridge-operations',
    'infra-confirm',
    'heartbeat-reset',
    'ide',
  ] as const,
};

export type VpsCapabilities = {
  version: string;
  endpoints: Record<string, number>;
  features: string[];
};

export const FEATURE_DESCRIPTIONS: Record<(typeof CAPABILITIES.features)[number], string> = {
  'passkey': 'Passkey authentication (Face ID / Touch ID)',
  'pop': 'Proof-of-Presence device binding',
  'ssh-keys': 'SSH key management from dashboard',
  'tier-switch': 'Security tier switching (Standard / Web-Locked)',
  'terminal-tokens': 'Secure terminal session tokens',
  'code-browser': 'In-browser code editor',
  'agent-bridge': 'AI agent bridge for tool access',
  'git-link-passkey': 'Passkey confirmation for git repo linking (Web Locked)',
  'secrets': 'Direct encrypted secrets management (browser → VPS)',
  'settings-local': 'VPS-driven terminal/SSH settings (passkey-only)',
  'bridge-operations': 'VPS-driven kill-ports, git, deployment (passkey-only)',
  'infra-confirm': 'Passkey-gated confirmation tokens for dangerous daemon operations',
  'heartbeat-reset': 'Manual heartbeat key reset from dashboard',
  'ide': 'VS Code IDE (code-server)',
};
