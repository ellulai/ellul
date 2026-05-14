// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/** install-warden.sh — Creates warden user, systemd unit, Hotel California iptables */
export declare const installWardenSh: string;
/** install-ca.sh — Generates self-signed root CA for Warden MITM */
export declare const installCaSh: string;
/** warden-iptables.sh — Hotel California iptables for free tier (all traffic through Warden) */
export declare const wardenIptablesSh: string;
/** warden-iptables-dev.sh — Tunnel Guard iptables for paid dev tiers */
export declare const wardenIptablesDevSh: string;
/** install-shims.sh — Command shims (git push, ssh, deploy CLIs) for free tier */
export declare const installShimsSh: string;
/** install-common-repos.sh — Pre-installs GitHub CLI, Docker, PostgreSQL repos */
export declare const installCommonReposSh: string;
/** rules.yaml — Hotel California rules for free tier Warden */
export declare const rulesYaml: string;
/** rules-dev.yaml — Tunnel Guard rules for paid dev tier Warden */
export declare const rulesDevYaml: string;
/** Generate bash commands to write warden Go source and build from source */
export declare function generateWardenBuildFromSource(): string;
/** Generate bash commands to write guardrail Go source and build from source (CGO_ENABLED=1) */
export declare function generateGuardrailBuildFromSource(): string;
