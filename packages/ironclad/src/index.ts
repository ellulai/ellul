// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * @ellul.ai/ironclad — Security components for VPS provisioning.
 *
 * Exports the actual shell scripts and YAML configs used by Packer
 * golden image builds. The API imports these to embed in fallback
 * provisioning payloads, ensuring a single source of truth.
 */
export {
  installWardenSh,
  installCaSh,
  wardenIptablesSh,
  wardenIptablesDevSh,
  installShimsSh,
  installCommonReposSh,
  rulesYaml,
  rulesDevYaml,
} from "./scripts";

export { generateWardenBuildFromSource } from "./warden-source";
export { generateGuardrailBuildFromSource } from "./guardrail-source";
