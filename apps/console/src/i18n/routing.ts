// SPDX-License-Identifier: MIT

import { createI18nRouting } from "@ellul.ai/i18n/routing";

const r = createI18nRouting();

export const routing = r.routing;
export const {
  Link,
  redirect,
  permanentRedirect,
  usePathname,
  useRouter,
  getPathname,
} = r.navigation;
export const notFound = r.notFound;
