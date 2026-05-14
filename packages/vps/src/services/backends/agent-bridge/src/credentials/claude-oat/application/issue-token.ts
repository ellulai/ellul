// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import type { IssueRequest, IssueResponse } from "@vps/shared/claude-oat";
import type { ShieldOatGateway } from "./ports";

/**
 * Use-case: mint a single-use OAT issuance token before a Claude spawn.
 *
 * Returns null on shield failure — caller must fail-fast and surface the
 * "log in" UI rather than spawning Claude unauthenticated.
 */
export async function issueToken(
  gateway: ShieldOatGateway,
  input: IssueRequest,
): Promise<IssueResponse | null> {
  return gateway.issue(input);
}
