# @ellul.ai/i18n

Framework integration for i18n. Wraps `next-intl` (Next.js surfaces) and `use-intl` (Vite/non-Next React surfaces) so every consumer imports from a single place with consistent conventions.

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│ @ellul.ai/i18n                                                     │
│ ─────────────────────                                              │
│  routing.ts   createI18nRouting() — defineRouting + Link/redirect  │
│  request.ts   createRequestConfig({ surface, loadMessages })       │
│               CDN-first → bundled centralized tree → fallback EN   │
│  server.ts    re-exports from next-intl/server                     │
│  client.ts    re-exports from use-intl (works in any React)        │
└────────────────────────────────────────────────────────────────────┘
                       ▲                          ▲
                       │                          │
       ┌───────────────┴────────────┐  ┌──────────┴──────────────────┐
       │ @ellul.ai/i18n-consts      │  │ @ellul.ai/i18n-messages     │
       │ Locale, ALL_LOCALES,       │  │ messages/<locale>/*.json    │
       │ INDEXABLE_LOCALES_BY_…,    │  │ messages/<locale>/index.ts  │
       │ priority markets, surfaces │  │ scripts/{glossary, prompt,  │
       │                            │  │   validate-key-trees}       │
       └────────────────────────────┘  └─────────────────────────────┘
```

Each consumer surface adds a thin `i18n/{routing,request}.ts` that calls these factories. Apps do NOT have their own messages directories — every translatable string lives in `@ellul.ai/i18n-messages`.

## Exports

| Subpath | Use from |
|---|---|
| `.` | factories + types |
| `./routing` | Next surfaces — routing factory |
| `./request` | Next surfaces — getRequestConfig factory |
| `./server` | Next Server Components |
| `./client` | Next Client Components OR non-Next React (Vite) |

## Setting up a Next surface

```ts
// apps/<surface>/src/i18n/routing.ts
import { createI18nRouting } from "@ellul.ai/i18n/routing";

const r = createI18nRouting();
export const routing = r.routing;
export const { Link, redirect, permanentRedirect, usePathname, useRouter, getPathname } = r.navigation;
export const notFound = r.notFound;
```

```ts
// apps/<surface>/src/i18n/request.ts
import { createRequestConfig } from "@ellul.ai/i18n/request";
import type { Locale } from "@ellul.ai/i18n-consts";

const loaders: Record<Locale, () => Promise<Record<string, unknown>>> = {
  en: async () => (await import("@ellul.ai/i18n-messages/messages/en")).default,
  ja: async () => (await import("@ellul.ai/i18n-messages/messages/ja")).default,
  // … one per locale
};

export default createRequestConfig({
  surface: "<surface-name>",
  loadMessages: (locale) => loaders[locale](),
});
```

```ts
// apps/<surface>/src/middleware.ts
import createIntlMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";

export default createIntlMiddleware(routing);

export const config = {
  matcher: [
    "/((?!api/.*|_next/static|_next/image|.*\\.(?:svg|png|jpg|jpeg|gif|ico|webp|woff2?|txt|xml)$).*)",
  ],
};
```

## Setting up a Vite/non-Next React surface

```tsx
// packages/vps-ui/src/i18n/IntlRoot.tsx
import { IntlProvider } from "@ellul.ai/i18n/client";
import messages from "@ellul.ai/i18n-messages/messages/en";

export function IntlRoot({ children }: { children: React.ReactNode }) {
  return (
    <IntlProvider locale="en" messages={messages}>
      {children}
    </IntlProvider>
  );
}
```

(Locale source for vps-ui is postMessage from the parent surface — see Phase 5c notes.)

## CDN delivery (later)

Set `TRANSLATIONS_CDN_URL` per surface and `createRequestConfig` will fetch
`${cdn}/${surface}/${locale}.json` first, falling back to bundled messages
on cache miss or fetch error. See [`@ellul.ai/i18n-messages/TRANSLATIONS.md`](../i18n-messages/TRANSLATIONS.md#loader-path) for the upload + revalidate steps.

## See also

- [`@ellul.ai/i18n-consts`](../i18n-consts) — locale primitives + indexability gates.
- [`@ellul.ai/i18n-messages`](../i18n-messages) — common messages + glossary + prompt + workflow doc.
