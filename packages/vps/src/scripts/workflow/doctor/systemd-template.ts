// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Perf monitor systemd service.
 *
 * @param apiUrl - The ellul API URL
 * @param _aiProxyToken - Deprecated. Kept for callsite compatibility; the
 *   token is no longer baked into the unit. Reads from /etc/default/ellul-secrets
 *   at service start (and on every restart) so token rotation propagates without
 *   a unit regeneration. Baking the token into Environment= meant the unit
 *   captured whatever value `aiProxyToken` had at TS-build time — which during
 *   provisioning is the BOOTSTRAP-token placeholder /install hands out before
 *   bootstrap.sh swaps in the real token. Result: perf-monitor heartbeated
 *   forever with the UUID-shaped bootstrap token, /api/servers/heartbeat
 *   hashed it, found no DB match, returned 401 every 60 s, drowned the wake
 *   state machine in invalid-token noise. EnvironmentFile is the same
 *   mechanism enforcer / sovereign-shield use — single source of truth.
 */
export function getPerfMonitorService(
  apiUrl: string,
  _aiProxyToken?: string,
): string {
  void _aiProxyToken;
  return `[Unit]
Description=ellul Performance Monitor
After=network.target

[Service]
Type=simple
User=root
Environment=API_URL=${apiUrl}
# Token sourced from boot-config-written secrets file — NOT baked into the
# unit, so the unit reflects whatever token is on disk after bootstrap.sh's
# swap. Failure modes that previously surfaced as silent 401s now surface as
# "ELLUL_AI_TOKEN unset; refusing to start" via the ExecStartPre check.
EnvironmentFile=/etc/default/ellul-secrets
# Presence check only — boot-config-linux.sh already shape-gates the
# token to 64 lowercase hex before writing the secrets file, so
# anything in this env var has already passed validation. Avoid
# \${#VAR} in ExecStartPre because systemd treats \${...} as its own
# specifier (it would look up an env var literally named "#VAR",
# substitute empty, and the resulting \`[ -eq 64 ]\` would be a sh
# syntax error → status=2 → service stuck activating).
ExecStartPre=/usr/bin/test -n "\${ELLUL_AI_TOKEN}"
ExecStart=/usr/local/bin/ellul-perf-monitor
Restart=always
RestartSec=30

# Security hardening
LimitCORE=0
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target`;
}
