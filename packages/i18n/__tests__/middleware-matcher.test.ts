import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { I18N_MIDDLEWARE_MATCHER } from "../src/middleware";

/**
 * Next.js 15.5+ requires every app's middleware.ts `config.matcher` to be a
 * statically-resolvable literal — it cannot be imported from another package.
 * Each app inlines the matcher and we trust this test to keep them in sync
 * with the canonical export here.
 *
 * If this test fails, copy the value of I18N_MIDDLEWARE_MATCHER into the
 * offending app's middleware.ts (the `config = { matcher: [...] }` line).
 */

const APPS = [
  "apps/web/src/middleware.ts",
  "apps/docs/src/middleware.ts",
];

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

function extractMatcher(source: string): string[] | null {
  const m = source.match(/matcher:\s*(\[[\s\S]*?\])/);
  if (!m) return null;
  // Use JSON.parse on the literal to interpret escape sequences correctly.
  // The matcher array uses double-quoted strings, no comments, no trailing
  // commas — valid JSON in practice. Strip any trailing comma before `]`.
  const literal = m[1].replace(/,(\s*\])/g, "$1");
  try {
    return JSON.parse(literal);
  } catch {
    return null;
  }
}

describe("middleware matcher drift", () => {
  for (const rel of APPS) {
    const fullPath = path.join(REPO_ROOT, rel);

    it(`${rel} mirrors I18N_MIDDLEWARE_MATCHER`, () => {
      if (!fs.existsSync(fullPath)) {
        // App missing locally (e.g. shallow checkout) — skip rather than fail.
        return;
      }
      const source = fs.readFileSync(fullPath, "utf-8");
      const inlined = extractMatcher(source);
      expect(inlined, `no matcher array found in ${rel}`).not.toBeNull();
      expect(inlined).toEqual([...I18N_MIDDLEWARE_MATCHER]);
    });
  }
});
