// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Reads a typed subtree from a translator's raw access. next-intl's typed
 * `t.raw` rejects non-leaf keys at compile time, but accessing object
 * subtrees (for iteration with dynamic indexing) is a legitimate need.
 * This helper bypasses the leaf-only constraint while keeping the
 * caller-side cast explicit.
 *
 * @example
 *   const t = await getTranslations("home.highlights");
 *   const items = rawSubtree<Record<string, { title: string; body: string }>>(t, "items");
 */
export function rawSubtree<T>(
  t: { raw: (key: never) => unknown },
  key: string,
): T {
  const raw = t.raw as unknown as (key: string) => unknown;
  return raw(key) as T;
}
