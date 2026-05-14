// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

/**
 * AppArmor profile for /usr/bin/bwrap.
 *
 * Ubuntu 24.04+ defaults `kernel.apparmor_restrict_unprivileged_userns=1`.
 * When an unconfined process creates an unprivileged user namespace,
 * AppArmor transitions it into the system `unprivileged_userns` profile
 * which denies `capability` — including the CAP_SETUID inside the userns
 * that bubblewrap needs to set up its uid map. Without this profile,
 * bwrap fails with "setting up uid map: Permission denied" inside the
 * agent namespace, and the codex App Server (which uses bwrap to
 * sandbox shell tool calls) traps out with exit code 133 (SIGTRAP).
 *
 * Single-verb policy (`userns,`) keeps bwrap otherwise unconfined while
 * granting it the userns capability the kernel restricts. Capabilities
 * gained inside the userns are still scoped to that userns by kernel
 * invariant, so the host security boundary is unchanged. Same pattern
 * Ubuntu ships for chrome / firefox / etc. in the default policy set.
 *
 * Installed by the enforcer's agent-sync.sh ensure_bin_symlink core-
 * runtime branch via `apparmor_parser -r`. Originally part of the API
 * provisioning kernel-hardening.sh; lifted into core-runtime so fixes
 * to the policy flow through the manifest pipeline alongside the codex
 * adapter that depends on it.
 */
const PROFILE = `# Managed by ellul — do not edit by hand.
# Permits bubblewrap to create unprivileged user namespaces and
# configure their uid map. Required for codex / claude-code / opencode
# / cursor read-only sandboxes under Ubuntu's
# apparmor_restrict_unprivileged_userns=1 default.
#
# Single verb (\`userns,\`) — bwrap remains otherwise unconfined;
# capabilities gained inside its userns are scoped to that userns by
# kernel invariant. All other binaries on the host still hit the
# restrictive default profile.
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}

# Some distros ship a setuid wrapper at this path (e.g. older Debian /
# rebuilt-with-suid bwrap). Cover it too — same one-verb policy.
profile bwrap-suid /usr/bin/bwrap-userns-restrict flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
`;

export function getBwrapApparmorProfile(): string {
  return PROFILE;
}
