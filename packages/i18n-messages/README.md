# @ellul.ai/i18n-messages

The single source of truth for all translatable UI strings across every ellul surface (web, console, vps-ui, docs UI chrome). Apps do not have their own messages files — they consume the centralized tree from this package.

## Layout

```
messages/
├── en/                 ← canonical locale
│   ├── auth.json       auth.{signIn, signUp, signOut, getStarted, continueWith, agreeTerms}
│   ├── brand.json      brand.{name, tagline, byline, copyright}
│   ├── common.json     common.{loading, …}
│   ├── console.json    console.meta.{title, description}
│   ├── footer.json     web marketing footer
│   ├── home.json       web homepage
│   ├── nav.json        web marketing nav
│   ├── pricing.json    web pricing page
│   ├── signIn.json     console sign-in page
│   ├── signUp.json     console sign-up page
│   ├── tier.json       Hobby/Pro names + descriptions + capacity
│   └── index.ts        ← aggregator: spreads all namespaces into one object
└── ja/                 ← Japanese (in progress, awaiting native QA on web)
    └── ... same shape

scripts/
├── glossary.json           terms that stay literal English
├── translate-prompt.md     Claude Opus 4.7 Max prompt template (JSON + MDX modes)
└── validate-key-trees.mjs  CI-friendly key-parity + ICU/tag preservation checker
```

## How surfaces consume

```ts
// apps/<surface>/src/i18n/request.ts
import { createRequestConfig } from "@ellul.ai/i18n/request";
import type { Locale } from "@ellul.ai/i18n-consts";

const loaders: Record<Locale, () => Promise<Record<string, unknown>>> = {
  en: async () => (await import("@ellul.ai/i18n-messages/messages/en")).default,
  ja: async () => (await import("@ellul.ai/i18n-messages/messages/ja")).default,
  ko: async () => (await import("@ellul.ai/i18n-messages/messages/en")).default, // until shipped
  // …
};

export default createRequestConfig({
  surface: "<surface-name>",
  loadMessages: (locale) => loaders[locale](),
});
```

Every surface gets the SAME tree (full namespace set). Each surface uses only the namespaces it touches via `useTranslations("home")`, `useTranslations("signIn")`, etc. Bundle impact is per-locale (~50–80 KB at current scale), well below the threshold where partition would matter.

## Adding a new namespace

1. Create `messages/en/<namespace>.json` with the canonical English keys.
2. Create the same file in every shipped locale (`ja`, …) with translated values.
3. Add it to each `<locale>/index.ts`:
   ```ts
   import myNs from "./my-namespace.json";
   const messages = { ...auth, ...brand, /* … */, ...myNs };
   ```
4. Run `pnpm --filter @ellul.ai/i18n-messages validate`.
5. Use it: `useTranslations("myNamespace")` from any surface.

## Adding a new locale

1. Add the locale code to `@ellul.ai/i18n-consts/src/locales.ts`.
2. Run the translation prompt (`scripts/translate-prompt.md`) via Claude Opus 4.7 Max with the canonical `en/*.json` files + `scripts/glossary.json` as inputs.
3. Save outputs into `messages/<locale>/<namespace>.json` (one per namespace, matching English).
4. Create `messages/<locale>/index.ts` mirroring `en/index.ts`.
5. Add the locale to the package's `exports` map (`./messages/<locale>` entry).
6. Add the locale's loader entry to each surface's `i18n/request.ts`.
7. Run `pnpm --filter @ellul.ai/i18n-messages validate` — must pass.
8. Confirm the locale is OUT of `INDEXABLE_LOCALES_BY_SURFACE.web` until any required native QA passes.

## Validate

```sh
pnpm --filter @ellul.ai/i18n-messages validate
```

Run from CI on every PR that touches `messages/**`. Exit code 1 on key-tree drift, ICU placeholder mismatch, or rich-text tag mismatch.

## See also

- [TRANSLATIONS.md](./TRANSLATIONS.md) — full multi-surface workflow.
- [`scripts/translate-prompt.md`](./scripts/translate-prompt.md) — the Claude Opus 4.7 Max prompt template.
- [`scripts/glossary.json`](./scripts/glossary.json) — the never-translate list.
- [`@ellul.ai/i18n-consts`](../i18n-consts) — locale primitives + indexability gates.
- [`@ellul.ai/i18n`](../i18n) — framework integration.
