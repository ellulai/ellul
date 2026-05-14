#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Builds per-locale JSON payloads ready for CDN upload (R2 + Cloudflare
 * Worker, see TRANSLATIONS.md). For each locale present under
 * `messages/<locale>/`, aggregates all namespace JSON files into a single
 * flat tree and writes:
 *
 *   dist/cdn/<surface>/<locale>.json
 *
 * The shape exactly matches what `createRequestConfig`'s bundled loader
 * returns, so swapping bundled→CDN is transparent to consumers.
 *
 * Usage:
 *   node scripts/build-cdn-payload.mjs --surface web
 *   node scripts/build-cdn-payload.mjs --surface all
 *
 * Each surface gets the full tree today (per-surface partitioning is a
 * future optimization once messages/* exceeds the bundle-size threshold).
 *
 * Upload:
 *   wrangler r2 object put ellul-translations/web/ja.json \
 *     --file=dist/cdn/web/ja.json
 *
 * Then revalidate the cache tag on the surface:
 *   curl -X POST https://<surface>.ellul.ai/api/revalidate \
 *     -H "Authorization: Bearer $INTERNAL_API_SECRET" \
 *     -d '{"tag":"translations-<surface>-<locale>"}'
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const MSG_DIR = path.join(ROOT, "messages");
const OUT_DIR = path.join(ROOT, "dist", "cdn");

const SURFACES = ["web", "console", "vps-ui", "docs"];

function listLocales() {
  return fs.readdirSync(MSG_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function buildLocaleTree(locale) {
  const dir = path.join(MSG_DIR, locale);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  const tree = {};
  for (const f of files) {
    const part = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    Object.assign(tree, part);
  }
  return tree;
}

function writePayload(surface, locale, tree) {
  const dir = path.join(OUT_DIR, surface);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${locale}.json`);
  fs.writeFileSync(file, JSON.stringify(tree));
  const size = fs.statSync(file).size;
  console.log(`  ✓ ${path.relative(ROOT, file)} (${(size / 1024).toFixed(1)} KB)`);
}

function main() {
  const args = process.argv.slice(2);
  let surfaceArg = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--surface") {
      surfaceArg = args[i + 1];
      i++;
    }
  }
  if (!surfaceArg) {
    console.error("usage: build-cdn-payload.mjs --surface <name|all>");
    process.exit(2);
  }

  const surfaces = surfaceArg === "all" ? SURFACES : [surfaceArg];
  for (const surface of surfaces) {
    if (!SURFACES.includes(surface)) {
      console.error(`unknown surface: ${surface}`);
      process.exit(2);
    }
  }

  const locales = listLocales();
  console.log(`building CDN payloads for surfaces: ${surfaces.join(", ")}`);
  console.log(`shipped locales:                    ${locales.join(", ")}`);

  for (const surface of surfaces) {
    console.log(`\n${surface}:`);
    for (const locale of locales) {
      const tree = buildLocaleTree(locale);
      writePayload(surface, locale, tree);
    }
  }

  console.log(`\nready for upload. example:`);
  console.log(`  wrangler r2 object put ellul-translations/<surface>/<locale>.json \\`);
  console.log(`    --file=${path.relative(process.cwd(), OUT_DIR)}/<surface>/<locale>.json`);
}

main();
