// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Ironclad Scripts — Shell scripts and configs exported as strings.
 *
 * These are the actual .sh and .yaml files from the ironclad package,
 * inlined at build time by tsup's text loader. No duplication — the
 * source of truth is always the .sh/.yaml file.
 */

// Packer provisioner scripts
import installWardenSh from "../packer/scripts/install-warden.sh";
import installCaSh from "../packer/scripts/install-ca.sh";
import wardenIptablesDevSh from "../packer/scripts/warden-iptables-dev.sh";
import wardenIptablesSh from "../packer/scripts/warden-iptables.sh";
import installShimsSh from "../packer/scripts/install-shims.sh";
import installCommonReposSh from "../packer/scripts/install-common-repos.sh";

// Warden rule configs
import rulesYaml from "../warden/configs/rules.yaml";
import rulesDevYaml from "../warden/configs/rules-dev.yaml";

export {
  installWardenSh,
  installCaSh,
  wardenIptablesSh,
  wardenIptablesDevSh,
  installShimsSh,
  installCommonReposSh,
  rulesYaml,
  rulesDevYaml,
};
