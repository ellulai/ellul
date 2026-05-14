// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import type {
  IssueRequest,
  IssueResponse,
  Report401Request,
  Report401Response,
  RevokeRequest,
  RevokeResponse,
  SafePeekResponse,
  SaveRequest,
  SaveResponse,
} from "@vps/shared/claude-oat";
import type {
  AuthStateCache,
  AuthStateSnapshot,
  ShieldHttpResult,
  ShieldOatGateway,
} from "./application/ports";
import { HttpShieldOatGateway } from "./infrastructure/shield-http.gateway";
import { AuthStateCacheImpl } from "./infrastructure/auth-state-cache";
import { issueToken } from "./application/issue-token";
import { reportUnauth401 } from "./application/report-unauth-401";
import {
  proxyRevokeToken,
  proxySaveToken,
} from "./application/proxy-user-actions";
import { migrateLegacyClaudeJson } from "./migration/claude-json-strip";

export interface ClaudeOatBridgeModule {
  issueToken(input: IssueRequest): Promise<IssueResponse | null>;
  redeemToken(issuanceToken: string): Promise<string | null>;
  reportUnauth401(input: Report401Request): Promise<Report401Response | null>;
  proxySaveToken(input: SaveRequest): Promise<ShieldHttpResult<SaveResponse>>;
  proxyRevokeToken(
    input: RevokeRequest,
  ): Promise<ShieldHttpResult<RevokeResponse>>;
  /** Pure cache read — never blocks on shield. Background tick keeps it fresh. */
  peek(): Promise<SafePeekResponse | null>;
  getAuthSnapshot(): AuthStateSnapshot;
  readonly authStateCache: AuthStateCache;
  runMigration(): Promise<void>;
}

export function buildClaudeOatBridgeModule(): ClaudeOatBridgeModule {
  const gateway: ShieldOatGateway = new HttpShieldOatGateway();
  const cache: AuthStateCache = new AuthStateCacheImpl(gateway);
  cache.start();
  return {
    issueToken: (input) => issueToken(gateway, input),
    redeemToken: async (issuanceToken: string) => {
      const res = await gateway.redeem({ issuanceToken });
      return res?.token ?? null;
    },
    reportUnauth401: (input) => reportUnauth401(gateway, input),
    proxySaveToken: (input) => proxySaveToken(gateway, cache, input),
    proxyRevokeToken: (input) => proxyRevokeToken(gateway, cache, input),
    peek: () => Promise.resolve(cache.getSnapshot().peek),
    getAuthSnapshot: () => cache.getSnapshot(),
    authStateCache: cache,
    runMigration: () => migrateLegacyClaudeJson(gateway),
  };
}
