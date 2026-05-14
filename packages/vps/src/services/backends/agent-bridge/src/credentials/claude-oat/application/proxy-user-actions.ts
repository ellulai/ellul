// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import type {
  RevokeRequest,
  RevokeResponse,
  SaveRequest,
  SaveResponse,
} from "@vps/shared/claude-oat";
import type { AuthStateCache, ShieldHttpResult, ShieldOatGateway } from "./ports";

export async function proxySaveToken(
  gateway: ShieldOatGateway,
  cache: AuthStateCache,
  req: SaveRequest,
): Promise<ShieldHttpResult<SaveResponse>> {
  const result = await gateway.save(req);
  if (result.ok) cache.setFromSave();
  return result;
}

export async function proxyRevokeToken(
  gateway: ShieldOatGateway,
  cache: AuthStateCache,
  req: RevokeRequest,
): Promise<ShieldHttpResult<RevokeResponse>> {
  const result = await gateway.revoke(req);
  if (result.ok) cache.setFromRevoke();
  return result;
}
