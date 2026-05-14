// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// HTTP wrappers for sovereign-shield credential-bearing git routes.
// agent-bridge never spawns credential-bearing git directly — see
// docs/v2/operations/04-runbooks/upstream-sync.md deviation #6. Currently unused by Phase G
// (checkpoint capture is local-only); scaffolding for Phase H/I.

import { callShieldInternal } from "@vps/shared/shield-client";

interface ShieldJson<T> {
  readonly ok: boolean;
  readonly data?: T;
  readonly error?: string;
}

async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await callShieldInternal(path, { method: "POST", body });
  const text = await res.text();
  let parsed: ShieldJson<T>;
  try {
    parsed = JSON.parse(text) as ShieldJson<T>;
  } catch {
    throw new Error(`shield ${path} returned non-JSON body (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok || parsed.ok === false) {
    throw new Error(`shield ${path} failed (${res.status}): ${parsed.error ?? text.slice(0, 200)}`);
  }
  return parsed.data as T;
}

export interface GitCredentialsInput {
  readonly project: string;
  readonly remoteUrl?: string;
}
export interface GitCredentialsResult {
  readonly token: string;
  readonly expiresAt: string;
}

export function getGitCredentials(input: GitCredentialsInput): Promise<GitCredentialsResult> {
  return post<GitCredentialsResult>("/api/internal/git-credentials", { ...input });
}

export interface GitPushInput {
  readonly project: string;
  readonly branch?: string;
  readonly gateToken: string;
}
export interface GitPushResult {
  readonly status: "pushed" | "skipped_up_to_date";
  readonly branch: string;
}

export function pushViaShield(input: GitPushInput): Promise<GitPushResult> {
  return post<GitPushResult>("/api/internal/git-push", { ...input });
}

export interface GitPullInput {
  readonly project: string;
  readonly branch?: string;
}
export interface GitPullResult {
  readonly status: "pulled" | "skipped_up_to_date";
  readonly branch: string;
}

export function pullViaShield(input: GitPullInput): Promise<GitPullResult> {
  return post<GitPullResult>("/api/internal/git-pull", { ...input });
}

export interface GitFetchInput {
  readonly project: string;
  readonly remote?: string;
}

export function fetchViaShield(input: GitFetchInput): Promise<void> {
  return post<void>("/api/internal/git-fetch", { ...input });
}

export interface GitCloneInput {
  readonly project: string;
  readonly remoteUrl: string;
  readonly branch?: string;
}

export function cloneViaShield(input: GitCloneInput): Promise<{ readonly cloned: boolean }> {
  return post<{ readonly cloned: boolean }>("/api/internal/git-clone", { ...input });
}

export interface GitLinkInput {
  readonly project: string;
  readonly remoteUrl: string;
}

export function linkViaShield(input: GitLinkInput): Promise<void> {
  return post<void>("/api/internal/git-link", { ...input });
}

export interface ValidateGitPushInput {
  readonly project: string;
  readonly branch?: string;
}
export interface ValidateGitPushResult {
  readonly allowed: boolean;
  readonly reason?: string;
}

export function validateGitPush(input: ValidateGitPushInput): Promise<ValidateGitPushResult> {
  return post<ValidateGitPushResult>("/api/workflow/validate-git-push", { ...input });
}
