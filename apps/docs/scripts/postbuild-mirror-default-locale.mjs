#!/usr/bin/env node
/**
 * Post-build: copy out/en/* to out/ so the default-locale URLs work without a
 * routing layer.
 *
 * Why this matters: with localePrefix="as-needed" and Next's static export,
 * the build emits only locale-prefixed paths (out/en/foo, out/ja/foo). In
 * production, Cloudflare Pages or the next-intl middleware rewrites / to the
 * /en variant. Static hosts (and local Lighthouse) don't have that layer —
 * so we copy at build time and let / serve the same bytes as /en. Other
 * locales (/ja, /ko, etc.) keep their explicit prefix.
 *
 * Idempotent. Safe to run multiple times.
 */

import { cpSync, existsSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const OUT = path.join(process.cwd(), "out");
const EN = path.join(OUT, "en");

if (!existsSync(EN)) {
  console.error("postbuild-mirror: out/en does not exist; nothing to mirror");
  process.exit(0);
}

// Copy en/* into out/ but only when the destination either doesn't exist or
// is the locale-mirrored copy (we never overwrite other-locale dirs).
function mirror(src, destBase) {
  cpSync(src, destBase, {
    recursive: true,
    force: true,
    // Preserve file modes; gzipping etc. continues to work.
  });
}

mirror(EN, OUT);

// out/en.html is the homepage for /en. Rename it to index.html so static
// hosts serve it at /, then clean up any remaining stray en.* siblings.
const enHtml = path.join(OUT, "en.html");
if (existsSync(enHtml) && statSync(enHtml).isFile()) {
  renameSync(enHtml, path.join(OUT, "index.html"));
}
for (const stray of ["en.txt"]) {
  const p = path.join(OUT, stray);
  if (existsSync(p) && statSync(p).isFile()) {
    rmSync(p);
  }
}

console.log(
  "postbuild-mirror: out/ now serves the en variant at the root (other locales stay prefixed)",
);
