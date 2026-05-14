// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Network Namespace Helper Script
 *
 * Privileged helper deployed to /usr/local/bin/ellul-netns-helper.
 * Called via sudo by sovereign-shield to create/manage network + mount
 * namespaces for shielded app deployments.
 *
 * Actions:
 *   create <ns-name> <port>       — Create namespace + veth pair
 *   apply-whitelist <ns-name>     — Read allowed destinations from stdin (JSON), apply nftables
 *   exec <ns-name>                — Read config from stdin (JSON), exec process in namespace
 *   destroy <ns-name>             — Kill processes, clean up namespace + veth
 *   status <ns-name>              — Return JSON status
 */

import skeleton from '@vps/templates/helpers/netns/netns.sh';
import { ipCalculatorBlock } from './ip-calculator';
import { forwardingSetupBlock } from './iptables';
import { createBlock, execBlock, destroyBlock, statusBlock } from './lifecycle';
import { whitelistBlock } from './whitelist';

export function getNetnsHelperScript(): string {
  return skeleton
    .replace('__IP_CALCULATOR__', () => ipCalculatorBlock().trim())
    .replace('__FORWARDING_SETUP__', () => forwardingSetupBlock().trim())
    .replace('__CREATE__', () => createBlock().trim())
    .replace('__WHITELIST__', () => whitelistBlock().trim())
    .replace('__EXEC__', () => execBlock().trim())
    .replace('__DESTROY__', () => destroyBlock().trim())
    .replace('__STATUS__', () => statusBlock().trim());
}
