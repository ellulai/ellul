// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * IDE (code-server) Bundle Generator
 *
 * Unlike file-api/agent-bridge, code-server is a standalone binary — no esbuild
 * needed. This module exports string generators for the systemd unit, shell
 * wrapper, and version tracking.
 *
 * Terminal intercept: code-server's SHELL env var is overridden to point at
 * ellul-code-terminal, which routes every terminal spawn through the
 * per-project namespace isolation script (deny-by-default, zero-possession
 * env injection).
 */

/**
 * Generate the systemd service file for the IDE (code-server).
 * @param svcUser - Service user name (coder for free tier, dev for paid)
 */
export function getIdeService(svcUser: string = "dev"): string {
  const svcHome = `/home/${svcUser}`;
  const isFreeTier = svcUser === 'coder';
  const securityBlock = isFreeTier
    ? `# Security hardening (free tier)
# NoNewPrivileges intentionally NOT set — shell wrapper needs sudo for
# ellul-agent-namespace (per-project isolation). Sudoers restricts sudo
# to ONLY that script. SUID bits removed from dangerous binaries in security.ts.
SupplementaryGroups=shield-ipc
ProtectSystem=strict
PrivateTmp=true
ReadWritePaths=${svcHome} /tmp
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true`
    : `# Paid tier — ProtectSystem=strict with broader write paths.
# Agent has sudo for namespace isolation but filesystem access is scoped.
SupplementaryGroups=shield-ipc
ProtectSystem=strict
PrivateTmp=true
ReadWritePaths=${svcHome} /tmp
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true`;

  return `[Unit]
Description=ellul IDE (code-server)
After=network-online.target local-fs.target ellul-luks-boot.service
Wants=network-online.target ellul-luks-boot.service
RequiresMountsFor=/etc/ellul /opt/ellul

[Service]
Type=simple
User=${svcUser}
Group=${svcUser}
WorkingDirectory=${svcHome}
Environment=NODE_ENV=production
# Shell wrapper intercepts every terminal spawn and routes through namespace
Environment=SHELL=/usr/local/bin/ellul-code-terminal
Environment=PATH=${svcHome}/.node/bin:${svcHome}/.opencode/bin:${svcHome}/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/local/bin/code-server --bind-addr 127.0.0.1:3003 --auth none --cert false --disable-telemetry --user-data-dir ${svcHome}/.code-server --extensions-dir ${svcHome}/.code-server/extensions
Restart=on-failure
RestartSec=5
KillMode=mixed
TimeoutStopSec=90
# CPU bandwidth limit — prevents code-server from monopolizing CPU and starving
# sovereign-shield (runs at SCHED_FIFO priority). 80% cap ensures shield's gate
# expiry callbacks, credential destruction, and attestation responses always
# get scheduled promptly. Matches agent-bridge CPUQuota.
CPUQuota=80%
# Core dump prevention — code-server may have env vars (API keys, DATABASE_URL)
# in process memory. Crash dumps could leak secrets to disk.
LimitCORE=0

${securityBlock}

[Install]
WantedBy=multi-user.target
`;
}

/**
 * Generate the namespace-aware shell wrapper for code-server terminals.
 *
 * SECURITY PROPERTIES:
 * 1. Deny-by-default: terminals outside ~/projects/<name> are BLOCKED
 * 2. Zero-possession: secrets fetched from shield, written to temp file,
 *    sourced inside namespace, deleted — never on disk inside namespace
 * 3. Same isolation as agent-bridge: mount/PID/net namespace per project
 * 4. Atomic env file creation with restricted perms (umask 0077) — no
 *    TOCTOU window between create and chmod
 * 5. mktemp for unpredictable filenames — prevents PID-guessing attacks
 * 6. Strict project name validation — matches namespace-spawn.service.ts
 * 7. Curl timeout + response validation — prevents hang and injection
 */
export function getIdeShellWrapper(): string {
  // Built via string concatenation to avoid TypeScript template literal
  // interpretation of bash ${VAR} syntax.
  const lines = [
    '#!/bin/bash',
    '# ellul-code-terminal — Namespace-aware shell for code-server terminals',
    '# Set as SHELL= in code-server\'s systemd unit.',
    '# SECURITY: Deny-by-default. Every terminal MUST run inside a namespace.',
    '# No fallback to uncontained bash — prevents namespace escape via cd traversal.',
    '',
    'set -euo pipefail',
    '',
    'SVC_USER=$(grep -oP \'PS_USER=\\K\\w+\' /etc/default/ellul 2>/dev/null || echo "dev")',
    'SVC_HOME="/home/$SVC_USER"',
    'NS_SCRIPT="/usr/local/bin/ellul-agent-namespace"',
    '',
    '# Extract project name from CWD: /home/{user}/projects/{project}/...',
    'PROJECT=""',
    'if [[ "$PWD" =~ ^${SVC_HOME}/projects/([^/]+) ]]; then',
    '  PROJECT="${BASH_REMATCH[1]}"',
    'fi',
    '',
    '# ── STRICT PROJECT SLUG VALIDATION ──',
    '# Projects use immutable slugs: sbx-{7char nanoid}.',
    '# Prevents shell injection via malicious project directory names.',
    '# Defense-in-depth: agent-namespace re-validates, but we catch it early.',
    'if [ -z "$PROJECT" ] || ! echo "$PROJECT" | grep -qE \'^sbx-[a-z0-9]{7}$\'; then',
    '  echo "ERROR: Terminal blocked — must be inside a valid project directory." >&2',
    '  echo "Project slugs must match sbx-{7char} format." >&2',
    '  echo "Open a workspace under ~/projects/<slug> to get a terminal." >&2',
    '  exit 1',
    'fi',
    '',
    'if [ ! -x "$NS_SCRIPT" ]; then',
    '  echo "ERROR: Namespace script not found. Terminal blocked for safety." >&2',
    '  exit 1',
    'fi',
    '',
    '# ── ENV INJECTION (Zero-Possession) ──',
    '# Gather project-scoped secrets (DATABASE_URL, API keys, etc.) and write',
    '# to a one-time env file. The namespace script sources it inside the',
    '# isolated namespace, then deletes it — secrets never touch disk inside',
    '# the namespace and exist only in process memory via execve.',
    '#',
    '# SECURITY:',
    '# - mktemp for unpredictable filenames (prevents PID-guessing attacks)',
    '# - umask 0077 for atomic 0600 creation (no TOCTOU chmod window)',
    '# - printf instead of echo (prevents escape sequence interpretation)',
    '# - curl --max-time 5 (prevents indefinite hang if shield unresponsive)',
    '# - Response validation (only export lines allowed, rejects injection)',
    '',
    '# Ask sovereign-shield for project-scoped env vars via internal API',
    '# (same pattern as agent-bridge\'s cli-env.service.ts)',
    'SHIELD_URL="http://127.0.0.1:3005/api/internal/env/${PROJECT}"',
    'ENV_RESPONSE=$(curl -sf --max-time 5 "$SHIELD_URL" 2>/dev/null || true)',
    '',
    'if [ -n "$ENV_RESPONSE" ]; then',
    '  # Validate response: every non-empty line must be a shell export.',
    '  # Rejects injected commands, semicolons, backticks, pipes, etc.',
    '  if echo "$ENV_RESPONSE" | grep -vE \'^(export [a-zA-Z_][a-zA-Z0-9_]*=.*|\\s*)$\' | grep -q .; then',
    '    echo "ERROR: Invalid env response from sovereign-shield. Terminal blocked." >&2',
    '    exit 1',
    '  fi',
    '',
    '  # Create env file with restricted perms atomically (umask prevents TOCTOU)',
    '  ENV_FILE=$(umask 0077 && mktemp /tmp/.ns-env-code-XXXXXXXXXX)',
    '  printf \'%s\\n\' "$ENV_RESPONSE" > "$ENV_FILE"',
    '  exec sudo "$NS_SCRIPT" spawn "$PROJECT" --env-file "$ENV_FILE" /bin/bash "$@"',
    'else',
    '  # No secrets available (shield returned empty or unreachable)',
    '  # Spawn namespace without env injection — still fully isolated',
    '  exec sudo "$NS_SCRIPT" spawn "$PROJECT" /bin/bash "$@"',
    'fi',
  ];
  return lines.join('\n') + '\n';
}

