// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Host-side network setup: IP calculation, veth creation, iptables rules.
 * Used by both setup and spawn blocks.
 */

import networkSetupContent from '@vps/shell/helpers/agent-namespace/network-setup.sh';
import networkTeardownContent from '@vps/shell/helpers/agent-namespace/network-teardown.sh';
import previewDnatTemplate from '@vps/templates/helpers/agent-namespace/preview-dnat.sh';
import cleanupScriptTemplate from '@vps/templates/helpers/agent-namespace/cleanup-script.sh';

/**
 * Veth creation, IP assignment, iptables rules.
 * Expects $PROJECT, $IPTABLES, $IP to be set.
 * Sets: NS_IP, HOST_IP, NS_SHORT, VETH_HOST, VETH_NS, NS_NETNS
 */
export function networkSetupBlock(): string {
  return networkSetupContent;
}

/**
 * Preview DNAT rules + NS-side network config.
 * Must be called after networkSetupBlock().
 * @param previewArrayVar - bash array variable name holding preview ports (e.g. "SETUP_PREVIEW_PORTS" or "SPAWN_PREVIEW_PORTS")
 */
export function previewDnatAndNsConfig(previewArrayVar: string): string {
  return previewDnatTemplate.split('__PREVIEW_ARRAY_VAR__').join(previewArrayVar);
}

/**
 * Cleanup script generation (written to /run/.ns-$PROJECT/ns-cleanup.sh).
 * @param previewArrayVar - bash array variable name holding preview ports
 */
export function cleanupScriptBlock(previewArrayVar: string): string {
  return cleanupScriptTemplate.split('__PREVIEW_ARRAY_VAR__').join(previewArrayVar);
}

/**
 * Network teardown: veth/netns deletion (used by teardown case).
 */
export function networkTeardownBlock(): string {
  return networkTeardownContent;
}
