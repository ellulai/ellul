# Translation prompt for ellul

Run via Claude Opus 4.7 Max in Claude Code on the founder's workstation.

The pipeline has two output modes:

| Mode | Source | Output | Used by |
|---|---|---|---|
| **JSON** | `messages/<namespace>/en.json` or `apps/<surface>/messages/en.json` | matching `<locale>.json` | UI strings — every surface (`web`, `console`, `vps-ui`, `docs` chrome) |
| **MDX**  | `apps/docs/src/content/en/**/*.mdx` | matching `apps/docs/src/content/<locale>/**/*.mdx` | Docs prose content (markdown bodies) |

Use the JSON mode for everything except docs content. JSON mode below; MDX
mode at the bottom.

## Inputs

- The canonical English file (JSON or MDX).
- `packages/i18n-messages/scripts/glossary.json` — terms that stay literal English.
- `docs/strategy/marketing.md` — voice rules (founder-direct, never corporate-formal).
- `docs/seo/ENTERPRISE-SEO-GEO-PLAYBOOK.md` Part IX §43.5 — per-locale watch-outs.

## JSON mode prompt

```
You are translating UI strings for ellul, an always-on workstation for
AI agents. Translate the source JSON below into {LOCALE_NAME} ({LOCALE_CODE}).

Output a single JSON file with the EXACT same key tree as the source. Same
nesting, same key names. Translate values only.

# Hard rules — violating any of these breaks the build

1. JSON keys are NEVER translated. Only values.
2. Same key tree, same nesting, same array shapes. No keys added or removed.
3. ICU placeholders like `{year}`, `{price}`, `{count}` MUST be preserved
   byte-for-byte. Do not translate the variable name; do not move it outside
   the wrapping tag.
4. Rich-text tags like `<emphasis>...</emphasis>` and `<strong>...</strong>`
   MUST be preserved with the same tag names. Translate the text inside the
   tags. The wrapping tag stays exactly as-is.
5. Glossary terms (see `packages/i18n-messages/scripts/glossary.json`) MUST
   stay in their original form. Do not transliterate (no katakana for
   `Cursor`, no Hangul for `Claude Code`, no Cyrillic for `passkey`).

   **Brand-vs-concept distinction.** A capital letter does not by itself
   make a term "brand". Translate conceptual descriptors that happen to
   capitalize for emphasis or section-heading style. Stay literal only on
   actual coined product/component names listed in the glossary.

   - `Sovereign Shield` (coined component) → keep literal
   - `Shield Gateway` (coined product tier) → keep literal
   - `Ellul Cloud` (coined product) → keep literal
   - `Sovereign Model` (concept page name in docs) → translate
   - `Cloud Platform` (descriptive section label) → translate
   - `Tier Comparison`, `Security Whitepaper`, `Hobby`, `Pro` → translate

   When in doubt: if it's not in the glossary, translate it.
6. Code-shaped values stay literal: branch names (`fix/race-condition-checkout`),
   file paths (`/api/orders`), HH:MM timestamps (`23:42`), PR numbers (`PR #847`),
   command labels (`git push`, `db write`, `secret read`, `domain change`,
   `policy update`, `deploy`), agent log labels (`checkout`, `docs`, `ellul`),
   spec values (`8 hr`, `3+`, `0`, `5 min`, `30 sec`, `Session`), brand-wrapped
   pricing (`$20`, `$50`).
7. Output must be valid JSON. Test with `JSON.parse()` before returning.
8. Output ONLY the JSON. No prose, no explanation, no code fence.

# Voice rules — break these and the brand reads as machine-translated

- Founder-direct, opinionated, short sentences. Treat the reader as a peer.
- NEVER corporate-formal. Specifically:
  - JP: NO お客様 / 弊社 / 御社. Use あなた / 私たち / Ellul.
  - KR: NO 고객님 / 저희 회사. Use 당신 / 저희 / Ellul.
  - DE: du form for marketing copy. NOT Sie.
  - FR: tu form for marketing copy.
  - pt-BR: você (informal-default Brazilian style). NOT senhor/senhora.
- Match the headline rhythm. EN headlines are short fragments
  ("Close your laptop. / Your agent keeps working."). Keep the cadence.
- Preserve the metaphor — agent's computer / off your laptop. If the literal
  metaphor doesn't carry, rewrite the sentence around the SAME idea, don't
  paste a literal translation.
- Lead with autonomy. Never lead with security. (Per MARKETING.md §3.)

# Per-locale guidance

## ja (Japanese)
- ですます form throughout. Do NOT mix with だ/である. Mixing reads as
  machine-translated and damages brand trust on the first paragraph
  (playbook §43.5).
- Founder voice means: write like a senior engineer talking to another senior
  engineer at a meetup. Confident, direct, opinionated. NOT 営業っぽい.
- Punctuation: full-width 。、 inside Japanese sentences; half-width
  punctuation around English brand names. e.g., "Cursor、Claude Code、
  Copilot。"
- Spec/tech labels (RAM, CPU, Disk, Transfer) — keep English. They render
  natively in JP tech context.
- Numbers/units: "8 hr" → "8時間"; "5 min" → "5分"; "30 sec" → "30秒";
  "Session" → "セッション中". "$20" / "$50" stay as-is (USD only at launch
  per playbook §49.5).
- Tier names: "Hobby" → "個人"; "Pro" → "プロ"; "Cloud Platform" →
  "クラウドプラットフォーム" (per established convention in
  `packages/i18n-messages/messages/tier/ja.json`).

## ko (Korean)
- -습니다/-입니다 (polite) throughout. Don't mix with -아/-야.
- Founder-direct, no 고객님 / 회원님. Address as 당신 or skip the pronoun.

## de (German)
- du form, lowercase, for marketing copy.
- Capitalize all nouns (German rule).
- Compound nouns: keep readable.

## pt-BR (Brazilian Portuguese)
- Brazilian, NOT European. Use ç, ã, õ. Use você (not tu).
- Tone: warm-direct. Brazilians read informal-engineering copy as friendly.

## fr (French)
- tu form for marketing copy.
- Use « » for quotes, ’ for the apostrophe.
- Don't over-formalize.

# Source

{SOURCE_JSON}
```

## MDX mode prompt (docs content)

```
You are translating documentation prose for ellul. The source is an MDX
file with YAML frontmatter and a markdown body. Translate the body and the
human-facing frontmatter fields ({title}, {description}) into {LOCALE_NAME}
({LOCALE_CODE}).

# Hard rules

1. **Frontmatter fields**:
   - `title`, `description` — translate.
   - `section`, `order`, any other identifier-like fields — keep literal.
   - Field NAMES never change.
2. **Markdown structure preserved**: same heading depth, same list shape,
   same code fence languages, same link targets.
3. **Code blocks**: NEVER translate code inside fenced blocks (```ts, ```bash, …).
   Translate the prose around them.
4. **Inline code** (`like this`): keep literal. Translate the surrounding sentence.
5. **Links**: translate visible link text; keep the URL exactly.
6. **MDX components** (`<Callout>`, `<Step>`, `<FaqSection>`, etc.):
   keep tag names + attribute names exactly. Translate string children
   and the values of `title=` / `description=` / similar string props.
7. **Glossary terms** (`packages/i18n-messages/scripts/glossary.json`) stay
   literal English.
8. **Code-shaped values** stay literal: command labels, file paths, env
   var names, branch names, etc.
9. Output the FULL MDX file (frontmatter + body), not just the body.

# Voice rules — apply per the JSON mode prompt above.
# Per-locale guidance — apply per the JSON mode prompt above.

# Source

{SOURCE_MDX}
```

## After running (JSON mode)

1. Save output to the matching path:
   - Common namespaces: `packages/i18n-messages/messages/<namespace>/<locale>.json`
   - Per-surface: `apps/<surface>/messages/<locale>.json` or
     `packages/<surface>/messages/<locale>.json`
2. Validate JSON parse:
   ```
   node -e "JSON.parse(require('fs').readFileSync('<path>','utf8'))"
   ```
3. Run the package validator (key-tree parity):
   ```
   pnpm --filter @ellul.ai/i18n-messages validate
   ```
4. Per-surface, run the surface's validator (provided by
   `@ellul.ai/i18n-messages/scripts/validate-key-trees.mjs`):
   ```
   node packages/i18n-messages/scripts/validate-key-trees.mjs --surface <surface>
   ```
5. Native QA gate (Playbook §43.5):
   - **ja, ko**: native QA on web's `/` and `/pricing` (~$60–100 per locale).
   - **de, pt-BR, fr**: skip native QA — Claude Opus quality is sufficient.
6. While ja/ko await QA: ensure the locale is OUT of
   `INDEXABLE_LOCALES_BY_SURFACE.web` in
   `@ellul.ai/i18n-consts/src/indexability.ts`. Routes still resolve and
   render the locale, but robots noindex-follow + no hreflang alternate
   prevents premature indexing of unreviewed copy.
7. After QA passes: re-add the locale to its surface's set, redeploy, and
   submit the locale's sitemap to its Search Console property.

## After running (MDX mode)

1. Save output to `apps/docs/src/content/<locale>/<same-relative-path>.mdx`.
2. Build the docs surface and visit `/<locale>/<slug>` to confirm rendering.
3. Same indexability gate applies — `INDEXABLE_LOCALES_BY_SURFACE.docs`
   in `@ellul.ai/i18n-consts/src/indexability.ts`.
