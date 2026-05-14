# Translations workflow — multi-surface

Operational doc for translating ellul user-facing surfaces. Replaces the
per-surface `TRANSLATIONS.md` files in each app.

## Architecture

i18n is split across three workspace packages:

| Package | Role |
|---|---|
| [`@ellul.ai/i18n-consts`](../i18n-consts) | Locale primitives — `Locale` type, `ALL_LOCALES`, indexability gates, surface registry. Zero runtime deps. |
| [`@ellul.ai/i18n-messages`](.) (this package) | `common` namespace messages (brand, auth, tier), glossary, prompt, this workflow doc. The translation pipeline writes here. |
| [`@ellul.ai/i18n`](../i18n) | Framework integration — `createI18nRouting` (next-intl), `createRequestConfig` (CDN-first, EN bundled fallback), server/client re-exports. |

All translatable strings — every surface, every namespace — live in a
single centralized tree under `@ellul.ai/i18n-messages/messages/<locale>/`.
Apps do NOT have their own messages directories. Each app's
`i18n/request.ts` imports the centralized tree for the active locale.

| Surface | Indexable | Surface-owned namespaces (today) |
|---|---|---|
| `apps/web` | yes (gated per locale via `INDEXABLE_LOCALES_BY_SURFACE.web`) | `home`, `pricing`, `nav`, `footer` |
| `apps/console` | no (auth-walled) | `signIn`, `signUp`, `console` |
| `apps/docs` chrome | yes | (none yet) |
| `apps/docs` content | yes | per-locale MDX in `apps/docs/src/content/<locale>/`, not JSON |
| `packages/vps-ui` | no | (none yet) |

Cross-surface namespaces (`brand`, `auth`, `tier`, `common`) are owned by
no single surface and used everywhere. Every surface gets the full
namespace tree at runtime — surfaces use only the namespaces they touch
via `useTranslations("<namespace>")`. Bundle impact per locale is small
(~50–80 KB at current scale).

## Status

| Locale | Surfaces with translation | Native QA | Indexable (web) | Notes |
|---|---|---|---|---|
| en   | web, common | n/a | yes | canonical |
| ja   | web, common | ⏳ pending on web `/` + `/pricing` | **no** (gated until QA) | First non-English locale |
| ko   | not yet | — | no | Phase 5 (web) |
| de   | not yet | — | no | Phase 6 (web) |
| pt-BR | not yet | — | no | Phase 7 (web) |
| fr   | not yet | — | no | Phase 8 (web) |

## Loader path

Today: bundled per-locale tree (option A). `createRequestConfig` in
`@ellul.ai/i18n/request` first tries `TRANSLATIONS_CDN_URL` when set,
then falls back to the bundled centralized tree. Each surface
configures its own `loadMessages(locale)` callback that imports
`@ellul.ai/i18n-messages/messages/<locale>`.

To switch a surface to CDN delivery (option B) without code changes:

1. Build the per-surface CDN payload from the centralized tree:
   ```
   pnpm --filter @ellul.ai/i18n-messages build:cdn -- --surface web
   # or --surface all
   ```
   Outputs `packages/i18n-messages/dist/cdn/<surface>/<locale>.json` — the
   exact tree the bundled loader returns.
2. Upload to R2:
   ```
   wrangler r2 object put ellul-translations/<surface>/<locale>.json \
     --file=packages/i18n-messages/dist/cdn/<surface>/<locale>.json
   ```
3. Set the per-surface env in the surface's deploy env (preferred —
   lets surfaces switch independently):
   ```
   <SURFACE>_TRANSLATIONS_CDN_URL=https://assets.ellul.ai/locales
   ```
   e.g., `WEB_TRANSLATIONS_CDN_URL`, `CONSOLE_TRANSLATIONS_CDN_URL`.
   The factory falls back to the global `TRANSLATIONS_CDN_URL` if the
   surface-specific one isn't set.
4. After re-uploading, invalidate the cache tag:
   ```
   curl -X POST https://<surface>.ellul.ai/api/revalidate \
     -H "Authorization: Bearer $INTERNAL_API_SECRET" \
     -d '{"tag":"translations-<surface>-<locale>"}'
   ```

## Adding a new locale

1. Append the locale to `ALL_LOCALES`, `LOCALE_DISPLAY`, `OG_LOCALE` in
   [`@ellul.ai/i18n-consts/src/locales.ts`](../i18n-consts/src/locales.ts).
2. Run the translation prompt (`scripts/translate-prompt.md` in this
   package) via Claude Opus 4.7 Max in Claude Code. For each namespace
   file in `messages/en/`, generate the matching translated file at
   `messages/<locale>/<namespace>.json`. Inputs: the canonical English
   namespace JSON + `scripts/glossary.json`.
3. Create `messages/<locale>/index.ts` mirroring `messages/en/index.ts`.
4. Add the locale to this package's `exports` map (a `./messages/<locale>`
   entry) in `package.json`.
5. Add the locale's loader entry to every surface's
   `apps/<surface>/src/i18n/request.ts`:
   ```ts
   <locale>: async () => (await import("@ellul.ai/i18n-messages/messages/<locale>")).default,
   ```
6. Validate: `pnpm --filter @ellul.ai/i18n-messages validate` — must
   pass cleanly (key-tree parity, ICU placeholders, rich-text tags).
7. Confirm the locale is OUT of `INDEXABLE_LOCALES_BY_SURFACE.web` in
   `@ellul.ai/i18n-consts/src/indexability.ts` until any required native
   QA passes (see Playbook §43.5: ja and ko require QA on `/` + `/pricing`;
   de, pt-BR, fr skip QA).
8. Ship. After QA passes, add the locale to its surface's indexable set,
   redeploy, and submit the locale's sitemap to its Search Console
   property.

## Adding a new namespace

1. Create `messages/en/<namespace>.json` with the canonical keys.
2. Create the matching file in every shipped locale.
3. Add it to each `<locale>/index.ts` aggregator (import + spread).
4. Run `pnpm --filter @ellul.ai/i18n-messages validate`.
5. Use it: `useTranslations("<namespace>")` from any surface that needs it.

## Adding a new surface

1. Append to `SURFACES` in
   [`@ellul.ai/i18n-consts/src/surfaces.ts`](../i18n-consts/src/surfaces.ts).
2. Decide whether it goes in `PUBLIC_SURFACES` (search-indexable) or
   stays private.
3. Add an entry to `INDEXABLE_LOCALES_BY_SURFACE` in `indexability.ts`
   (empty set for private surfaces).
4. Wire the surface's request config:
   ```ts
   import { createRequestConfig } from "@ellul.ai/i18n/request";
   import type { Locale } from "@ellul.ai/i18n-consts";

   const loaders: Record<Locale, () => Promise<Record<string, unknown>>> = {
     en: async () => (await import("@ellul.ai/i18n-messages/messages/en")).default,
     ja: async () => (await import("@ellul.ai/i18n-messages/messages/ja")).default,
     // … one per locale
   };

   export default createRequestConfig({
     surface: "<surface>",
     loadMessages: (locale) => loaders[locale](),
   });
   ```
5. Update the status table above. Surface-owned namespaces (the new
   ones this surface introduces, e.g. `dashboard.*`) live alongside
   shared namespaces in the centralized tree — there are no per-surface
   message directories.

## Invariants — break these and the build/brand breaks

These are encoded in `scripts/translate-prompt.md` as hard rules. CI
(`pnpm --filter @ellul.ai/i18n-messages validate`) catches violations
before merge.

1. **Same key tree across locales** in every namespace and every surface.
2. **JSON keys are never translated.** Only values.
3. **ICU placeholders preserved byte-for-byte.** `{year}`, `{price}`,
   etc. The variable name never changes.
4. **Rich-text tag names preserved.** `<emphasis>...</emphasis>` and
   `<strong>...</strong>` keep the EN tag names. Translate inner text
   only.
5. **Glossary terms stay literal.** See `scripts/glossary.json`. No
   transliteration (no `カーソル` for `Cursor`).
6. **Code-shaped values stay literal.** Branch names, file paths,
   timestamps, gate names (`git push`, `db write`, …), agent log labels
   (`checkout`, `docs`, `ellul`), spec values.
7. **Output is a single JSON object.** No surrounding prose, no code
   fence.

## Voice rules per locale

These come from Playbook §43.5 + MARKETING.md §3.1. Failure to apply them
makes the page read as machine-translated, which damages brand on the
first paragraph (especially in JP/KR per playbook).

### ja (Japanese)
- ですます form. Never mix with だ/である.
- Founder-direct. Senior engineer talking to a peer at a meetup. Not 営業.
- Forbidden: お客様, 弊社, 御社. Use あなた / 私たち / Ellul.
- Punctuation: full-width 。、 inside Japanese sentences; keep half-width
  punctuation around English brand names.
- Spec/tech labels (RAM, CPU, Disk, Transfer): keep English.

### ko (Korean) — Phase 5
- -습니다/-입니다 polite form. No mixing with -아/-야.
- Forbidden: 고객님, 회원님, 저희 회사. Address as 당신 or omit.

### de (German) — Phase 6
- du form for marketing copy. Not Sie.
- Capitalize all nouns.
- Translate privacy + terms (DE is the one locale where this is required
  at launch, per Playbook §61).

### pt-BR (Brazilian Portuguese) — Phase 7
- Brazilian, not European.
- Use você (not tu, not o senhor / a senhora).

### fr (French) — Phase 8
- tu form for marketing copy.
- Use « » for quotes, ’ for the apostrophe.
- Translate privacy + terms (GDPR — same as DE).

## Indexability gate (the QA flow)

Until a public surface's `/` + `/pricing` (or surface-equivalent
landing pages) have passed native QA for a locale:

- The surface's `[locale]` route still resolves and renders that
  locale's translation (people who land directly on `/<locale>/` see it).
- `pageMetadata()` emits `robots: { index: false, follow: true }` for
  non-indexable (surface, locale) pairs.
- The locale is excluded from `<link rel="alternate" hreflang>` tags.
- The locale is excluded from `sitemap.xml`.

To enable indexing, add the locale to its surface's set in
[`@ellul.ai/i18n-consts/src/indexability.ts`](../i18n-consts/src/indexability.ts):

```ts
export const INDEXABLE_LOCALES_BY_SURFACE: Record<Surface, ReadonlySet<Locale>> = {
  web: new Set<Locale>([
    "en",
    "ja", // ← add after native QA passes
    // ...
  ]),
  // ...
};
```

Then redeploy and submit the locale's sitemap to its Search Console
property.

## Edits to canonical English

When `messages/<surface>/en.json` changes, every other locale's
translation drifts and re-translation is needed. Per Playbook §45 Step 5:

- Minor edit (typo, link): re-translate within 2 weeks.
- Material edit (new section, repositioning): immediate, all locales same
  day. Don't let pricing or positioning drift between EN and locales.

A `apps/web/scripts/check-translation-staleness.ts` (TBD) will compare
`git log -1` timestamps per file and flag drift > 14 days. Not yet wired.
