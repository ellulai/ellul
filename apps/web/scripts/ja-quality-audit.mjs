#!/usr/bin/env node
// Mechanical quality audit for JA blog/pillar/static MDX bodies.
// Surrogate for a native-review pass: catches the issues a reviewer would
// flag first. Voice consistency, MDX shortcode preservation, brand-name
// literality, structural parity with the EN sibling.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");

const ROOTS = [
  path.join(REPO, "src/content/blog"),
  path.join(REPO, "src/content/pillars"),
  path.join(REPO, "src/content/static"),
];

const FORBIDDEN_HONORIFICS = ["お客様", "御社", "弊社"];

const BRANDS_LITERAL = [
  "Ellul",
  "Sovereign Shield",
  "Cursor",
  "Claude Code",
  "Anthropic",
  "OpenAI",
  "Codex",
  "OpenCode",
  "Cognition",
  "Devin",
  "Manus",
  "Lovable",
  "Bolt",
  "Base44",
  "Replit",
  "Windsurf",
  "GitHub",
  "Daytona",
  "E2B",
  "Sprites",
  "MCP",
  "FIDO2",
  "WebAuthn",
  "AWS",
  "BYOK",
];

// Common bad transliterations a reviewer would flag.
const BAD_TRANSLITERATIONS = [
  "エルル",
  "カーソル",
  "クロード・コード",
  "コーデックス",
  "オープンコード",
  "ディヴィン",
  "マヌス",
  "ラヴァブル",
];

const SHORTCODE_RE = /<(NumberedList|NumberedItem|BulletList|BulletItem|Callout|Cta|Faq|CodeTabs|CodeTab|Term)\b/g;

function listFiles(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const ja = path.join(full, "ja.mdx");
      if (fs.existsSync(ja)) out.push(ja);
    }
  }
  return out;
}

function siblingEn(jaPath) {
  return jaPath.replace(/\/ja\.mdx$/, "/en.mdx");
}

function countShortcodes(content) {
  const matches = content.match(SHORTCODE_RE) ?? [];
  const counts = {};
  for (const m of matches) {
    const tag = m.replace(/[<\s]+/, "");
    counts[tag] = (counts[tag] || 0) + 1;
  }
  return counts;
}

function extractCodeBlockSpans(content) {
  // Crude: count fenced code blocks ``` and inline `code` (just for counts).
  const fenceCount = (content.match(/^```/gm) ?? []).length / 2;
  const inlineCount = (content.match(/`[^`\n]+`/g) ?? []).length;
  return { fenceCount: Math.floor(fenceCount), inlineCount };
}

function extractLinks(content) {
  // Markdown links [text](url).
  const re = /\[([^\]]+)\]\(([^)]+)\)/g;
  const out = [];
  let m;
  while ((m = re.exec(content))) {
    out.push({ text: m[1], url: m[2] });
  }
  return out;
}

function audit(jaPath) {
  const issues = [];
  const ja = fs.readFileSync(jaPath, "utf-8");
  const enPath = siblingEn(jaPath);
  const en = fs.existsSync(enPath) ? fs.readFileSync(enPath, "utf-8") : null;

  // 1. Forbidden honorifics
  for (const word of FORBIDDEN_HONORIFICS) {
    if (ja.includes(word)) {
      issues.push(`forbidden-honorific: contains "${word}"`);
    }
  }

  // 2. Bad transliterations
  for (const word of BAD_TRANSLITERATIONS) {
    if (ja.includes(word)) {
      issues.push(
        `bad-transliteration: contains "${word}" — brand names must stay literal`,
      );
    }
  }

  // 3. Voice consistency: detect だ/である at sentence-end (ですます expected)
  // Allow inside code fences and inline code. Strip those first.
  const stripped = ja
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]+`/g, "");
  // Sentence-ending だ。/である。 patterns are voice mixes. ですます endings
  // legitimately end with です。/ます。/ません。/ました。 — those don't trigger.
  // Watch for だ。 at sentence end (but not "ません" / "じゃない" / "りだ" word
  // breaks; we're conservative — only flag standalone "である。" since "だ" is
  // common in noun compounds like "ただ" / "まだ").
  const dearuMatches = stripped.match(/である[。、]/g) ?? [];
  if (dearuMatches.length > 0) {
    issues.push(
      `voice-mix: ${dearuMatches.length} occurrence(s) of "である" — ですます form expected`,
    );
  }

  // 4. MDX shortcode preservation parity with EN
  if (en) {
    const enCounts = countShortcodes(en);
    const jaCounts = countShortcodes(ja);
    const allTags = new Set([
      ...Object.keys(enCounts),
      ...Object.keys(jaCounts),
    ]);
    for (const tag of allTags) {
      const enN = enCounts[tag] || 0;
      const jaN = jaCounts[tag] || 0;
      if (enN !== jaN) {
        issues.push(
          `shortcode-mismatch: <${tag}> appears ${enN}x in EN, ${jaN}x in JA`,
        );
      }
    }

    // 5. Code block parity (fenced + inline)
    const enCode = extractCodeBlockSpans(en);
    const jaCode = extractCodeBlockSpans(ja);
    if (enCode.fenceCount !== jaCode.fenceCount) {
      issues.push(
        `code-fence-mismatch: ${enCode.fenceCount} fences in EN, ${jaCode.fenceCount} in JA`,
      );
    }
    // Allow JA to have ±20% inline code count (translation may inline a
    // brand name as plain text where EN had it as inline code, etc.).
    const inlineDelta = Math.abs(enCode.inlineCount - jaCode.inlineCount);
    if (
      inlineDelta > Math.max(3, Math.ceil(enCode.inlineCount * 0.2))
    ) {
      issues.push(
        `inline-code-mismatch: ${enCode.inlineCount} inline-code spans in EN, ${jaCode.inlineCount} in JA (delta ${inlineDelta})`,
      );
    }

    // 6. Link URL preservation: every URL in EN should appear in JA verbatim
    const enLinks = extractLinks(en);
    const jaUrls = new Set(extractLinks(ja).map((l) => l.url));
    const missingUrls = enLinks
      .filter((l) => !jaUrls.has(l.url))
      .map((l) => l.url);
    if (missingUrls.length > 0) {
      issues.push(
        `link-url-missing: ${missingUrls.length} EN URL(s) not in JA: ${missingUrls.slice(0, 3).join(", ")}${missingUrls.length > 3 ? "…" : ""}`,
      );
    }
  }

  // 7. Brand presence: every brand named in EN should appear literally in JA
  if (en) {
    for (const brand of BRANDS_LITERAL) {
      const enHits = (en.match(new RegExp(`\\b${escapeRegex(brand)}\\b`, "g")) ?? []).length;
      const jaHits = (ja.match(new RegExp(`\\b${escapeRegex(brand)}\\b`, "g")) ?? []).length;
      if (enHits > 0 && jaHits === 0) {
        issues.push(
          `brand-missing: "${brand}" appears ${enHits}x in EN, 0x in JA — must stay literal`,
        );
      }
    }
  }

  // 8. Half-width punctuation in pure-JA sentences (heuristic): scan for ", " or
  // ". " surrounded by JA characters with no English brand name. Skipped — too
  // many false positives without a real tokenizer.

  return issues;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function main() {
  const allFiles = ROOTS.flatMap(listFiles);
  if (allFiles.length === 0) {
    console.log("No JA MDX files found.");
    process.exit(0);
  }

  let totalIssues = 0;
  const filesWithIssues = [];
  for (const file of allFiles) {
    const issues = audit(file);
    const rel = path.relative(REPO, file);
    if (issues.length > 0) {
      filesWithIssues.push({ rel, issues });
      totalIssues += issues.length;
    }
  }

  if (totalIssues === 0) {
    console.log(
      `JA quality audit: ${allFiles.length} file(s) scanned. 0 issues.`,
    );
    process.exit(0);
  }

  console.log(
    `JA quality audit: ${allFiles.length} file(s) scanned. ${totalIssues} issue(s) across ${filesWithIssues.length} file(s).\n`,
  );
  for (const { rel, issues } of filesWithIssues) {
    console.log(`${rel}`);
    for (const issue of issues) {
      console.log(`  - ${issue}`);
    }
    console.log("");
  }
  process.exit(1);
}

main();
