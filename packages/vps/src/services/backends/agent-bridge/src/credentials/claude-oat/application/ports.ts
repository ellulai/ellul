// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

/**
 * Application-layer ports for the bridge-side Claude OAT module.
 *
 * Bridge talks to sovereign-shield over HTTP for every credential
 * operation. The ShieldOatGateway port is the seam that lets us swap
 * the real callShieldInternal client for a fake in tests.
 */

import type {
  IssueRequest,
  IssueResponse,
  RedeemRequest,
  RedeemResponse,
  Report401Request,
  Report401Response,
  RevokeRequest,
  RevokeResponse,
  SafePeekResponse,
  SaveRequest,
  SaveResponse,
} from "@vps/shared/claude-oat";

export interface ShieldHttpResult<T> {
  readonly ok: boolean;
  readonly status: number;
  readonly body: T | { error?: string; code?: string };
}

/**
 * Bridge → shield gateway.
 *
 * Each method maps to one shield endpoint. Implementations:
 *   - infrastructure/shield-http.gateway.ts (production)
 *   - tests construct in-memory fakes
 */
export interface ShieldOatGateway {
  issue(req: IssueRequest): Promise<IssueResponse | null>;
  redeem(req: RedeemRequest): Promise<RedeemResponse | null>;
  peek(): Promise<SafePeekResponse | null>;
  reportUnauth(req: Report401Request): Promise<Report401Response | null>;
  save(req: SaveRequest): Promise<ShieldHttpResult<SaveResponse>>;
  revoke(req: RevokeRequest): Promise<ShieldHttpResult<RevokeResponse>>;
}

export interface AuthStateSnapshot {
  readonly peek: SafePeekResponse | null;
  readonly source: "init" | "save" | "revoke" | "peek";
  readonly checkedAt: number;
}

export interface AuthStateCache {
  getSnapshot(): AuthStateSnapshot;
  isAuthed(): boolean;
  setFromSave(): void;
  setFromRevoke(): void;
  start(): void;
  stop(): void;
  refresh(): Promise<AuthStateSnapshot>;
  refreshAsync(): void;
  invalidate(): void;
  invalidateAndAwaitRefresh(): Promise<boolean>;
}
