// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Log Redaction Service
 *
 * Shared secret redaction for trusted log pipe, env-shield-preload,
 * and log streaming API.
 *
 * Uses prefix-set pre-filter (Set of 8-char prefixes) for O(1) fast-path
 * on normal log lines. Full replaceAll only when a prefix match is detected.
 *
 * Multi-encoding: checks plain text, base64, URL-encoded, and hex variants
 * to catch secrets that pass through btoa(), encodeURIComponent(), or hex
 * serialization before being logged.
 */

const PREFIX_LEN = 8;

/** Compute all encoded variants of a secret value. */
function getEncodedVariants(value: string): string[] {
  const variants = [value];

  // Base64
  const b64 = Buffer.from(value).toString('base64');
  if (b64 !== value) variants.push(b64);

  // URL-encoded
  try {
    const urlEnc = encodeURIComponent(value);
    if (urlEnc !== value) variants.push(urlEnc);
  } catch {
    // encodeURIComponent can throw on malformed surrogate pairs — skip
  }

  // Hex
  const hex = Buffer.from(value).toString('hex');
  if (hex !== value) variants.push(hex);

  return variants;
}

/** Build a prefix set for fast-path filtering. */
function buildPrefixSet(values: string[]): Set<string> {
  const prefixes = new Set<string>();
  for (const v of values) {
    if (v.length >= PREFIX_LEN) {
      prefixes.add(v.slice(0, PREFIX_LEN));
    }
  }
  return prefixes;
}

/** Check if any prefix from the set appears in the text. */
function hasPrefixMatch(text: string, prefixes: Set<string>): boolean {
  for (const prefix of prefixes) {
    if (text.includes(prefix)) return true;
  }
  return false;
}

/**
 * Redact secret values from text.
 *
 * Fast path: if no prefix matches, return text unchanged (most log lines).
 * Slow path: replace all occurrences of each secret value (and encoded
 * variants) with [REDACTED].
 */
export function redactSecrets(text: string, secretValues: string[]): string {
  if (secretValues.length === 0) return text;

  // Expand all values to include encoded variants
  const allVariants: string[] = [];
  for (const value of secretValues) {
    if (value.length < 4) continue;
    allVariants.push(...getEncodedVariants(value));
  }

  const prefixes = buildPrefixSet(allVariants);
  if (!hasPrefixMatch(text, prefixes)) return text;

  let result = text;
  for (const variant of allVariants) {
    result = result.replaceAll(variant, '[REDACTED]');
  }
  return result;
}

/**
 * Create a reusable redactor with pre-computed prefix set.
 * More efficient when redacting many lines with the same secret set.
 */
export function createRedactor(secretValues: string[]): (text: string) => string {
  if (secretValues.length === 0) return (text) => text;

  const filtered = secretValues.filter(v => v.length >= 4);
  if (filtered.length === 0) return (text) => text;

  // Pre-compute all encoded variants once
  const allVariants: string[] = [];
  for (const value of filtered) {
    allVariants.push(...getEncodedVariants(value));
  }

  const prefixes = buildPrefixSet(allVariants);

  return (text: string): string => {
    if (!hasPrefixMatch(text, prefixes)) return text;
    let result = text;
    for (const variant of allVariants) {
      result = result.replaceAll(variant, '[REDACTED]');
    }
    return result;
  };
}
