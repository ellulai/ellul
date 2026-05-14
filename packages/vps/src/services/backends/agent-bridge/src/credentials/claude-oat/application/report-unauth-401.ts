// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import type {
  Report401Request,
  Report401Response,
} from "@vps/shared/claude-oat";
import type { ShieldOatGateway } from "./ports";

/**
 * Use-case: AUDIT-ONLY report of an upstream 401.
 *
 * Best-effort: failures here never block bridge logic. Shield treats this
 * call as observability, not a state-mutation signal.
 */
export async function reportUnauth401(
  gateway: ShieldOatGateway,
  input: Report401Request,
): Promise<Report401Response | null> {
  return gateway.reportUnauth(input);
}
