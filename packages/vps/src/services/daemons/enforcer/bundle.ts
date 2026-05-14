// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Assembles the enforcer bash daemon from modular lib/*.sh components.

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { ALL_LOCALES } from '@ellul.ai/i18n-consts';
import { buildLocaleToGlibcCase } from '@ellul.ai/i18n-messages/shell-strings';
import { advertisedCapabilityIds } from '../../../capabilities';

function readTierManifestArtifact(name: string): string {
  const sourceDir = getSourceDir();
  const repoRoot = sourceDir.replace(/\/services\/daemons\/enforcer$/, '').replace(/\/src$/, '');
  const candidate = path.join(repoRoot, 'src', 'manifests', name);
  if (fs.existsSync(candidate)) {
    return fs.readFileSync(candidate).toString('base64');
  }
  return '';
}

function readPinnedOpencodeVersion(): string {
  const sourceDir = getSourceDir();
  const repoRoot = sourceDir.replace(/\/services\/daemons\/enforcer$/, '').replace(/\/src$/, '');
  const pinned = path.join(repoRoot, 'src', 'pinned-versions.ts');
  if (!fs.existsSync(pinned)) return '';
  const src = fs.readFileSync(pinned, 'utf8');
  const match = src.match(/opencode:\s*"([^"]+)"/);
  return match?.[1] ?? '';
}

function readPinnedCursorVersion(): string {
  const sourceDir = getSourceDir();
  const repoRoot = sourceDir.replace(/\/services\/daemons\/enforcer$/, '').replace(/\/src$/, '');
  const pinned = path.join(repoRoot, 'src', 'pinned-versions.ts');
  if (!fs.existsSync(pinned)) return '';
  const src = fs.readFileSync(pinned, 'utf8');
  const match = src.match(/cursorAgent:\s*"([^"]+)"/);
  return match?.[1] ?? '';
}

// Cache for assembled script
let cachedScript: string | null = null;
let cachedApiUrl: string | null = null;

// Resolves src/ from either src/ (dev) or dist/ (prod).
function getSourceDir(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);

  // If we're in dist (compiled), go up to package root and into src/
  if (currentDir.includes('/dist/') || currentDir.endsWith('/dist')) {
    const packageRoot = currentDir.replace(/\/dist(\/.*)?$/, '');
    return path.join(packageRoot, 'src', 'services', 'daemons', 'enforcer');
  }

  // Already in src/
  return currentDir;
}

function readLib(name: string): string {
  const sourceDir = getSourceDir();
  const libPath = path.join(sourceDir, 'lib', `${name}.sh`);
  if (fs.existsSync(libPath)) {
    // Remove shebang line if present
    return fs.readFileSync(libPath, 'utf8').replace(/^#!\/bin\/bash\n/, '').trim();
  }
  throw new Error(`Library not found: ${libPath}`);
}

// Emits ENFORCER_CAPABILITIES bash array + JSON helper from central TS registry.
function renderEnforcerCapabilitiesBlock(): string {
  const ids = advertisedCapabilityIds('enforcer');
  const lines = ids.map((id) => `  "${id}"`).join('\n');
  return [
    'declare -a ENFORCER_CAPABILITIES=(',
    lines,
    ')',
    '',
    'enforcer_capabilities_json() {',
    '  if [ ${#ENFORCER_CAPABILITIES[@]} -eq 0 ]; then',
    '    echo "[]"',
    '    return 0',
    '  fi',
    '  printf \'%s\\n\' "${ENFORCER_CAPABILITIES[@]}" | jq -Rnc \'[inputs]\' 2>/dev/null || echo "[]"',
    '}',
  ].join('\n');
}

/**
 * Assemble the enforcer script from modules.
 */
function assembleScript(apiUrl: string): string {
  // Read library modules
  const constants = readLib('constants');
  const logging = readLib('logging');
  const terminals = readLib('terminals');
  const security = readLib('security');
  const status = readLib('status');
  const enforcement = readLib('enforcement');
  const deployment = readLib('deployment');
  const agents = readLib('agents');
  const blockMigrate = readLib('block-migrate');
  // Locale: substitute the canonical glibc map + ALL_LOCALES pattern from
  // i18n-consts so this file never duplicates the locale list.
  const locale = readLib('locale')
    .split('__LOCALE_TO_GLIBC_CASE__')
    .join(buildLocaleToGlibcCase('_locale_to_glibc'))
    .split('__SUPPORTED_LOCALE_PATTERN__')
    .join(ALL_LOCALES.join('|'));
  // Capability block generated from the central TS registry. There is
  // no hand-maintained capabilities.sh — the build output IS the
  // source of truth at runtime, and the registry is the source of
  // truth at build time. Zero drift possible.
  const capabilities = renderEnforcerCapabilitiesBlock();
  const agentSync = readLib('agent-sync');
  const heartbeat = readLib('heartbeat');
  const services = readLib('services');
  // NOTE: The MCP stdio relay used to be inlined here as a heredoc and
  // written by the enforcer at boot. It now ships as a first-class
  // member of the core-runtime tarball (see CORE_RUNTIME_SUBCOMPONENTS
  // in scripts/build-agent-bundles.mjs) and is symlinked by
  // ensure_bin_symlink alongside file-api.js and agent-bridge.js.
  // Relay updates now flow through the same deploy path as every other
  // service — no coupling between relay changes and enforcer releases.

  // Tier manifest material — signed by the operator's Ed25519 key
  // (apps/api/scripts/sign-manifests.ts). Embedded here so the
  // ellul-namespaced daemon's startup gate (manifest.pub + tier.cbor)
  // is satisfied via the same signed-release trust root as the rest
  // of the enforcer code. Not present → daemon throws on startup.
  const nsdManifestPubB64 = readTierManifestArtifact('manifest.pub');
  const nsdManifestPubNextB64 = readTierManifestArtifact('manifest-next.pub');
  const nsdFreeCborB64 = readTierManifestArtifact('free.cbor');
  const nsdPaidCborB64 = readTierManifestArtifact('paid.cbor');

  // Expected opencode binary version. The enforcer compares this against
  // `opencode --version` on every sync tick and triggers
  // ellul-update-binary opencode on drift. Without this auto-update,
  // bumping BINARY_VERSIONS.opencode in pinned-versions.ts only updates
  // future provisions — running VPSes keep their old binary, drift
  // silently from the SDK in the bridge, and session.create starts
  // returning no payload.
  const pinnedOpencodeVersion = readPinnedOpencodeVersion();
  const pinnedCursorVersion = readPinnedCursorVersion();

  return `#!/bin/bash
# ellul State Enforcer Daemon (ellul-env)
# Built from modular components in packages/vps/src/services/daemons/enforcer/lib/

API_URL="${apiUrl}"
TOKEN="$ELLUL_AI_TOKEN"
DAEMON_VERSION="$(jq -r '."ellul-env" // "unknown"' /etc/ellul/shield-data/.agent-versions.json 2>/dev/null || echo 'unknown')"

# ============================================
# Embedded ellul-namespaced tier manifest material (base64)
# ============================================
ELLUL_NSD_MANIFEST_PUB_B64="${nsdManifestPubB64}"
ELLUL_NSD_MANIFEST_PUB_NEXT_B64="${nsdManifestPubNextB64}"
ELLUL_NSD_FREE_CBOR_B64="${nsdFreeCborB64}"
ELLUL_NSD_PAID_CBOR_B64="${nsdPaidCborB64}"

# ============================================
# Pinned binary versions
# ============================================
EXPECTED_OPENCODE_VERSION="${pinnedOpencodeVersion}"
EXPECTED_CURSOR_VERSION="${pinnedCursorVersion}"

# ============================================
# Constants
# ============================================
${constants}

# ============================================
# Logging
# ============================================
${logging}

# ============================================
# Terminal Management
# ============================================
${terminals}

# ============================================
# Security (Tier Detection, Identity Pinning)
# ============================================
${security}

# ============================================
# Status Reporting
# ============================================
${status}

# ============================================
# Enforcement (Settings, Kill Orders, Actions)
# ============================================
${enforcement}

# ============================================
# Deployment Model Switching
# ============================================
${deployment}

# ============================================
# Agent Telemetry
# ============================================
${agents}

# ============================================
# Block Migration (Class A Encrypted Volume)
# ============================================
${blockMigrate}

# ============================================
# Locale Reconciler (Phase 7a-NATIVE Layer 3)
# Mirrors sovereign-shield's chat-route locale intent into the
# system-wide /etc/ellul/user-locale and /etc/environment LANG/LC_ALL.
# Filesystem-mediated to preserve the heartbeat one-way invariant.
# ============================================
${locale}

# ============================================
# Capabilities — namespaced capability strings advertised on every liveness ping
# so the dashboard can gate features.
# Must come before agent-sync.sh so agent_ping can read the array.
# ============================================
${capabilities}

# ============================================
# Agent Sync — fleet self-update with signed manifest fetching.
# Must come before heartbeat.sh so fetch_entitlement_if_stale,
# poll_and_execute_commands, and heartbeat() can reference the
# JWS helpers + sync_agent_bundle.
# ============================================
${agentSync}

# ============================================
# Heartbeat & Sync
# ============================================
${heartbeat}

# ============================================
# Service Health Monitoring
# ============================================
${services}

# ============================================
# Namespace iptables self-heal — declarative custom chains
# ============================================
#
# Maintains two enforcer-owned custom chains:
#
#   ELLUL-NS-IN  (jumped from INPUT)
#     one rule per active project: -i ea-{slug} -s NS_IP/32
#     -p tcp --dport 7702 -j ACCEPT
#
#   ELLUL-NS-OUT (jumped from OUTPUT)
#     one rule per active project, per service user:
#     -m owner --uid-owner {dev|coder} -d NS_IP/32 -j ACCEPT
#
# Why a custom chain instead of per-heartbeat -I/-D:
#   - The entire chain can be flushed and rebuilt in one operation —
#     no per-rule "does it exist?" checks, no drift-insertion race.
#   - One "iptables -S ELLUL-NS-IN" diff tells you exactly what the
#     enforcer currently allows, for every active project at once.
#   - Atomic: while the chain is being rebuilt inside iptables' single
#     transaction, the jump to it from INPUT/OUTPUT keeps delivering
#     packets to the old ruleset; swap is seamless.
#   - Scoped to exactly the ports in PORT_REGISTRY + the exact veth
#     interface of each project, never a /11 blanket.
#   - Drift is logged ONCE per reconcile when content changes, not
#     per-rule churn.
#
# Idempotent; called on every heartbeat. Any iptables failure is
# logged and ignored so it can never brick the daemon's main loop.

# Compute the deterministic NS_IP / HOST_IP for a project slug the same
# way packages/vps/src/shell/helpers/agent-namespace/network-setup.sh does:
#   HMAC-SHA256(NS_IP_KEY, slug) → first 3 bytes → IP octets
#   OCTET1 = (byte[0] % 55) + 200     → 200..254
#   OCTET2 = byte[1]                  → 0..255
#   OCTET3 = byte[2] & 0xFC           → aligned to /30
#   NS_IP   = 10.OCTET1.OCTET2.(OCTET3+2)
#   HOST_IP = 10.OCTET1.OCTET2.(OCTET3+1)
#
# Must match the bash implementation exactly or the rule will be
# installed with a wrong source IP and namespace traffic will fall
# through to the catch-all DROP.
_ellul_ns_ip_key() {
  local _key=""
  [ -f /etc/ellul/jwt-secret ] && _key=\$(cat /etc/ellul/jwt-secret 2>/dev/null | tr -d '[:space:]')
  [ -z "\$_key" ] && [ -f /etc/machine-id ] && _key=\$(cat /etc/machine-id 2>/dev/null | tr -d '[:space:]')
  printf '%s' "\$_key"
}

_ellul_ns_compute_ips() {
  # Args: slug → emits "NS_IP HOST_IP VETH_SHORT" on stdout, or nothing on error.
  local slug="\$1"
  local key
  key=\$(_ellul_ns_ip_key)
  [ -z "\$key" ] && return 1
  local hash
  hash=\$(printf '%s' "\$slug" | openssl dgst -sha256 -hmac "\$key" -hex 2>/dev/null | awk '{print \$NF}')
  [ -z "\$hash" ] && return 1
  local b0 b1 b2
  b0=\$((16#\${hash:0:2}))
  b1=\$((16#\${hash:2:2}))
  b2=\$((16#\${hash:4:2}))
  local o1 o2 o3
  o1=\$(((b0 % 55) + 200))
  o2=\$b1
  o3=\$((b2 & 252))
  local ns_ip="10.\$o1.\$o2.\$((o3 + 2))"
  local host_ip="10.\$o1.\$o2.\$((o3 + 1))"
  # Short name used by the namespace script: first 7 chars after "sbx-"
  local short="\${slug#sbx-}"
  short="\${short:0:7}"
  printf '%s %s %s\n' "\$ns_ip" "\$host_ip" "\$short"
}

# Emit the desired rule content for ELLUL-NS-IN + ELLUL-NS-OUT
# based on the active namespaces currently anchored under /run/.ns-*.
_ellul_ns_emit_desired_rules() {
  local _IPT="\$1"
  shift
  local _svc_users=("\$@")

  for _ns_dir in /run/.ns-*; do
    [ -d "\$_ns_dir" ] || continue
    local _slug="\${_ns_dir##*/.ns-}"
    # Validate slug shape so we never reflect attacker-controlled
    # directory names into iptables arguments.
    case "\$_slug" in
      sbx-[a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9]) ;;
      *) continue ;;
    esac
    local _anchor="\$_ns_dir/anchor.pid"
    [ -f "\$_anchor" ] || continue
    local _ips
    _ips=\$(_ellul_ns_compute_ips "\$_slug") || continue
    local _ns_ip _host_ip _short
    read -r _ns_ip _host_ip _short <<< "\$_ips"
    [ -z "\$_ns_ip" ] && continue
    local _veth="ea-\$_short"

    # INPUT allow: accept packets from this namespace's veth peer to
    # the MCP endpoint port. Interface match stops public-net spoofing.
    printf -- '-A ELLUL-NS-IN -i %s -s %s/32 -p tcp --dport 7702 -j ACCEPT\n' "\$_veth" "\$_ns_ip"

    # OUTPUT allow: let each service user reply to this exact namespace
    # peer IP. Scoped to /32 — NOT the /11 blanket we used to ship.
    for _u in "\${_svc_users[@]}"; do
      printf -- '-A ELLUL-NS-OUT -m owner --uid-owner %s -d %s/32 -j ACCEPT\n' "\$_u" "\$_ns_ip"
    done
  done
}

ensure_namespace_iptables_rules() {
  local _IPT=/usr/sbin/iptables
  [ -x "\$_IPT" ] || _IPT=/sbin/iptables
  [ -x "\$_IPT" ] || _IPT=\$(command -v iptables 2>/dev/null)
  if [ -z "\$_IPT" ] || [ ! -x "\$_IPT" ]; then
    log "ns-iptables: WARN iptables binary not found — skipping self-heal"
    return 0
  fi

  # Step 1: ensure the custom chains exist.
  for _chain in ELLUL-NS-IN ELLUL-NS-OUT; do
    if ! "\$_IPT" -S "\$_chain" >/dev/null 2>&1; then
      "\$_IPT" -N "\$_chain" 2>/dev/null && log "ns-iptables: created chain \$_chain"
    fi
  done

  # Step 2: ensure INPUT and OUTPUT jump to our chains exactly once.
  # Use -C to test idempotently; only -I if missing.
  if ! "\$_IPT" -C INPUT  -j ELLUL-NS-IN  2>/dev/null; then
    "\$_IPT" -I INPUT  -j ELLUL-NS-IN  2>/dev/null && log "ns-iptables: inserted INPUT jump to ELLUL-NS-IN"
  fi
  if ! "\$_IPT" -C OUTPUT -j ELLUL-NS-OUT 2>/dev/null; then
    "\$_IPT" -I OUTPUT -j ELLUL-NS-OUT 2>/dev/null && log "ns-iptables: inserted OUTPUT jump to ELLUL-NS-OUT"
  fi

  # Step 3: build the desired content for each chain from the set of
  # currently-anchored namespaces, compare against what's in the chain
  # today, and rebuild if anything changed. One log line per diff.
  local _svc_users=()
  for _u in dev coder; do
    id -u "\$_u" >/dev/null 2>&1 && _svc_users+=("\$_u")
  done
  [ \${#_svc_users[@]} -eq 0 ] && _svc_users=("dev")

  local _desired
  _desired=\$(_ellul_ns_emit_desired_rules "\$_IPT" "\${_svc_users[@]}")

  local _current_in _current_out
  _current_in=\$("\$_IPT"  -S ELLUL-NS-IN  2>/dev/null | grep -v '^-N ELLUL-NS-IN\$'  || true)
  _current_out=\$("\$_IPT" -S ELLUL-NS-OUT 2>/dev/null | grep -v '^-N ELLUL-NS-OUT\$' || true)

  local _desired_in  _desired_out
  _desired_in=\$(printf '%s\n'  "\$_desired" | grep -- '^-A ELLUL-NS-IN '  || true)
  _desired_out=\$(printf '%s\n' "\$_desired" | grep -- '^-A ELLUL-NS-OUT ' || true)

  if [ "\$_current_in" != "\$_desired_in" ]; then
    "\$_IPT" -F ELLUL-NS-IN 2>/dev/null
    # Rules are emitted in "-A CHAIN args..." form so iptables
    # appends them directly without further parsing. Word-splitting
    # on the unquoted expansion is INTENTIONAL here — each rule
    # line is a whitespace-separated argv, not a shell string.
    while IFS= read -r _rule; do
      [ -n "\$_rule" ] || continue
      # shellcheck disable=SC2086
      "\$_IPT" \$_rule 2>/dev/null || true
    done <<< "\$_desired_in"
    local _count
    _count=\$(printf '%s\n' "\$_desired_in" | grep -c . || true)
    log "ns-iptables: synced ELLUL-NS-IN (\$_count rule(s))"
  fi

  if [ "\$_current_out" != "\$_desired_out" ]; then
    "\$_IPT" -F ELLUL-NS-OUT 2>/dev/null
    while IFS= read -r _rule; do
      [ -n "\$_rule" ] || continue
      # shellcheck disable=SC2086
      "\$_IPT" \$_rule 2>/dev/null || true
    done <<< "\$_desired_out"
    local _count
    _count=\$(printf '%s\n' "\$_desired_out" | grep -c . || true)
    log "ns-iptables: synced ELLUL-NS-OUT (\$_count rule(s))"
  fi

  # Step 4: migration cleanup — if older enforcer versions left blanket
  # 10.200.0.0/11 rules in the raw INPUT/OUTPUT chains, delete them.
  # Harmless if they're already gone.
  "\$_IPT" -D INPUT  -i ea-+ -s 10.200.0.0/11 -p tcp --dport 7702 -j ACCEPT 2>/dev/null || true
  "\$_IPT" -D INPUT          -s 10.200.0.0/11 -p tcp --dport 7702 -j ACCEPT 2>/dev/null || true
  for _u in dev coder; do
    "\$_IPT" -D OUTPUT -m owner --uid-owner "\$_u" -d 10.200.0.0/11 -j ACCEPT 2>/dev/null || true
  done
}

# ============================================
# Main Daemon Loop
# ============================================

run_daemon() {
  log "============================================"
  log "ellul Enforcer UPDATED - v\${DAEMON_VERSION}"
  log "If you see this, the update was successful!"
  log "============================================"
  log "Starting state enforcer daemon v\${DAEMON_VERSION} (heartbeat every \${HEARTBEAT_INTERVAL}s, push via SIGUSR1)..."

  # Seed the cloud-init baseline into /opt/ellul/releases/ellul-env/baseline
  # so the very first self-update has a rollback target. Without this, a
  # first-install self-update whose new daemon crashes had prev_target="",
  # and agent_sync_recover_from_crash would log "cannot roll back" and
  # leave the broken binary live — bricking the VPS with no safe harbour.
  # Runs before recover_from_crash so the recovery path can actually
  # revert to baseline if needed.
  agent_sync_seed_baseline

  # Crash-loop recovery: if the previous daemon wrote a pending-commit
  # marker and never cleared it, this daemon's existence is evidence
  # the new binary didn't stabilise. Stale marker → roll back + exec.
  agent_sync_recover_from_crash

  # Brick-proofing: roll back any component whose 'current' symlink
  # points at a release dir without an '.applied-stable' marker. A
  # missing marker means the apply was interrupted before the post-
  # restart stability gate could declare it good (most often: a reboot
  # mid-window — power loss, OOM-loop breaker firing during the gate,
  # the operator pulling the plug). Without this check, the host comes
  # back live on a half-applied bundle that may crash on first request,
  # and there's no signal to the apply path to un-do it. Must run
  # BEFORE the daemon enters its main loop so a half-applied
  # core-runtime can be unwound before agent-bridge / file-api start
  # serving traffic from it.
  agent_sync_validate_at_boot

  # Write PID file for SIGUSR1-based push triggers (nginx/PostgreSQL pattern)
  echo \$\$ > "\$ENFORCER_PID_FILE"
  trap 'rm -f "\$ENFORCER_PID_FILE"' EXIT

  # SIGUSR1 handler: API pushes commands via file-api -> SIGUSR1 -> immediate heartbeat
  WAKEUP=0
  trap 'WAKEUP=1' USR1

  # Clean up any stale lockdown markers from pre-Phase 4
  rm -f /etc/ellul/.emergency-lockdown /etc/ellul/.in_lockdown 2>/dev/null || true

  # Self-heal systemd units for existing servers.
  local _UNIT="/etc/systemd/system/ellul-enforcer.service"
  local _NEEDS_RELOAD=false

  # Remove stale RequiresMountsFor (old units block enforcer on bind mount failure)
  if [ -f "\$_UNIT" ] && grep -q "RequiresMountsFor" "\$_UNIT" 2>/dev/null; then
    sed -i '/RequiresMountsFor/d' "\$_UNIT" 2>/dev/null
    _NEEDS_RELOAD=true
    log "Self-heal: removed RequiresMountsFor from enforcer unit"
  fi

  # Remove PrivateTmp if present (causes mount namespace isolation bugs)
  if [ -f "\$_UNIT" ] && grep -q "PrivateTmp=true" "\$_UNIT" 2>/dev/null; then
    sed -i 's/PrivateTmp=true/# PrivateTmp removed — causes mount namespace isolation/' "\$_UNIT" 2>/dev/null
    _NEEDS_RELOAD=true
    log "Self-heal: removed PrivateTmp from enforcer unit"
  fi

  # Self-heal: upgrade Type=simple → Type=notify
  if [ -f "\$_UNIT" ] && grep -q "Type=simple" "\$_UNIT" 2>/dev/null; then
    sed -i 's/^Type=simple/Type=notify/' "\$_UNIT" 2>/dev/null
    _NEEDS_RELOAD=true
    log "Self-heal: upgraded enforcer unit to Type=notify"
  fi

  # Self-heal: REMOVE WatchdogSec (any value). Block-migrate runs inline for
  # 30-60 min; the watchdog kills it mid-flight because daemon-reload doesn't
  # update the running service's watchdog. API-side stale recovery is sufficient.
  if [ -f "\$_UNIT" ] && grep -q "WatchdogSec" "\$_UNIT" 2>/dev/null; then
    sed -i '/^WatchdogSec/d' "\$_UNIT" 2>/dev/null
    _NEEDS_RELOAD=true
    log "Self-heal: removed WatchdogSec (incompatible with inline block-migrate)"
  fi

  # Fix fstab bind mounts: x-systemd.requires=local-fs.target creates a
  # circular dependency (bind mount → local-fs.target → bind mount).
  # systemd silently deletes the mount jobs, so bind mounts never activate.
  # Migrate to x-systemd.requires=home-{user}.mount for a linear chain.
  if grep -q 'x-systemd.requires=local-fs.target' /etc/fstab 2>/dev/null; then
    local _home_unit="home-\${SVC_USER}.mount"
    sed -i "s|bind,x-systemd.requires=local-fs.target|bind,nofail,x-systemd.requires=\${_home_unit}|g" /etc/fstab 2>/dev/null
    # Also fix entries that had nofail already
    sed -i "s|bind,nofail,x-systemd.requires=local-fs.target|bind,nofail,x-systemd.requires=\${_home_unit}|g" /etc/fstab 2>/dev/null
    _NEEDS_RELOAD=true
    log "Self-heal: migrated fstab bind mounts from local-fs.target → \$_home_unit"
  fi

  [ "\$_NEEDS_RELOAD" = "true" ] && systemctl daemon-reload 2>/dev/null || true

  # Self-heal: open the MCP endpoint + related bridge ports for the
  # namespace veth range (10.200.0.0/11, matches getNamespaceIp()'s
  # HMAC-derived octet1 = (hash[0] % 55) + 200 → 200..254).
  #
  # Problem we're fixing: the provisioning-time iptables rules bake in a
  # restrictive INPUT chain with a catch-all DROP that only allows ports
  # 22 and 443. Namespace → host MCP traffic (port 7702) hits the DROP
  # and the connection times out. Additionally, warden-iptables-dev.sh
  # inserts an OUTPUT DROP for the service user to 10.0.0.0/8, which
  # silently kills the agent-bridge's reply packets back to the namespace.
  #
  # Fix: insert narrow ACCEPT rules at the top of both chains scoped to
  # the namespace subnet. Idempotent via -C test; fail-soft on iptables
  # errors so a missing binary can't brick daemon startup. Uses absolute
  # path because run_daemon runs under systemd's reduced PATH.
  ensure_namespace_iptables_rules
  log "Self-heal: namespace iptables rules applied"

  # Re-assert /usr/local/bin symlinks for every active core-runtime
  # component. The self-update pattern (env applied last, core-runtime
  # applied under the OLD enforcer) means any symlinks ADDED to
  # ensure_bin_symlink in this release won't take effect on the apply
  # that shipped them — the old enforcer ran the old function body.
  # Running ensure_bin_symlink here at startup fills the gap so new
  # symlinks appear the moment the new enforcer takes over, without
  # needing another apply cycle. Idempotent.
  if [ -L "\$AGENT_RELEASES_ROOT/core-runtime/current" ]; then
    ensure_bin_symlink core-runtime 2>/dev/null \
      && log "Self-heal: refreshed core-runtime /usr/local/bin symlinks" \
      || log "Self-heal: WARN failed to refresh core-runtime symlinks"

    # Same story for file mode: stage_component was extended to promote
    # shebang files to 0755 at extract time, but the OLD enforcer that
    # performed the LAST core-runtime extract didn't have that logic.
    # Walk every live release dir once at startup and chmod 0755 any
    # file whose first two bytes are '#!'. Idempotent and cheap — just
    # reads 2 bytes per file. Fixes mcp-relay.js stuck at 0644 after
    # a cross-version apply.
    local _release_dir
    _release_dir=\$(readlink -f "\$AGENT_RELEASES_ROOT/core-runtime/current" 2>/dev/null)
    if [ -n "\$_release_dir" ] && [ -d "\$_release_dir" ]; then
      local _fixed=0
      while IFS= read -r -d '' _f; do
        if [ "\$(head -c 2 "\$_f" 2>/dev/null)" = '#!' ]; then
          if [ ! -x "\$_f" ]; then
            chmod 0755 "\$_f" 2>/dev/null && _fixed=\$((_fixed + 1))
          fi
        fi
      done < <(find "\$_release_dir" -type f -print0)
      [ "\$_fixed" -gt 0 ] && log "Self-heal: promoted \$_fixed shebang file(s) to 0755 under \$_release_dir"
    fi
  fi

  # STARTUP ENFORCEMENT: Run enforcement immediately on daemon start.
  # This ensures SSH is enabled (if keys exist) before the first heartbeat,
  # preventing lockout during the initial 30-second window.
  #
  # Wrapped in a hard time budget so that a hang inside enforce_settings
  # (e.g. a missing external tool, a systemd wait, an iptables lock held
  # by another daemon) cannot block the heartbeat loop indefinitely.
  # Pre-fix behaviour: when ufw was missing from a fresh image, the whole
  # daemon got stuck before the first heartbeat and systemd kept restarting
  # it — resulting in a VPS that never reported to the API at all, with no
  # out-of-band recovery path. Better to log a degraded-startup warning
  # and proceed to the heartbeat loop so the operator sees the incident
  # in the dashboard instead of a silent black hole.
  #
  # Implementation: fork a subshell, watchdog-kill it after STARTUP_BUDGET
  # seconds. A subshell is fine because enforce_settings/validate_full_stack
  # only mutate filesystem/kernel state (chmod, chattr, iptables, ufw) — no
  # caller-visible bash variables need to survive.
  local STARTUP_BUDGET=60
  _guarded_run() {
    local _label="\$1"; shift
    (
      "\$@"
    ) &
    local _pid=\$!
    ( sleep "\$STARTUP_BUDGET"; kill -TERM "\$_pid" 2>/dev/null; sleep 2; kill -KILL "\$_pid" 2>/dev/null ) &
    local _watcher=\$!
    wait "\$_pid" 2>/dev/null
    local _rc=\$?
    kill "\$_watcher" 2>/dev/null; wait "\$_watcher" 2>/dev/null
    if [ "\$_rc" -eq 0 ]; then
      log "\$_label complete"
    elif [ "\$_rc" -ge 124 ] && [ "\$_rc" -le 143 ]; then
      log "WARNING: \$_label hit \${STARTUP_BUDGET}s timeout (signal \$_rc) — continuing to heartbeat loop"
    else
      log "WARNING: \$_label exited rc=\$_rc — continuing to heartbeat loop"
    fi
  }

  local SETTINGS_FILE="/etc/ellul/shield-data/settings.json"
  local BOOT_TERMINAL=\$(jq -r '.terminalEnabled // "true"' "\$SETTINGS_FILE" 2>/dev/null || echo "true")
  local BOOT_SSH=\$(jq -r '.sshEnabled // "false"' "\$SETTINGS_FILE" 2>/dev/null || echo "false")
  log "Running startup enforcement (terminal=\$BOOT_TERMINAL, ssh=\$BOOT_SSH)..."
  _guarded_run "Startup enforcement" enforce_settings "\$BOOT_TERMINAL" "\$BOOT_SSH"

  log "Running feature state enforcement..."
  _guarded_run "Feature enforcement" enforce_features

  # BOOT VALIDATION: Verify all critical services are operational.
  # Same time-budget guard — a hung probe must never gate the first
  # heartbeat.
  log "Running boot validation..."
  _guarded_run "Boot validation" validate_full_stack

  # ── PRIMARY VAULT MOUNT OWNER ──────────────────────────────────────
  # The enforcer is the single owner of vault bind mounts. On every boot:
  # 1. Check if vault exists (volume-backed or root-FS)
  # 2. If any bind mount is missing, restore ALL mounts
  # 3. daemon-reload so systemd recognises the new mount state
  # 4. Start dependent services
  #
  # This handles: normal reboots, Hetzner resize, cloud-init re-runs,
  # systemd fstab generator failures — any scenario where bind mounts
  # are missing at boot. Idempotent: skips mounts already active.
  #
  # RequiresMountsFor is intentionally removed from this unit so the
  # enforcer starts even when bind mounts don't exist yet.
  local _VAULT="\$SVC_HOME/.ellul-vault"

  # ── LUKS boot state (handled by ellul-luks-boot.service) ──
  # The luks-boot oneshot runs BEFORE the enforcer and handles:
  # LUKS open, mount, vault bind mounts. The enforcer's vault check
  # below is defense-in-depth only (catches edge cases luks-boot missed).
  if [ -f /run/ellul-luks-pending ]; then
    log "Boot: LUKS volume pending unlock (sovereign mode or device not ready)"
  elif [ -f /run/ellul-decrypted ]; then
    log "Boot: LUKS volume opened by ellul-luks-boot.service"
  fi

  # ── LUKS recovery: if volume is encrypted but not open, retry opening ──
  # The LUKS boot service may have failed (fstab race, device not ready, etc.).
  # The enforcer retries as defense-in-depth — prevents the system from running
  # indefinitely without credentials after a failed boot.
  if [ -f /etc/ellul-bootstrap/volume-was-encrypted ] && [ ! -b /dev/mapper/luks-home ]; then
    # Sovereign mode: do NOT auto-open. Only the user's PRF key can unlock.
    local _SEC_MODE=""
    [ -f /etc/ellul-bootstrap/volume-security-mode ] && _SEC_MODE=\$(cat /etc/ellul-bootstrap/volume-security-mode 2>/dev/null)
    if [ "\$_SEC_MODE" = "sovereign" ]; then
      log "Boot: sovereign mode — skipping LUKS auto-recovery (PRF unlock required)"
    else
    log "Boot: LUKS volume encrypted but not open — retrying"
    local _LUKS_KEYFILE="/etc/ellul-bootstrap/.luks-platform-keyfile"
    [ -f "\$_LUKS_KEYFILE" ] || _LUKS_KEYFILE="/etc/ellul/.luks-platform-keyfile"
    local _LUKS_DEVICE=\$(cat /etc/ellul-bootstrap/volume-device 2>/dev/null || cat /etc/ellul/volume-device 2>/dev/null)
    if [ -n "\$_LUKS_DEVICE" ] && [ -f "\$_LUKS_KEYFILE" ]; then
      _LUKS_DEVICE=\$(readlink -f "\$_LUKS_DEVICE" 2>/dev/null || echo "\$_LUKS_DEVICE")
      if [ -b "\$_LUKS_DEVICE" ]; then
        # Try slot 1 first (platform recovery key, pbkdf2 — fast).
        # Slot 0 may be PRF-derived (argon2id) which can OOM on low-memory hosts.
        if cryptsetup luksOpen --key-file="\$_LUKS_KEYFILE" --key-slot 1 "\$_LUKS_DEVICE" luks-home 2>/dev/null || \
           cryptsetup luksOpen --key-file="\$_LUKS_KEYFILE" "\$_LUKS_DEVICE" luks-home 2>/dev/null; then
          log "Boot: LUKS opened by enforcer recovery"
          # Mount if not already mounted
          if ! mountpoint -q "\$SVC_HOME" 2>/dev/null; then
            mount -o nosuid,nodev /dev/mapper/luks-home "\$SVC_HOME" 2>/dev/null || true
          fi
          rm -f /run/ellul-luks-pending 2>/dev/null
          touch /run/ellul-decrypted 2>/dev/null
        else
          log "Boot: LUKS recovery failed — cryptsetup error"
        fi
      fi
    fi
    fi
  fi

  # Guard: on serverless tier with a separate volume, the vault lives ON the volume.
  # If the volume isn't mounted yet (wake-mount handles that), the root FS may have
  # no vault or a stale skeleton. Only proceed if:
  # 1. The vault .initialized marker exists, AND
  # 2. Bind mounts are missing, AND
  # 3. The vault has actual content (etc/ellul dir exists — not an empty skeleton)
  # Vault bind mount verification — handles three failure modes:
  #   1. Mounts missing entirely (mountpoint returns false)
  #   2. Mounts stale — fstab nofail + systemd ordering race causes bind mounts
  #      to activate BEFORE LUKS opens, binding an empty source directory.
  #      mountpoint(1) returns true but files are missing.
  #   3. Partial mount — some bind mounts active, others not
  # Fix: verify CONTENT (critical files exist), not just mount status.
  if [ -f "\$_VAULT/.initialized" ] && [ -d "\$_VAULT/etc/ellul" ]; then
    local _needs_remount=false

    # Check ALL critical bind mounts, not just /etc/ellul.
    # After block migration or partial boot, some mounts may succeed while
    # others fail (vault source dir missing, nofail swallows the error).
    # A partial mount state causes subtle failures: shield-data works but
    # secrets writes fail (/var/lib/ellul-shielded not mounted), or
    # logs go to root FS instead of vault.
    local _missing_mounts=""
    for _check_mp in /etc/ellul /var/lib/ellul-shielded /etc/caddy /opt/ellul; do
      if [ -d "\$_VAULT\$_check_mp" ] && ! mountpoint -q "\$_check_mp" 2>/dev/null; then
        _missing_mounts="\$_missing_mounts \$_check_mp"
      fi
    done

    if [ -n "\$_missing_mounts" ]; then
      _needs_remount=true
      log "Boot: vault bind mounts missing:\$_missing_mounts"
      # Unmount ALL before re-binding (prevent mount stacking from partial state)
      for _mp in /etc/ellul /etc/caddy /etc/iptables /var/lib/ellul-shielded /var/lib/postgresql /var/log/ellul /var/log/caddy /opt/ellul; do
        mountpoint -q "\$_mp" 2>/dev/null && umount "\$_mp" 2>/dev/null || true
      done
    elif [ -d "\$_VAULT/etc/ellul/shield-data" ] && [ ! -s /etc/ellul/shield-data/local-auth.db ]; then
      # Stale mount: mountpoint says yes, but content is empty/wrong
      _needs_remount=true
      log "Boot: vault bind mounts stale (empty source at mount time — systemd nofail race)"
      for _mp in /etc/ellul /etc/caddy /etc/iptables /var/lib/ellul-shielded /var/lib/postgresql /var/log/ellul /var/log/caddy /opt/ellul; do
        mountpoint -q "\$_mp" 2>/dev/null && umount "\$_mp" 2>/dev/null || true
      done
    fi

    if [ "\$_needs_remount" = "true" ]; then
      # Restore UID/GID map (users may differ after resize/cloud-init re-run)
      if [ -f "\$_VAULT/.gid-map" ]; then
        while IFS=: read -r _type _name _id; do
          case "\$_type" in
            g) getent group "\$_name" >/dev/null 2>&1 || groupadd --gid "\$_id" "\$_name" 2>/dev/null || groupadd --system --gid "\$_id" "\$_name" 2>/dev/null || true ;;
            u) id -u "\$_name" >/dev/null 2>&1 || useradd --system --uid "\$_id" --no-create-home --shell /usr/sbin/nologin "\$_name" 2>/dev/null || true ;;
          esac
        done < "\$_VAULT/.gid-map"
      fi

      # Stop services that may be running with stale/empty config
      systemctl stop ellul-agent-bridge ellul-file-api ellul-sovereign-shield caddy postgresql 2>/dev/null || true

      # Mount vault using shared helper
      bind_mount_vault "\$_VAULT" "boot"
      fix_vault_ownership "boot" "\$SVC_USER"
      systemctl daemon-reload 2>/dev/null || true

      # Restore iptables from vault
      [ -f /etc/iptables/rules.v4 ] && [ -s /etc/iptables/rules.v4 ] && \
        iptables-restore < /etc/iptables/rules.v4 2>/dev/null || true

      # Start services with correct vault config (force restart — services may
      # hold stale file descriptors from before the bind mount)
      start_services_idempotent "boot" "vault restored" "force_restart"
      log "Boot: vault bind mounts restored — all services operational"
    else
      log "Boot: vault bind mounts verified — content correct"

      # Identity change: update-identity writes this marker when the enforcer
      # should force-restart all services on its next boot. Services cache
      # domain/server-id at startup — they must be restarted to pick up changes.
      if [ -f /run/ellul-identity-changed ]; then
        rm -f /run/ellul-identity-changed
        log "Boot: identity changed — force-restarting all services"
        start_services_idempotent "boot" "identity changed" "force_restart"
      else
        # Even with correct mounts, services may have started BEFORE the bind
        # mounts were set up (systemd fstab ordering race). Detect and restart
        # any service whose PID predates the vault mount.
        local _mount_time=\$(stat -c %Y /etc/ellul-bootstrap/heartbeat.key.json 2>/dev/null || echo 0)
        if [ "\$_mount_time" -gt 0 ]; then
          for _svc in caddy ellul-sovereign-shield ellul-file-api ellul-agent-bridge; do
            if systemctl is-active --quiet "\$_svc" 2>/dev/null; then
              local _svc_pid=\$(systemctl show -p MainPID "\$_svc" 2>/dev/null | cut -d= -f2)
              if [ -n "\$_svc_pid" ] && [ "\$_svc_pid" -gt 0 ] && [ -d "/proc/\$_svc_pid" ]; then
                local _svc_start=\$(stat -c %Y /proc/\$_svc_pid 2>/dev/null || echo 0)
                if [ "\$_svc_start" -gt 0 ] && [ "\$_svc_start" -lt "\$_mount_time" ]; then
                  log "Boot: \$_svc started before vault mount (\$_svc_start < \$_mount_time) — restarting"
                  systemctl restart "\$_svc" 2>/dev/null || true
                fi
              fi
            fi
          done
        fi
      fi
    fi
  fi

  local HEARTBEAT_COUNT=0
  local SERVICE_CHECK_COUNT=0
  local CONSECUTIVE_FAILURES=0
  local BURST_COUNT=0

  # Persistent ping cadence override. Servers push a new value via the
  # /agent-ping response body and agent_ping writes it here so it
  # survives a restart. Honoured only when sane.
  if [ -f "\$AGENT_PING_TICK_FILE" ]; then
    local _saved_tick
    _saved_tick=\$(tr -d '\\n' < "\$AGENT_PING_TICK_FILE" 2>/dev/null | head -c 8)
    if [[ "\$_saved_tick" =~ ^[0-9]+\$ ]] && [ "\$_saved_tick" -ge 1 ] && [ "\$_saved_tick" -le 360 ]; then
      PING_INTERVAL_TICKS=\$_saved_tick
    fi
  fi

  # Signal systemd that startup is complete (Type=notify)
  systemd-notify --ready 2>/dev/null || true
  log "Daemon ready — systemd notified, watchdog active"

  while true; do
    # Pet watchdog if configured (no-op when WatchdogSec is not set)
    systemd-notify WATCHDOG=1 2>/dev/null || true

    # ── NAMESPACE IPTABLES SELF-HEAL ──
    # Re-assert namespace veth allow rules every tick. Warden or another
    # process may re-insert its OUTPUT DROP for 10.0.0.0/8 at any time,
    # which would push our allow rule down. Running on every heartbeat
    # keeps the allow rule at the top of the chain regardless of who else
    # touches iptables. Idempotent — already-present rules are a no-op.
    ensure_namespace_iptables_rules 2>/dev/null || true

    # ── WORKER CHECK: report results from background command workers ──
    # Heavy commands (block-migrate-upload/download, wake-mount) run as
    # isolated subprocesses. Check for completed/failed/timed-out workers
    # BEFORE the heartbeat so the API sees command results immediately.
    report_worker_results 2>/dev/null || true

    if heartbeat_raw 2>/dev/null; then
      # Heartbeat succeeded - reset failure counter
      if [ "\$CONSECUTIVE_FAILURES" -gt 0 ]; then
        CONSECUTIVE_FAILURES=0
        reset_failure_count
      fi
      # First successful heartbeat after a self-update commits the
      # pending-commit marker, proving the new binary is viable.
      agent_sync_commit_pending
    else
      # Heartbeat failed — log only, no lockdown
      CONSECUTIVE_FAILURES=\$((CONSECUTIVE_FAILURES + 1))
      save_failure_count "\$CONSECUTIVE_FAILURES"
      log "WARN: Heartbeat failed (\$CONSECUTIVE_FAILURES consecutive failures)"
    fi

    # ── LIVENESS PING ──
    # Unconditional liveness beacon on a fixed cadence. Independent of
    # the manifest sync loop — fires whether or not sync_agent_bundle
    # did any work, so the dashboard has a "last seen" timestamp for
    # every VPS regardless of fleet activity. Forces one attempt on
    # each boot (/run marker absent) to light the UI up immediately
    # after a restart rather than waiting N ticks.
    HEARTBEAT_COUNT=\$((HEARTBEAT_COUNT + 1))
    if [ ! -f "\$AGENT_PING_BOOT_MARKER" ] || [ \$((HEARTBEAT_COUNT % PING_INTERVAL_TICKS)) -eq 0 ]; then
      agent_ping 2>/dev/null || true
    fi

    SERVICE_CHECK_COUNT=$((SERVICE_CHECK_COUNT + 1))
    if [ $SERVICE_CHECK_COUNT -ge 2 ]; then
      check_critical_services
      SERVICE_CHECK_COUNT=0
    fi

    # ── COMMAND-BURST MODE ──
    # If the last heartbeat processed commands (e.g., migrate-download completed),
    # skip the 30s sleep and poll again immediately. This ensures follow-up commands
    # (e.g., update-identity after migrate-download) are picked up with zero latency
    # instead of waiting for the next poll cycle.
    # Cap at 10 consecutive bursts to prevent infinite loops on pathological command streams.
    if [ "\${COMMANDS_PROCESSED:-false}" = "true" ]; then
      BURST_COUNT=\$((BURST_COUNT + 1))
      if [ \$BURST_COUNT -lt 10 ]; then
        log "Command burst: re-polling immediately (burst \$BURST_COUNT)"
        continue
      else
        log "Command burst: cap reached (10), resuming normal interval"
        BURST_COUNT=0
      fi
    else
      BURST_COUNT=0
    fi

    # ── DEFERRED ENFORCER RESTART ──
    # update-identity sets _DEFERRED_ENFORCER_RESTART=1 because restarting mid-command
    # would kill the process before completion reports are sent. The restart is deferred
    # until ALL commands are processed AND burst mode has ended (no more pending commands).
    # This ensures read-public-key (queued right after update-identity) completes first.
    if [ "\${_DEFERRED_ENFORCER_RESTART:-0}" = "1" ]; then
      _DEFERRED_ENFORCER_RESTART=0
      log "update-identity: executing deferred enforcer restart (all commands + bursts completed)"
      (sleep 2 && systemctl restart ellul-enforcer) &>/dev/null &
      disown
      log "update-identity: enforcer restart scheduled (2s)"
    fi

    # Interruptible sleep: SIGUSR1 interrupts wait immediately (zero latency)
    WAKEUP=0
    sleep \$HEARTBEAT_INTERVAL &
    SLEEP_PID=\$!
    wait \$SLEEP_PID 2>/dev/null
    if [ \$WAKEUP -eq 1 ]; then
      kill \$SLEEP_PID 2>/dev/null
      wait \$SLEEP_PID 2>/dev/null
      log "Push trigger received — running immediate heartbeat"
    fi
  done
}

# ============================================
# CLI Handler
# ============================================

case "\$1" in
  heartbeat) heartbeat ;;
  daemon) run_daemon ;;
  --self-test)
    # Called by apply_self_update before the symlink flip to validate
    # that the staged binary can actually run the sync loop. Exit codes
    # 10-21 map to specific failure points so operators can see what
    # the new binary didn't like. See agent-sync.sh run_self_test().
    run_self_test
    exit \$?
    ;;
  --test-chain)
    # Run the agent_sync_chain_check truth table standalone. Useful for
    # CI to assert the bootstrap path stays open and the post-bootstrap
    # monotonicity rules don't regress, without needing a full vault or
    # the rest of run_self_test's environmental requirements. Prints any
    # failures to stderr and exits non-zero on regression.
    run_chain_check_tests
    exit \$?
    ;;
  --introspect)
    # Prints JSON with version + capabilities + signing key fingerprint.
    # Useful for ops, compatibility checks, and diffing what's deployed.
    run_introspect
    exit 0
    ;;
  sessions) get_active_sessions ;;
  apps) get_deployed_apps ;;
  status)
    echo ""
    echo -e "\\033[32mellul Status\\033[0m"
    echo ""
    echo "  Terminal Sessions:"
    for name in main opencode claude codex cursor git branch save ship undo logs clean; do
      if svc_is_active "ttyd@\$name"; then
        echo -e "    \\033[32m*\\033[0m \$name"
      else
        echo -e "    \\033[90mo\\033[0m \$name"
      fi
    done
    echo ""
    echo "  Deployed Apps:"
    APPS_DIR="\${SVC_HOME}/.ellul/apps"
    if ls "\$APPS_DIR"/*.json &>/dev/null; then
      for f in "\$APPS_DIR"/*.json; do
        [ -f "\$f" ] || continue
        APP_NAME=$(jq -r '.name' "\$f")
        APP_URL=$(jq -r '.url' "\$f")
        APP_PORT=$(jq -r '.port' "\$f")
        echo -e "    \\033[32m*\\033[0m \$APP_NAME (:\$APP_PORT) -> \$APP_URL"
      done
    else
      echo -e "    \\033[90mo\\033[0m (none deployed)"
    fi
    echo ""
    echo "  CPU Usage: $(get_cpu_usage)%"
    echo "  RAM Usage: $(get_ram_usage)%"
    echo -n "  SSH: "; fw_is_allowed 22 && echo "OPEN" || echo "CLOSED"
    echo ""
    ;;
  kill)
    SESSION="\$2"
    if [ -z "\$SESSION" ]; then
      echo "Usage: ellul-env kill <session>"
      exit 1
    fi
    log "Manually stopping session: \$SESSION"
    svc_stop "ttyd@\$SESSION"
    echo "Stopped: \$SESSION"
    ;;
  *) echo "Usage: ellul-env {sync|heartbeat|daemon|sessions|apps|status|kill <session>}" ;;
esac
`;
}

/**
 * Generate the complete VPS enforcer script.
 *
 * @param apiUrl - The ellul API URL for heartbeat/sync calls
 */
export function getEnforcerScript(apiUrl: string): string {
  // Check cache
  if (cachedScript && cachedApiUrl === apiUrl) {
    return cachedScript;
  }

  // Assemble script from modular components
  cachedScript = assembleScript(apiUrl);
  cachedApiUrl = apiUrl;
  return cachedScript;
}

/**
 * Get the systemd service file content.
 *
 * @param aiProxyToken - The server's AI proxy token for authentication
 */
export function getEnforcerService(_aiProxyToken?: string, _heapCapMb?: number | null): string {
  // `_heapCapMb` is reserved for symmetry with the other Node services.
  // The enforcer itself runs as a shell daemon (ellul-env daemon), but
  // any Node subprocesses it spawns inherit NODE_OPTIONS from the
  // heap-caps env file declared below. The argument is accepted so the
  // payload orchestrator can pass profile.heapCaps.enforcer uniformly.
  void _heapCapMb;
  return `[Unit]
Description=ellul State Enforcer
After=network-online.target local-fs.target ellul-luks-boot.service
Wants=network-online.target ellul-luks-boot.service
# NOTE: RequiresMountsFor intentionally omitted. The enforcer is the PRIMARY
# owner of vault bind mounts — it must start WITHOUT them and create them itself.
# If we required the mounts, the enforcer can't self-heal when systemd's fstab
# generator fails (Hetzner resize, cloud-init re-run, etc.).

[Service]
Type=notify
Slice=ellul-control-plane.slice
ExecStart=/usr/local/bin/ellul-env daemon
ExecReload=/bin/kill -USR1 $MAINPID
PIDFile=/run/ellul-enforcer.pid
Restart=always
RestartSec=5
# No WatchdogSec — block-migrate runs inline for 30-60 min (LUKS teardown
# requires same-process execution). Progress heartbeats + API-side stale
# recovery cron provide the self-healing instead.
# Allow 5 minutes for boot (vault mount, LUKS recovery, etc.)
TimeoutStartSec=300
NotifyAccess=all
User=root
EnvironmentFile=-/etc/default/ellul
EnvironmentFile=-/etc/default/ellul-secrets
# Dynamic NODE_OPTIONS for any node subprocesses the enforcer spawns.
# Optional (leading dash) so fresh installs before the memory tuner
# runs don't fail service start.
EnvironmentFile=-/etc/ellul/heap-caps/enforcer.env
StandardOutput=append:/var/log/ellul-enforcer.log
StandardError=append:/var/log/ellul-enforcer.log

# Security hardening (root required for systemd/service management)
# NOTE: ProtectHome removed — enforcer must write to $SVC_HOME volume
# during migration (migrate-download extracts to home dir). ProtectHome=read-only
# makes nested volume mounts (e.g. /home/dev on /dev/sdb) read-only,
# and ReadWritePaths=/home only remounts the root FS, not the volume.
# NoNewPrivileges intentionally NOT set — enforcer uses sudo -u postgres for
# PostgreSQL management (pg_isready, pg_resetwal, psql). NoNewPrivileges blocks
# the SUID bit that sudo requires. The enforcer runs as root with restricted
# syscalls and network families instead.
# PrivateTmp intentionally REMOVED — it creates an isolated mount namespace,
# making mounts (LUKS, vault bind mounts) invisible to other services.
# The enforcer runs as root with syscall filters; PrivateTmp added no
# meaningful security for a root process.
LimitCORE=0
LogsDirectoryMode=0700
UMask=0077
# PrivateDevices intentionally NOT set — enforcer manages vault bind mounts
# which require access to block devices (/dev/disk/by-id/scsi-0HC_Volume_*).
ProtectClock=true
ProtectHostname=true
ProtectKernelLogs=true
# Restrict to system-service syscalls + network I/O + mount (for vault bind mounts)
SystemCallFilter=@system-service @mount @setuid
SystemCallErrorNumber=EPERM
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
# Control plane — survive any OOM. The enforcer is what restarts other
# services when they die; if it gets killed, recovery stops working.
OOMScoreAdjust=-1000

[Install]
WantedBy=multi-user.target`;
}

/**
 * Get the launchd plist for macOS BYOS deployments.
 *
 * @param aiProxyToken - The server's AI proxy token for authentication
 */
export function getEnforcerLaunchdPlist(aiProxyToken: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.ellul.enforcer</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/ellul-env</string>
        <string>daemon</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>EnvironmentVariables</key>
    <dict>
        <key>ELLUL_AI_TOKEN</key>
        <string>${aiProxyToken}</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>StandardOutPath</key>
    <string>/var/log/ellul-enforcer.log</string>
    <key>StandardErrorPath</key>
    <string>/var/log/ellul-enforcer.log</string>
</dict>
</plist>`;
}

/**
 * Invalidate the script cache (useful for development).
 */
export function invalidateScriptCache(): void {
  cachedScript = null;
  cachedApiUrl = null;
}
