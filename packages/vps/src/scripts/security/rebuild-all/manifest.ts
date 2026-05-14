// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * manifest.ts -- Build the file manifest (array of FileEntry) for all deployed files.
 */

// ─── Config generators ─────────────────────────────────────────────
import {
  getGlobalGitignore,
  getPreCommitHook,
  getPrePushHook,
  getGitCredentialHelper,
  getGitWrapper,
  getSshHardeningConfig,
  getFail2banConfig,
  getUnattendedUpgradesConfig,
  getAutoUpgradesConfig,
  getTmuxConfig,
  getStarshipConfig,
  getBashrcConfig,
  getMotdScript,
  getGlobalClaudeMd,
  getProjectsClaudeMd,
} from '@vps/configs';

import { getOpencodeConfigJson } from '@vps/configs/ai';
import { getPreviewUnitsSudoers } from '@vps/configs';

// ─── Session scripts ────────────────────────────────────────────────
import {
  getSessionLauncherScript,
  getTtydWrapperScript,
  getTtydSystemdTemplate,
  getPtyWrapScript,
} from '../../sessions';

// ─── Security scripts ───────────────────────────────────────────────
import {
  getSetupSshKeyScript,
  getAddSshKeyScript,
  getShieldSshKeyMgrScript,
  getLockWebOnlyScript,
  getVerifyScript,
  getDecryptScript,
  getLazyAiInstallerScript,
  getLazyAiShimsScript,
  getScaffoldShimBody,
  SCAFFOLD_SHIM_NAMES,
  getUpdateAiToolsScript,
  getDeleteScript,
  getRebuildScript,
  getRollbackScript,
  getChangeTierScript,
  getSettingsScript,
  getDeploymentScript,
} from '../../security';

// ─── Workflow scripts ───────────────────────────────────────────────
import {
  getGitFlowScript,
  getExposeScript,
  getAppsScript,
  getInspectScript,
  getUndoScript,
  getCleanScript,
  getDoctorScript,
  getPerfMonitorScript,
  getPerfMonitorService,
  getServiceInstallerScript,
  getPreviewInstanceLauncher,
  getPreviewCtlScript,
  getPreviewTemplateUnit,
  getPreviewSliceUnit,
  getReconcilerServiceUnit,
  getReconcilerTimerUnit,
  getContextScript,
  getContextReadme,
  getAiFlowScript,
  getUserWorkloadSliceUnit,
  getControlPlaneSliceUnit,
  getSpawnScopeScript,
  getSpawnScopeSudoers,
  getRuntimeInstallerScript,
  type SliceMemoryVars,
} from '../../workflow';
import * as fs from 'fs';

// ─── Core scripts ───────────────────────────────────────────────────
import { getReportProgressScript, getTermProxyScript, getTermProxyService } from '../..';

// ─── Sovereign Gates helpers ────────────────────────────────────────
import { getNetnsHelperScript } from '../../helpers/netns';
import { getEnvShieldPreload } from '../../helpers/env-shield-preload';
import { getPgRecoveryScript, getPgRecoverySystemdDropin, getPgBackupScript, getPgBackupService, getPgBackupTimer, getPgEnsureScript } from '../../helpers/pg-recovery';
import { getFileIntegrityScript } from '../../helpers/security';

// ─── Service bundles ────────────────────────────────────────────────
import { getEnforcerService } from '@vps/services/daemons/enforcer/bundle';
import { getFileApiService } from '@vps/services/backends/file-api/bundle';
import { getAgentBridgeService, getAgentBridgeSocketUnit, getMcpRelayScript } from '@vps/services/backends/agent-bridge/bundle';
import { getWatchdogService, getWatchdogScript } from '@vps/services/daemons/watchdog';
import {
  getVpsAuthService,
  getDowngradeScript,
  getWebLockedSwitchScript,
  getResetAuthScript,
  getTierSwitchHelperScript,
} from '@vps/services/auth/sovereign-shield/bundle';

// ─── Local imports ──────────────────────────────────────────────────
import type { VpsConfig } from './config';
import { assembleEnforcerScript } from './enforcer';

// ─── Types ──────────────────────────────────────────────────────────

export interface FileEntry {
  path: string;
  content: string;
  mode?: number;
  owner?: string; // 'dev' for user-owned files, default is root
}

// ─── Manifest builder ───────────────────────────────────────────────

function readSliceVarsFromBudgetEnv(): SliceMemoryVars {
  const text = fs.readFileSync('/etc/ellul/memory-budget.env', 'utf8');
  const num = (key: string): number => {
    const m = text.match(new RegExp(`^${key}=(\\d+)`, 'm'));
    if (!m) throw new Error(`/etc/ellul/memory-budget.env missing ${key} — re-run memory-tuning`);
    return parseInt(m[1]!, 10);
  };
  return {
    workloadMaxMB: num('ELLUL_WORKLOAD_MAX_MB'),
    workloadHighMB: num('ELLUL_WORKLOAD_HIGH_MB'),
    previewBudgetMB: num('ELLUL_PREVIEW_BUDGET_MB'),
    previewHighMB: num('ELLUL_PREVIEW_HIGH_MB'),
    controlPlaneMaxMB: num('ELLUL_CONTROL_PLANE_MAX_MB'),
    controlPlaneHighMB: num('ELLUL_CONTROL_PLANE_HIGH_MB'),
  };
}

export async function buildManifest(config: VpsConfig): Promise<FileEntry[]> {
  const { serverId, domain, apiUrl, aiProxyToken, billingTier } = config;
  const svcUser = billingTier === "free" ? "coder" : "dev";
  const svcHome = `/home/${svcUser}`;
  const sliceVars = readSliceVarsFromBudgetEnv();
  const appZone = fs.readFileSync('/etc/ellul/app-zone', 'utf8').trim();

  return [
    // ── Config files ──────────────────────────────────────────────
    { path: `${svcHome}/.global_gitignore`, content: getGlobalGitignore(), mode: 0o644, owner: svcUser },
    { path: `${svcHome}/.ellul/hooks/pre-commit`, content: getPreCommitHook(), owner: svcUser },
    { path: `${svcHome}/.ellul/hooks/pre-push`, content: getPrePushHook(), owner: svcUser },
    { path: '/etc/ssh/sshd_config.d/ellul.conf', content: getSshHardeningConfig(), mode: 0o644 },
    // sshd OOM protection — kernel must NEVER pick sshd as an OOM victim.
    // If sshd dies under memory pressure, remote recovery is impossible.
    { path: '/etc/systemd/system/ssh.service.d/oom-protection.conf', content: '[Service]\nOOMScoreAdjust=-1000\n', mode: 0o644 },
    { path: '/etc/systemd/system/sshd.service.d/oom-protection.conf', content: '[Service]\nOOMScoreAdjust=-1000\n', mode: 0o644 },
    { path: '/etc/fail2ban/jail.d/ellul.conf', content: getFail2banConfig(), mode: 0o644 },
    { path: '/etc/apt/apt.conf.d/50unattended-upgrades', content: getUnattendedUpgradesConfig(), mode: 0o644 },
    { path: '/etc/apt/apt.conf.d/20auto-upgrades', content: getAutoUpgradesConfig(), mode: 0o644 },
    { path: `${svcHome}/.tmux.conf`, content: getTmuxConfig(), mode: 0o644, owner: svcUser },
    { path: `${svcHome}/.config/starship.toml`, content: getStarshipConfig(), mode: 0o644, owner: svcUser },
    { path: '/etc/profile.d/99-ellul-motd.sh', content: getMotdScript() },
    { path: '/etc/profile.d/99-lazy-ai-shims.sh', content: getLazyAiShimsScript(), mode: 0o644 },

    // ── Scaffold CLI shims — hard-block agent bypass of scaffold_project.
    // See packages/vps/src/scripts/security/scaffold-shims.ts for rationale.
    // One identical shim file per intercepted create-* name so enforcer's
    // file-based sync distributes cleanly to every existing sandbox.
    ...SCAFFOLD_SHIM_NAMES.map((name): FileEntry => ({
      path: `/usr/local/bin/${name}`,
      content: getScaffoldShimBody(),
      mode: 0o755,
    })),

    // ── Session scripts ───────────────────────────────────────────
    { path: '/usr/local/bin/ellul-launch', content: getSessionLauncherScript(svcUser) },
    { path: '/usr/local/bin/ellul-ttyd-wrapper', content: getTtydWrapperScript() },
    { path: '/usr/local/bin/pty-wrap', content: getPtyWrapScript() },

    // ── Security scripts ──────────────────────────────────────────
    { path: '/usr/local/bin/setup-ssh-key', content: getSetupSshKeyScript() },
    { path: '/usr/local/bin/ellul-add-key', content: getAddSshKeyScript() },
    { path: '/usr/local/bin/shield-ssh-key-mgr', content: getShieldSshKeyMgrScript(), mode: 0o755 },
    { path: '/etc/sudoers.d/ellul-shield-ssh', content: 'shield-runner ALL=(root) NOPASSWD: /usr/local/bin/shield-ssh-key-mgr *\n', mode: 0o440 },
    { path: '/usr/local/bin/lock-web-only', content: getLockWebOnlyScript() },
    { path: '/usr/local/bin/ellul-verify', content: getVerifyScript() },
    { path: '/usr/local/bin/ellul-decrypt', content: getDecryptScript() },
    { path: '/usr/local/bin/install-lazy-ai.sh', content: getLazyAiInstallerScript() },
    { path: '/usr/local/bin/update-ai-tools', content: getUpdateAiToolsScript() },

    // ── Scripts needing apiUrl ─────────────────────────────────────
    { path: '/usr/local/bin/ellul-delete', content: getDeleteScript(apiUrl) },
    { path: '/usr/local/bin/ellul-rebuild', content: getRebuildScript(apiUrl) },
    { path: '/usr/local/bin/ellul-rollback', content: getRollbackScript(apiUrl) },
    { path: '/usr/local/bin/ellul-change-tier', content: getChangeTierScript(apiUrl) },
    { path: '/usr/local/bin/ellul-settings', content: getSettingsScript() },
    { path: '/usr/local/bin/ellul-deployment', content: getDeploymentScript(apiUrl) },
    { path: '/usr/local/bin/ellul-ai-flow', content: getAiFlowScript(apiUrl) },

    // ── Scripts needing apiUrl + aiProxyToken ──────────────────────
    { path: '/usr/local/bin/report-progress', content: getReportProgressScript(apiUrl, aiProxyToken) },

    // ── Workflow scripts ──────────────────────────────────────────
    { path: '/usr/local/bin/git-credential-ellul', content: getGitCredentialHelper() },
    { path: '/usr/local/bin/ellul-git', content: getGitWrapper() },
    { path: '/usr/local/bin/ellul-git-flow', content: getGitFlowScript() },
    { path: '/usr/local/bin/ellul-expose', content: getExposeScript() },
    { path: '/usr/local/bin/ellul-apps', content: getAppsScript() },
    { path: '/usr/local/bin/ellul-inspect', content: getInspectScript() },
    { path: '/usr/local/bin/ellul-undo', content: getUndoScript() },
    { path: '/usr/local/bin/ellul-clean', content: getCleanScript() },
    { path: '/usr/local/bin/ellul-ctx', content: getContextScript() },
    { path: '/usr/local/bin/ellul-mcp-relay', content: getMcpRelayScript(), mode: 0o755 },
    // Per-preview systemd template: the instance launcher + sudo wrapper + slice
    // replace the old ellul-preview singleton daemon. Each active preview runs
    // as an instance of ellul-preview@<escaped>.service.
    { path: '/usr/local/bin/ellul-install-runtime', content: getRuntimeInstallerScript(), mode: 0o755 },
    { path: '/etc/sudoers.d/ellul-runtime', content: `${svcUser} ALL=(root) NOPASSWD: /usr/local/bin/ellul-install-runtime *\n`, mode: 0o440 },
    { path: '/usr/local/bin/ellul-preview-instance', content: getPreviewInstanceLauncher(), mode: 0o755 },
    { path: '/usr/local/bin/ellul-preview-ctl', content: getPreviewCtlScript(), mode: 0o755 },
    { path: '/etc/sudoers.d/ellul-preview-units', content: getPreviewUnitsSudoers(svcUser), mode: 0o440 },
    { path: '/etc/systemd/system/ellul-preview@.service', content: getPreviewTemplateUnit(svcUser), mode: 0o644 },
    // resource-v2: ellul-user-workload.slice is the new aggregate parent. Every
    // user workload (previews, per-sandbox transients, Pro Claude slot scopes)
    // sits under it for accounting and ManagedOOM purposes. The previews slice
    // is renamed (was /etc/systemd/system/ellul-previews.slice) so systemd's
    // name-is-hierarchy rule re-parents it correctly.
    // Spec: docs/v2/architecture/resource-v2/02-cgroup-topology.md
    { path: '/etc/systemd/system/ellul-control-plane.slice', content: getControlPlaneSliceUnit(sliceVars), mode: 0o644 },
    { path: '/etc/systemd/system/ellul-user-workload.slice', content: getUserWorkloadSliceUnit(sliceVars), mode: 0o644 },
    { path: '/etc/systemd/system/ellul-user-workload-previews.slice', content: getPreviewSliceUnit(sliceVars), mode: 0o644 },
    // resource-v2: validating wrapper for `systemd-run --scope`. Single
    // sudoers entry; in-script allowlist for slice/unit/property names.
    // Spec: docs/v2/architecture/resource-v2/03-spawn-routing.md
    { path: '/usr/local/bin/ellul-spawn-scope', content: getSpawnScopeScript(), mode: 0o755 },
    { path: '/etc/sudoers.d/ellul-spawn-scope', content: getSpawnScopeSudoers(svcUser), mode: 0o440 },
    // Boot-durable reconciliation: timer fires every 5 min and POSTs
    // /api/preview/reconcile. Independent of file-api's in-process
    // tick, so failed-unit GC + idle eviction survive bridge restarts.
    { path: '/etc/systemd/system/ellul-preview-reconciler.service', content: getReconcilerServiceUnit(), mode: 0o644 },
    { path: '/etc/systemd/system/ellul-preview-reconciler.timer', content: getReconcilerTimerUnit(), mode: 0o644 },
    { path: '/usr/local/bin/ellul-install', content: getServiceInstallerScript() },
    { path: '/usr/local/bin/ellul-doctor', content: getDoctorScript() },
    { path: '/usr/local/bin/ellul-perf-monitor', content: getPerfMonitorScript() },
    { path: '/usr/local/bin/ellul-term-proxy', content: getTermProxyScript() },

    // ── Sovereign Shield helper scripts ───────────────────────────
    { path: '/usr/local/bin/ellul-downgrade', content: getDowngradeScript() },
    { path: '/usr/local/bin/ellul-web-locked', content: getWebLockedSwitchScript() },
    { path: '/usr/local/bin/ellul-reset-auth', content: getResetAuthScript() },
    { path: '/usr/local/bin/ellul-tier-switch', content: getTierSwitchHelperScript() },

    // ── Sovereign Gates -- namespace helper + env shield ──────────
    { path: '/usr/local/bin/ellul-netns-helper', content: getNetnsHelperScript() },
    { path: '/usr/local/lib/ellul/env-shield-preload.cjs', content: getEnvShieldPreload(), mode: 0o644 },

    // ── PostgreSQL WAL recovery + automated backups ────────────
    { path: '/usr/local/bin/ellul-pg-recovery', content: getPgRecoveryScript(), mode: 0o700 },
    { path: '/usr/local/bin/shield-pg-ensure', content: getPgEnsureScript(), mode: 0o755 },
    { path: '/usr/local/bin/ellul-pg-backup', content: getPgBackupScript(), mode: 0o700 },
    { path: '/usr/local/bin/ellul-file-integrity', content: getFileIntegrityScript(), mode: 0o700 },
    { path: '/etc/systemd/system/postgresql@.service.d/ellul-recovery.conf', content: getPgRecoverySystemdDropin(), mode: 0o644 },
    { path: '/etc/systemd/system/ellul-pg-backup.service', content: getPgBackupService(), mode: 0o644 },
    { path: '/etc/systemd/system/ellul-pg-backup.timer', content: getPgBackupTimer(), mode: 0o644 },

    // ── Enforcer (assembled from .sh modules) ─────────────────────
    { path: '/usr/local/bin/ellul-env', content: assembleEnforcerScript(apiUrl, svcHome) },

    // ── Systemd service files ─────────────────────────────────────
    { path: '/etc/systemd/system/ttyd@.service', content: getTtydSystemdTemplate(svcUser), mode: 0o644 },
    { path: '/etc/systemd/system/ellul-enforcer.service', content: getEnforcerService(aiProxyToken), mode: 0o644 },
    { path: '/etc/systemd/system/ellul-file-api.service', content: getFileApiService(svcUser), mode: 0o644 },
    { path: '/etc/systemd/system/ellul-agent-bridge.service', content: getAgentBridgeService(svcUser), mode: 0o644 },
    { path: '/etc/systemd/system/ellul-agent-bridge.socket', content: getAgentBridgeSocketUnit(), mode: 0o644 },
    { path: '/etc/systemd/system/ellul-term-proxy.service', content: getTermProxyService(svcUser), mode: 0o644 },
    { path: '/etc/systemd/system/ellul-sovereign-shield.service', content: getVpsAuthService(), mode: 0o644 },
    { path: '/etc/systemd/system/ellul-perf-monitor.service', content: getPerfMonitorService(apiUrl, aiProxyToken), mode: 0o644 },
    { path: '/etc/systemd/system/ellul-watchdog.service', content: getWatchdogService(), mode: 0o644 },
    { path: '/opt/ellul/src/services/daemons/watchdog/server.cjs', content: getWatchdogScript(), mode: 0o644, owner: svcUser },

    // ── User config files ─────────────────────────────────────────
    { path: `${svcHome}/.bashrc`, content: getBashrcConfig(aiProxyToken), mode: 0o644, owner: svcUser },
    { path: `${svcHome}/.config/opencode/config.json`, content: await getOpencodeConfigJson(), mode: 0o644, owner: svcUser },
    { path: `${svcHome}/.ellul/context/README.md`, content: getContextReadme(), mode: 0o644, owner: svcUser },

    // ── Docs files ────────────────────────────────────────────────
    { path: `${svcHome}/CLAUDE.md`, content: getGlobalClaudeMd(domain, billingTier, svcHome, appZone), mode: 0o644, owner: svcUser },
    { path: `${svcHome}/projects/CLAUDE.md`, content: getProjectsClaudeMd(billingTier, domain, appZone), mode: 0o644, owner: svcUser },
  ];
}
