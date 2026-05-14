# @ellul.ai/i18n-consts

Locale primitives shared across every ellul surface — zero runtime dependencies, no React, no Next.js. Safe to import from any package, including backend services.

## Exports

| Subpath | Module |
|---|---|
| `.` | re-exports everything below |
| `./locales` | `Locale` type, `ALL_LOCALES`, `DEFAULT_LOCALE`, `LOCALES_TO_TRANSLATE`, `LOCALE_DISPLAY`, `OG_LOCALE`, `RTL_LOCALES`, `isRtlLocale`, `isLocale`, `coerceLocale` |
| `./surfaces` | `Surface` type, `SURFACES`, `PUBLIC_SURFACES`, `isSurface`, `isPublicSurface` |
| `./indexability` | `INDEXABLE_LOCALES_BY_SURFACE`, `isIndexableLocale`, `NOINDEX_PATH_PATTERNS`, `isNoIndexPath` |
| `./markets` | `PRIORITY_LOCALES`, `GHOST_LOCALES`, `FOOTER_MARKET_LINKS`, `isPriorityLocale`, `isGhostLocale` |

## Usage

```ts
import { ALL_LOCALES, type Locale } from "@ellul.ai/i18n-consts";
import { isIndexableLocale } from "@ellul.ai/i18n-consts/indexability";
import { isPriorityLocale } from "@ellul.ai/i18n-consts/markets";

if (isIndexableLocale("web", locale)) {
  // emit hreflang, allow indexing
}
```

## When to edit this package

- **Adding a locale** — append to `ALL_LOCALES` in `locales.ts` and to `LOCALE_DISPLAY` and `OG_LOCALE`. Then register it in `INDEXABLE_LOCALES_BY_SURFACE` (the `web` set, gated until QA passes).
- **Adding a surface** — append to `SURFACES` and `INDEXABLE_LOCALES_BY_SURFACE` (with empty set if private). Decide whether it goes in `PUBLIC_SURFACES`.
- **Adding a hreflang-only ghost locale** — append to `GHOST_LOCALES` in `markets.ts`.

For full multi-surface translation workflow, see [`@ellul.ai/i18n-messages/TRANSLATIONS.md`](../i18n-messages/TRANSLATIONS.md).
