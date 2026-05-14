// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

/**
 * ellul-namespaced — privileged daemon binary source bundle.
 *
 * Returns the multi-file C source plus build instructions for the
 * provisioning shell to compile the daemon on the VPS.
 *
 * The daemon is disabled by default behind /etc/ellul/feature-flags/nsd-enabled
 * — provisioning ships the binary but does not start it. Operators enable
 * per-host after manifest material is in place. See
 * packages/vps/docs/ELLUL-NAMESPACED-ROLLBACK.md.
 */

import mainC from '@vps/shell/helpers/ellul-namespaced/main.c';
import daemonH from '@vps/shell/helpers/ellul-namespaced/daemon.h';
import logH from '@vps/shell/helpers/ellul-namespaced/log.h';
import logC from '@vps/shell/helpers/ellul-namespaced/log.c';
import cborH from '@vps/shell/helpers/ellul-namespaced/cbor_io.h';
import cborC from '@vps/shell/helpers/ellul-namespaced/cbor_io.c';
import hmacH from '@vps/shell/helpers/ellul-namespaced/hmac_session.h';
import hmacC from '@vps/shell/helpers/ellul-namespaced/hmac_session.c';
import manifestH from '@vps/shell/helpers/ellul-namespaced/manifest.h';
import manifestC from '@vps/shell/helpers/ellul-namespaced/manifest.c';
import mountinfoH from '@vps/shell/helpers/ellul-namespaced/mountinfo.h';
import mountinfoC from '@vps/shell/helpers/ellul-namespaced/mountinfo.c';
import authH from '@vps/shell/helpers/ellul-namespaced/auth.h';
import authC from '@vps/shell/helpers/ellul-namespaced/auth.c';
import sockH from '@vps/shell/helpers/ellul-namespaced/sock_listen.h';
import sockC from '@vps/shell/helpers/ellul-namespaced/sock_listen.c';
import attestH from '@vps/shell/helpers/ellul-namespaced/attest.h';
import attestC from '@vps/shell/helpers/ellul-namespaced/attest.c';
import dispatchH from '@vps/shell/helpers/ellul-namespaced/dispatch.h';
import dispatchC from '@vps/shell/helpers/ellul-namespaced/dispatch.c';
import seccompH from '@vps/shell/helpers/ellul-namespaced/daemon_seccomp.h';
import seccompC from '@vps/shell/helpers/ellul-namespaced/daemon_seccomp.c';
import opsH from '@vps/shell/helpers/ellul-namespaced/ops.h';
import opsC from '@vps/shell/helpers/ellul-namespaced/ops.c';
import mountStageH from '@vps/shell/helpers/ellul-namespaced/mount_stage.h';
import mountStageC from '@vps/shell/helpers/ellul-namespaced/mount_stage.c';
import enterH from '@vps/shell/helpers/ellul-namespaced/enter.h';
import enterC from '@vps/shell/helpers/ellul-namespaced/enter.c';
import byokH from '@vps/shell/helpers/ellul-namespaced/byok.h';
import byokC from '@vps/shell/helpers/ellul-namespaced/byok.c';
import fdPassC from '@vps/shell/helpers/ellul-namespaced/fd_pass.c';
import testAuthC from '@vps/shell/helpers/ellul-namespaced/test_auth.c';
import testManifestC from '@vps/shell/helpers/ellul-namespaced/test_manifest.c';
import testTargetCgroupC from '@vps/shell/helpers/ellul-namespaced/test_target_cgroup.c';
import testByokC from '@vps/shell/helpers/ellul-namespaced/test_byok.c';

export interface DaemonSource {
  filename: string;
  content: string;
}

export function getDaemonSources(): DaemonSource[] {
  return [
    { filename: 'daemon.h', content: daemonH },
    { filename: 'log.h', content: logH },
    { filename: 'log.c', content: logC },
    { filename: 'cbor_io.h', content: cborH },
    { filename: 'cbor_io.c', content: cborC },
    { filename: 'hmac_session.h', content: hmacH },
    { filename: 'hmac_session.c', content: hmacC },
    { filename: 'manifest.h', content: manifestH },
    { filename: 'manifest.c', content: manifestC },
    { filename: 'mountinfo.h', content: mountinfoH },
    { filename: 'mountinfo.c', content: mountinfoC },
    { filename: 'auth.h', content: authH },
    { filename: 'auth.c', content: authC },
    { filename: 'sock_listen.h', content: sockH },
    { filename: 'sock_listen.c', content: sockC },
    { filename: 'attest.h', content: attestH },
    { filename: 'attest.c', content: attestC },
    { filename: 'ops.h', content: opsH },
    { filename: 'ops.c', content: opsC },
    { filename: 'mount_stage.h', content: mountStageH },
    { filename: 'mount_stage.c', content: mountStageC },
    { filename: 'enter.h', content: enterH },
    { filename: 'enter.c', content: enterC },
    { filename: 'byok.h', content: byokH },
    { filename: 'byok.c', content: byokC },
    { filename: 'dispatch.h', content: dispatchH },
    { filename: 'dispatch.c', content: dispatchC },
    { filename: 'daemon_seccomp.h', content: seccompH },
    { filename: 'daemon_seccomp.c', content: seccompC },
    { filename: 'main.c', content: mainC },
    /* fd_pass.c has its own main(); the install shell compiles it as a
     * separate /usr/local/bin/ellul-fd-pass binary and excludes it from
     * the daemon's link line. */
    { filename: 'fd_pass.c', content: fdPassC },
  ];
}

/**
 * Source for the bridge-side SCM_RIGHTS helper binary. Compiled to
 * /usr/local/bin/ellul-fd-pass (mode 0755). Invoked by Node's child_process
 * to bypass the lack of a public sendmsg/recvmsg ancillary-data API.
 */
export function getFdPassSource(): string {
  return fdPassC;
}

/**
 * Standalone C unit tests for the daemon's textual helpers (cgroup-bridge
 * matcher, manifest path/option matcher, adapterScope target_cgroup
 * validator). Each file `#include`s only its dependencies — no libsodium /
 * libtinycbor / libseccomp / libsystemd needed; the CI VM workflow compiles
 * each as a single-file binary and runs it as a smoke test.
 *
 * NOT shipped via getDaemonSources() — production hosts don't need these.
 */
export function getDaemonTestSources(): DaemonSource[] {
  return [
    { filename: 'test_auth.c', content: testAuthC },
    { filename: 'test_manifest.c', content: testManifestC },
    { filename: 'test_target_cgroup.c', content: testTargetCgroupC },
    { filename: 'test_byok.c', content: testByokC },
  ];
}
