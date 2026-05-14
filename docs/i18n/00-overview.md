# Internationalization architecture

Code-verified against the repo on 2026-05-03. Update when the surfaces below change.

The translation pipeline is wider than the i18n packages. Five distinct surfaces consume locale-aware content; each has its own loader, build path, and "add a locale" cost. Forgetting one of them is the most common reason a locale ships partially.

## TL;DR — five consuming surfaces

| Surface | What renders | Source format | Loader |
| --- | --- | --- | --- |
| App UI (`apps/console`, `apps/web`, `packages/vps-ui`) | React components | `messages/<locale>/<namespace>.json` | next-intl `useTranslations()` |
| API server (`apps/api`) | Server-side validation, signup-locale detection, audit fields | `i18n-consts` whitelists + `messages/*.json` (bundled) | direct import |
| VPS shell scripts | MOTD, `/etc/environment` LANG mapping, locked-out HTML page | `messages/<locale>/vpsShell.json` | `i18n-messages/src/shell-strings.ts` emits bash `case` blocks at build |
| Agent-context templates | `CLAUDE.md`, `AGENTS.md`, `.cursor/rules/main.mdc` dropped into scaffolded sandboxes | Full markdown files: `agent-context/{agents,claude,cursor-rules}/<locale>.md` | tsup `static-text` esbuild plugin inlines as default-export strings |
| Long-form MDX | Blog posts, comparisons, glossary, agent profiles | `apps/web/src/content/<category>/<slug>/{en,ja}.mdx` + `meta.ts` | `apps/web` route handlers read directly; **not** routed through the i18n packages |

## The three i18n packages

### `@ellul.ai/i18n-consts`

Source-only package — no dist build, exports raw `.ts` from `package.json#exports`. Holds zero strings; only the locale **whitelist** and helpers everything else validates against.

| File | Exports |
| --- | --- |
| `src/locales.ts` | `ALL_LOCALES`, `DEFAULT_LOCALE`, `isLocale`, `isRtlLocale`, `GLIBC_LOCALE` map |
| `src/markets.ts` | Country/region metadata used by routing + SEO |
| `src/surfaces.ts` | Which surface a translation namespace belongs to |
| `src/indexability.ts` | SEO/robots flags per locale |

Because exports point to `.ts`, **every consumer that bundles** (apps/api, packages/vps) **must inline this package** — Node 20 cannot load `.ts` at runtime. See `apps/api/tsup.config.ts` and `packages/vps/tsup.config.ts` `noExternal` lists for `@ellul.ai/i18n-consts`, `@ellul.ai/i18n-messages`, `@ellul.ai/i18n`.

### `@ellul.ai/i18n`

Runtime helpers; the next-intl integration layer.

| File | Purpose |
| --- | --- |
| `src/routing.ts` | `createI18nRouting()` — defines `localePrefix: "as-needed"`, locale cookie attrs (`SameSite=lax`, `secure` in prod, 1-year `maxAge`), wires `next-intl/routing` + `next-intl/navigation` |
| `src/middleware.ts` | next-intl middleware factory used by `apps/console` + `apps/web` |
| `src/cookie.ts` | `LOCALE_COOKIE_NAME`, `writeLocaleCookie()`, `getLocaleCookieDomain()` |
| `src/client.ts` / `src/server.ts` / `src/request.ts` | Re-exports of next-intl client/server hooks scoped to ellul's routing |
| `src/metadata.ts` | Open-graph + alternate-link helpers for SEO |

### `@ellul.ai/i18n-messages`

The actual strings. 34 namespaces × N locales (currently `en`, `ja`).

```
messages/<locale>/
  agents.json    auth.json     authors.json    blog.json
  brand.json     chat.json     codeBrowser.json common.json
  comparisons.json  console.json   docs.json   faq.json
  footer.json    glossary.json home.json       index.ts
  isolationSpectrum.json  localeMismatch.json  mcp.json
  nav.json       og.json       pages.json      pillars.json
  pricing.json   privacy.json  promptEngineering.json
  signIn.json    signUp.json   terms.json      tier.json
  useCases.json  vpsShell.json webDocs.json    welcome.json
src/
  loaders.ts        — lazy load by locale (chunked at build time)
  shell-strings.ts  — emit bash case blocks from vpsShell.json
  overlay.ts        — per-environment string overrides
agent-context/
  agents/{en,ja}.md         — AGENTS.md template (Codex CLI / OpenCode)
  claude/{en,ja}.md         — CLAUDE.md template (Claude Code)
  cursor-rules/{en,ja}.md   — .cursor/rules/main.mdc template
  index.ts                  — TS module re-exporting markdown
__tests__/                  — JSON schema parity, shell-string round-trip
```

`vpsShell.json` is the only namespace whose values get baked into bash; every other namespace is consumed by JS/TS at runtime.

## Surface details

### App UI

next-intl integration. Each component declares a namespace via `useTranslations("console.frameworkPicker")` and reads keys with `t("categories.frontend")`. Routing is `localePrefix: "as-needed"` — the default locale renders without a path prefix (`/dashboard`), other locales are explicit (`/ja/dashboard`).

Post-auth redirect honors URL locale over the saved preference; only an explicit URL prefix updates `users.preferredLocale` (see `apps/console/src/lib/locale-redirect.ts` and the unit tests beside it). The `/api/me/preferences` endpoint validates against `ALL_LOCALES` and audit-logs every change.

### API server

`apps/api/src/security/auth/auth.ts` runs `resolveSignupLocale()` exactly once per user, inside the user-create transaction. The detection order is **URL path → Accept-Language → DEFAULT_LOCALE**. After that, only `PATCH /api/me/preferences` mutates the column. Sign-in does NOT touch `preferredLocale`.

Provisioning passes the snapshot to the VPS payload (`apps/api/src/provisioning/payload.ts` — `preferredLocale` field, baked into cloud-init), so the freshly provisioned box renders MOTD and locked-out pages in the user's language from boot.

### VPS shell scripts

`packages/i18n-messages/src/shell-strings.ts` exports `buildLocaleToGlibcCase()` and friends. At VPS package build time, these read every `messages/<locale>/vpsShell.json`, fold them into a single bash `case "$LOCALE" in en) ... ;; ja) ... ;; esac` block, and emit it into `motd.sh`, `directories.ts`, `locale.sh`, and the unauthorized HTML template.

Adding a locale to this surface requires **rebuilding and re-shipping the agent bundle** (`scripts/release.mjs` → core-runtime tarball). Existing VPSes pick up the new strings at the next manifest install.

### Agent-context templates

When a project is scaffolded, the user's current `preferredLocale` decides which markdown variant lands in the sandbox:

- `CLAUDE.md`  ← `agent-context/claude/<locale>.md`
- `AGENTS.md`  ← `agent-context/agents/<locale>.md`
- `.cursor/rules/main.mdc`  ← `agent-context/cursor-rules/<locale>.md`

Each template opens with `<!-- ellul:locale=<code> -->`. The toggle-mismatch detector reads `createdLocale` from `.ellul/project.json` and compares against the file's frontmatter; mismatch surfaces a banner rather than silently rewriting user-owned files.

`GEMINI.md` is intentionally absent (no Gemini integration shipped).

### Long-form MDX content

Lives in `apps/web/src/content/<category>/<slug>/`:

```
blog/agentic-coding/
  en.mdx
  ja.mdx
  meta.ts          — slug, author, tags, dates
```

Categories present: `blog`, `agents`, `authors`, `comparisons`, `glossary`, `mcp`, `pillars`, `use-cases`. Each piece is a paired `en.mdx` + `ja.mdx`. Routes in `apps/web/src/app/[locale]/...` resolve the right MDX based on the URL locale. **This content is not loaded through the i18n packages** — it lives in `apps/web` and is rendered by the route handler directly.

## Adding a third locale

Concrete checklist when introducing e.g. `de`:

1. **`packages/i18n-consts/src/locales.ts`** — extend `ALL_LOCALES`, add the `GLIBC_LOCALE` mapping (`de: "de_DE.UTF-8"`), add RTL/indexability flags.
2. **`packages/i18n-messages/messages/de/`** — drop a full set of all 34 JSON namespaces (mirror EN structure exactly; CI parity test will catch missing keys).
3. **`packages/i18n-messages/src/loaders.ts`** — register `de` in `messageLoaders` + `SHIPPED_LOCALES`.
4. **`packages/i18n-messages/agent-context/{agents,claude,cursor-rules}/de.md`** — three full markdown files.
5. **`apps/web/src/content/*/<slug>/de.mdx`** — one per piece across `blog`, `comparisons`, `glossary`, etc. Skip a slug only if you intentionally don't ship it for that locale.
6. **Rebuild + ship** — `pnpm release publish`. The VPS bash scripts re-emit with the new `case` arms; existing VPSes adopt at next manifest install.
7. **Per-locale operational artefacts** — see `docs/v2/seo/LOCALE-LAUNCH-CHECKLIST.md` for Search Console properties, hreflang validation, PostHog dashboards.

## Common failure modes

- **Cloud Build fails on `[vite] Rollup failed to resolve import "@ellul.ai/i18n-consts"`** → `Dockerfile` doesn't COPY the i18n packages into the builder context. Both builder *and* runtime stages need the workspace copy. Fixed in commit `d75d8ff6`.
- **Cloud Run container exits on `ERR_UNKNOWN_FILE_EXTENSION ".ts"`** → tsup externalized the i18n packages and Node 20 can't load `.ts` at runtime. Fix: add the three packages to `noExternal` in `apps/api/tsup.config.ts` AND `packages/vps/tsup.config.ts` (consumers transitively externalize). Fixed in commit `5a88f84f`.
- **User signs up on `/ja/sign-up`, lands on `/en/dashboard`** → the post-auth redirect was reading `user.preferredLocale` (DB) and ignoring URL. Fixed in `apps/console/src/lib/locale-redirect.ts` (commit `03efdc48`); URL with explicit locale prefix wins and the saved preference is updated, URL with no prefix preserves the saved preference unchanged.
- **JA wizard shows English `Back`/`Continue`** → keys exist in `console.onboarding.buttons.*` but the component hardcoded the English string. Recurring class of bug; sweep documented in commit `13017dba`.

## Cross-references

- `docs/v2/seo/LOCALE-LAUNCH-CHECKLIST.md` — operational checklist for shipping a new locale (search engines, analytics, dashboards).
- `docs/v2/seo/LEGAL-TRANSLATION-STATUS.md` — status of legal-page translations (privacy, terms).
- `apps/console/src/lib/locale-redirect.ts` — post-auth redirect decision logic + tests.
- `apps/api/src/routes/me.ts` — `/api/me/preferences` endpoint, the only surface that mutates `users.preferredLocale` after user creation.
- `apps/api/src/security/auth/auth.ts` — sign-up-time locale resolution (`resolveSignupLocale`), better-auth `additionalFields.preferredLocale` config.
- `packages/i18n-messages/src/shell-strings.ts` — VPS shell emission.
- `packages/i18n-messages/agent-context/index.ts` — agent-context delivery.
