// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { type NextMiddleware, type NextRequest, NextResponse } from "next/server";

// Mirror of the static-asset extensions in I18N_MIDDLEWARE_MATCHER below.
// Routes like /vs/{slug}/raw.md SHOULD flow through the locale rewrite (so
// `/vs/devin/raw.md` gets rewritten to `/en/vs/devin/raw.md`), so we can't
// skip every path containing a dot — only true file-extension assets.
const STATIC_ASSET_EXT =
  /\.(?:svg|png|jpg|jpeg|gif|ico|webp|woff2?|txt|xml|json|map)$/i;

function shouldSkip(pathname: string): boolean {
  return (
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/api/") ||
    pathname === "/robots.txt" ||
    pathname === "/sitemap.xml" ||
    pathname.startsWith("/sitemaps/") ||
    STATIC_ASSET_EXT.test(pathname)
  );
}

export function wrapI18nMiddleware(intl: NextMiddleware): NextMiddleware {
  return async function middleware(request: NextRequest, event) {
    if (shouldSkip(request.nextUrl.pathname)) return NextResponse.next();
    const response = await intl(request, event);
    if (response instanceof NextResponse || response instanceof Response) {
      response.headers.set("Vary", "Accept-Language, Cookie");
    }
    return response;
  };
}

export const I18N_MIDDLEWARE_MATCHER = [
  "/((?!api/.*|_next/static|_next/image|.*\\.(?:svg|png|jpg|jpeg|gif|ico|webp|woff2?|txt|xml)$).*)",
] as const;
