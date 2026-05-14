// SPDX-License-Identifier: MIT

import createIntlMiddleware from "next-intl/middleware";
import { wrapI18nMiddleware } from "@ellul.ai/i18n/middleware";
import { routing } from "@/i18n/routing";

export default wrapI18nMiddleware(createIntlMiddleware(routing));

// Matcher is inlined (not imported) because Next 15.5+ requires the value
// to be statically resolvable at build time. Mirrors I18N_MIDDLEWARE_MATCHER
// in @ellul.ai/i18n/middleware — keep these in sync.
export const config = {
  matcher: [
    "/((?!api/.*|_next/static|_next/image|.*\\.(?:svg|png|jpg|jpeg|gif|ico|webp|woff2?|txt|xml)$).*)",
  ],
};
