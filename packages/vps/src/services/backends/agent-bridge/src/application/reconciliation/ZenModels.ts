// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.
//
// OpenCode Zen model discovery — ellul-only.
//
// Polls https://opencode.ai/zen/v1/models every 30 minutes and exposes
// the result to the UI via the ellul.getZenModels WS RPC. Zen is OpenCode's
// free tier: all models returned here are usable without a user-provided
// API key. The UI merges them into the OpenCode provider's model picker.
//
// Heuristic ranking (matches the deleted pre-C.5.c service):
//   - versioned model ids score higher than unversioned
//   - ids containing "large" get a small bonus
//   - ids containing "mini", "nano", "small" are deprioritized
// Ties break by Zen's response order (stable sort).
//
// In-memory cache only. Fetch failures keep the previous cache rather than
// clearing it, so transient outages don't break the picker.

import { ZEN_MODELS_URL, ZEN_REFRESH_MS } from "../../config";

export interface ZenModel {
  readonly id: string;
  readonly openCodeId: string;
}

interface ZenApiResponse {
  readonly data?: ReadonlyArray<{ readonly id: string }>;
}

let cachedModels: ReadonlyArray<ZenModel> = [];
let refreshTimer: ReturnType<typeof setInterval> | null = null;

function modelQualityScore(id: string): number {
  let score = /\d/.test(id) ? 1 : 0;
  if (/large/i.test(id)) score += 0.3;
  if (/mini|nano|small/i.test(id)) score -= 1;
  return score;
}

async function fetchZenModels(): Promise<ReadonlyArray<ZenModel>> {
  const res = await fetch(ZEN_MODELS_URL, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) {
    throw new Error(`Zen API returned ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as ZenApiResponse;
  const items = body.data ?? [];
  const indexed = items.map((item, index) => ({ item, index }));
  indexed.sort((a, b) => {
    const diff = modelQualityScore(b.item.id) - modelQualityScore(a.item.id);
    return diff !== 0 ? diff : a.index - b.index;
  });
  return indexed.map(({ item }) => ({
    id: item.id,
    openCodeId: `opencode/${item.id}`,
  }));
}

async function refreshOnce(): Promise<void> {
  try {
    const models = await fetchZenModels();
    if (models.length > 0) {
      cachedModels = models;
      console.log(`[Zen] Refreshed ${models.length} free models`);
    }
  } catch (err) {
    console.warn("[Zen] Refresh failed:", (err as Error).message);
  }
}

export function startZenModelRefresh(): void {
  if (refreshTimer) return;
  void refreshOnce();
  refreshTimer = setInterval(() => void refreshOnce(), ZEN_REFRESH_MS);
  if (refreshTimer.unref) refreshTimer.unref();
}

export function stopZenModelRefresh(): void {
  if (!refreshTimer) return;
  clearInterval(refreshTimer);
  refreshTimer = null;
}

export function getCurrentZenModels(): ReadonlyArray<ZenModel> {
  return cachedModels;
}

export function getBestZenModel(): ZenModel | null {
  return cachedModels[0] ?? null;
}
