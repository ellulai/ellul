// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

/**
 * Ports for the launcher's application layer.
 *
 * Each port is a single-method interface so tests can substitute fakes
 * without spinning up a server, a process, or a filesystem. The
 * launcher's main flow depends only on these contracts.
 */

export interface IpcTokenReader {
  /** Read /run/shield/internal-agent-bridge.token. Throws on failure. */
  read(): string;
}

export interface ShieldRedeemClient {
  /**
   * Exchange an issuance token for the actual OAT via shield's /redeem
   * endpoint. Throws with a meaningful message on failure.
   */
  redeem(issuanceToken: string, serviceToken: string): Promise<string>;
}

export interface Executor {
  /**
   * Run the namespace wrapper, replacing this process. Returns the
   * exit code; in practice execFileSync semantics mean we wait for the
   * child and exit with its code.
   */
  exec(
    binary: string,
    args: readonly string[],
    env: Record<string, string>,
  ): never;
}

export interface FailureReporter {
  fail(code: number, message: string): never;
}
