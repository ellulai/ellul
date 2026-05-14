#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Validates ICU/key invariants across the centralized message tree.
 *
 *   - Same set of namespace files in every locale dir
 *   - Same key tree per namespace across all locales
 *   - ICU placeholders byte-for-byte identical to the canonical (English) source
 *   - Rich-text tag names byte-for-byte identical to the canonical source
 *   - Every namespace JSON parses
 *
 * Usage:
 *   node scripts/validate-key-trees.mjs
 *
 * Exit code 0 if everything passes; 1 if any drift is detected.
 *
 * The canonical source is always English (`en/<namespace>.json`).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const MSG_DIR = path.join(ROOT, "messages");
const AGENT_CONTEXT_DIR = path.join(ROOT, "agent-context");

// ALL_LOCALES is duplicated here so the validator has zero deps. If this
// drifts from @ellul.ai/i18n-consts, surfaces will fail in builds first.
const ALL_LOCALES = ["en", "ja", "ko", "de", "pt-BR", "fr"];
const CANONICAL = "en";

// Locales whose translations have shipped — must mirror SHIPPED_LOCALES
// in src/loaders.ts. Both surfaces (UI namespaces + agent-context .md)
// must be present for every shipped locale; the validator enforces it.
const SHIPPED_LOCALES = new Set(["en", "ja"]);

// Subdirectories of agent-context/ that must contain a per-locale .md.
// Mirrors VARIANTS in agent-context/index.ts.
const AGENT_CONTEXT_DIRS = ["claude", "agents", "cursor-rules"];

// Locale-required keys for the vpsShell namespace, plus the schema we
// expect (motd has 6 fields, unauthorizedPage has 2). The standard
// key-tree comparison already catches missing keys; this surfaces the
// schema explicitly for new-locale onboarding.
const VPS_SHELL_REQUIRED_KEYS = [
  "vpsShell.motd.tagline",
  "vpsShell.motd.deployedHeader",
  "vpsShell.motd.noAppsHint",
  "vpsShell.motd.aiHeader",
  "vpsShell.motd.toolsInstalling",
  "vpsShell.motd.cmdsHeader",
  "vpsShell.unauthorizedPage.body",
  "vpsShell.unauthorizedPage.cta",
];

let totalErrors = 0;

function flatten(obj, prefix = "") {
  const out = {};
  for (const k of Object.keys(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    const v = obj[k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      Object.assign(out, flatten(v, p));
    } else {
      out[p] = v;
    }
  }
  return out;
}

// ICU placeholder names — extracts the variable referenced in
// `{name}`, `{name, plural, ...}`, `{name, select, ...}`, etc.
// Tracks brace depth so branch content like `{Revert}` inside
// `{count, plural, one {Revert} other {Revert # turns}}` is NOT
// treated as a placeholder name. The validator enforces variable-
// NAME parity across locales; inner plural/select branches are
// intentionally locale-specific (en has "one"/"other", ja often
// only "other", ar has six forms).
const TAG_RX = /<[a-z]+>|<\/[a-z]+>/gi;

function extractPlaceholderNames(s) {
  const names = new Set();
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "{") {
      if (depth === 0) {
        // Top-level placeholder — parse the identifier.
        let j = i + 1;
        while (j < s.length && /\s/.test(s[j])) j++;
        const start = j;
        while (j < s.length && /[a-zA-Z0-9_]/.test(s[j])) j++;
        if (j > start) {
          const name = s.slice(start, j);
          // Confirm what follows is `,` (formatted), `}` (simple),
          // or whitespace then one of those — not arbitrary text
          // content that happens to start with an identifier.
          let k = j;
          while (k < s.length && /\s/.test(s[k])) k++;
          if (s[k] === "}" || s[k] === ",") {
            names.add(name);
          }
        }
      }
      depth++;
    } else if (ch === "}") {
      depth--;
    }
  }
  return [...names].sort();
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    console.error(`  ❌ ${path.relative(ROOT, filePath)}: ${err.message}`);
    totalErrors++;
    return null;
  }
}

function listNamespaceFiles(localeDir) {
  if (!fs.existsSync(localeDir)) return [];
  return fs.readdirSync(localeDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

function compareTrees(label, canonical, locale, otherLabel) {
  const enFlat = flatten(canonical);
  const xFlat = flatten(locale);
  const enKeys = new Set(Object.keys(enFlat));
  const xKeys = new Set(Object.keys(xFlat));
  const missing = [...enKeys].filter((k) => !xKeys.has(k));
  const extra = [...xKeys].filter((k) => !enKeys.has(k));
  let local = 0;

  if (missing.length) {
    console.error(`  ❌ ${label}: ${missing.length} missing keys in ${otherLabel}`);
    for (const k of missing.slice(0, 10)) console.error(`       - ${k}`);
    if (missing.length > 10) console.error(`       … and ${missing.length - 10} more`);
    local += missing.length;
  }
  if (extra.length) {
    console.error(`  ❌ ${label}: ${extra.length} extra keys in ${otherLabel}`);
    for (const k of extra.slice(0, 10)) console.error(`       + ${k}`);
    if (extra.length > 10) console.error(`       … and ${extra.length - 10} more`);
    local += extra.length;
  }

  for (const k of enKeys) {
    if (!xKeys.has(k)) continue;
    const enVal = enFlat[k];
    const xVal = xFlat[k];
    if (typeof enVal !== "string" || typeof xVal !== "string") continue;
    const enPlaceholders = extractPlaceholderNames(enVal);
    const xPlaceholders = extractPlaceholderNames(xVal);
    if (JSON.stringify(enPlaceholders) !== JSON.stringify(xPlaceholders)) {
      console.error(`  ❌ ${label}: ICU placeholder mismatch at "${k}"`);
      console.error(`       en: ${JSON.stringify(enPlaceholders)}`);
      console.error(`       ${otherLabel}: ${JSON.stringify(xPlaceholders)}`);
      local++;
    }
    const enTags = (enVal.match(TAG_RX) || []).slice().sort();
    const xTags = (xVal.match(TAG_RX) || []).slice().sort();
    if (JSON.stringify(enTags) !== JSON.stringify(xTags)) {
      console.error(`  ❌ ${label}: rich-text tag mismatch at "${k}"`);
      console.error(`       en: ${JSON.stringify(enTags)}`);
      console.error(`       ${otherLabel}: ${JSON.stringify(xTags)}`);
      local++;
    }
  }

  totalErrors += local;
  return local;
}

function validateAgentContext(locale) {
  const localeLabel = `agent-context/${locale}`;
  let issues = 0;
  for (const dir of AGENT_CONTEXT_DIRS) {
    const mdPath = path.join(AGENT_CONTEXT_DIR, dir, `${locale}.md`);
    if (!fs.existsSync(mdPath)) {
      console.error(`  ❌ ${localeLabel}: missing ${dir}/${locale}.md`);
      issues++;
      continue;
    }
    const content = fs.readFileSync(mdPath, "utf8");
    if (content.trim().length === 0) {
      console.error(`  ❌ ${localeLabel}: ${dir}/${locale}.md is empty`);
      issues++;
      continue;
    }
    // Enforce the locale frontmatter sentinel — the mismatch detector
    // (Layer 6) reads this to confirm the file's authored locale
    // without parsing prose.
    if (!content.includes(`<!-- ellul:locale=${locale} -->`)) {
      console.error(
        `  ❌ ${localeLabel}: ${dir}/${locale}.md missing '<!-- ellul:locale=${locale} -->' sentinel`,
      );
      issues++;
    }
  }
  return issues;
}

function validateVpsShellSchema(locale, json) {
  const flat = flatten(json);
  let issues = 0;
  for (const key of VPS_SHELL_REQUIRED_KEYS) {
    if (typeof flat[key] !== "string" || flat[key].length === 0) {
      console.error(`  ❌ ${locale}/vpsShell: missing or empty "${key}"`);
      issues++;
    }
  }
  return issues;
}

function main() {
  const canonicalDir = path.join(MSG_DIR, CANONICAL);
  if (!fs.existsSync(canonicalDir)) {
    console.error(`canonical locale dir missing: ${canonicalDir}`);
    process.exit(1);
  }

  const canonicalNamespaces = listNamespaceFiles(canonicalDir);
  console.log(`canonical (${CANONICAL}) namespaces: ${canonicalNamespaces.join(", ")}`);

  // vpsShell schema check — both en (canonical) and every shipped
  // locale must have all required keys non-empty. Catches partial
  // translations that otherwise pass key-tree parity (e.g., empty
  // string is a valid JSON string but useless at MOTD render).
  for (const locale of SHIPPED_LOCALES) {
    const vpsShellPath = path.join(MSG_DIR, locale, "vpsShell.json");
    if (!fs.existsSync(vpsShellPath)) {
      console.error(`  ❌ ${locale}/vpsShell.json missing — required for shipped locale`);
      totalErrors++;
      continue;
    }
    const json = readJson(vpsShellPath);
    if (json) totalErrors += validateVpsShellSchema(locale, json);
  }

  // Agent-context completeness — every SHIPPED_LOCALE must have all
  // three .md files (claude, agents, cursor-rules) with the locale
  // sentinel. Catches the "added the JSON but forgot the .md" mistake.
  console.log(`\nvalidating agent-context for shipped locales: ${[...SHIPPED_LOCALES].join(", ")}`);
  for (const locale of SHIPPED_LOCALES) {
    const issues = validateAgentContext(locale);
    if (issues === 0) {
      console.log(`  ✓ agent-context/${locale}: ${AGENT_CONTEXT_DIRS.length} files present with sentinel`);
    } else {
      totalErrors += issues;
    }
  }

  for (const locale of ALL_LOCALES) {
    if (locale === CANONICAL) continue;
    const dir = path.join(MSG_DIR, locale);
    if (!fs.existsSync(dir)) {
      console.log(`\n· ${locale}: not yet shipped (skipped)`);
      continue;
    }

    const localNamespaces = listNamespaceFiles(dir);

    // Empty dir — operator scaffolded the directory but has not added any
    // namespace files yet. Treat as "not yet shipped" rather than reporting
    // every-namespace missing. The first added file flips this branch into
    // the strict path below, where partial trees DO fail (better to catch
    // a half-shipped translation pre-merge than post-merge with mixed-language UI).
    if (localNamespaces.length === 0) {
      console.log(`\n· ${locale}: directory exists but empty — treated as not yet shipped`);
      continue;
    }

    console.log(`\nvalidating ${locale}`);

    const localSet = new Set(localNamespaces);
    const canonSet = new Set(canonicalNamespaces);
    const missingNs = [...canonSet].filter((n) => !localSet.has(n));
    const extraNs = [...localSet].filter((n) => !canonSet.has(n));

    if (missingNs.length) {
      console.error(`  ❌ ${locale}: missing namespace files: ${missingNs.join(", ")}`);
      totalErrors += missingNs.length;
    }
    if (extraNs.length) {
      console.error(`  ❌ ${locale}: extra namespace files: ${extraNs.join(", ")}`);
      totalErrors += extraNs.length;
    }

    let issues = 0;
    for (const ns of canonicalNamespaces) {
      const canonPath = path.join(canonicalDir, `${ns}.json`);
      const otherPath = path.join(dir, `${ns}.json`);
      if (!fs.existsSync(otherPath)) continue;
      const canonJson = readJson(canonPath);
      const otherJson = readJson(otherPath);
      if (!canonJson || !otherJson) continue;
      issues += compareTrees(`${locale}/${ns}`, canonJson, otherJson, `${locale}/${ns}.json`);
    }
    if (issues === 0 && !missingNs.length && !extraNs.length) {
      console.log(`  ✓ ${locale}: parity across ${canonicalNamespaces.length} namespaces`);
    }
  }

  if (totalErrors > 0) {
    console.error(`\n${totalErrors} validation issue(s) found.`);
    process.exit(1);
  }
  console.log("\nall validations passed.");
}

main();
