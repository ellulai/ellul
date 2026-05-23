// SPDX-License-Identifier: MIT

import { type NextFetchEvent, type NextRequest, NextResponse } from "next/server";
import createIntlMiddleware from "next-intl/middleware";
import { wrapI18nMiddleware } from "@ellul.ai/i18n/middleware";
import { routing } from "@/i18n/routing";

const VPS_PATH_RE = /^\/((_auth|browser|_term|term|terminal|agent)(\/|$)|code-ws$|ws$|health$|vps-config\.js$)/;

const PROXY_PORT = process.env.LOCAL_PROXY_PORT;
const JWT_SECRET = process.env.LIMA_JWT_SECRET;

let cachedJwt: { token: string; exp: number } | null = null;

function b64url(data: Uint8Array): string {
  let s = "";
  for (const b of data) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getJwt(): Promise<string | null> {
  if (!JWT_SECRET) return null;
  const now = Math.floor(Date.now() / 1000);
  if (cachedJwt && cachedJwt.exp > now + 60) return cachedJwt.token;
  const enc = new TextEncoder();
  const header = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = b64url(enc.encode(JSON.stringify({
    sub: "local-dev", jti: `mw-${now}`, iat: now, exp: now + 86400,
  })));
  const key = await crypto.subtle.importKey("raw", enc.encode(JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${header}.${payload}`))));
  const token = `${header}.${payload}.${sig}`;
  cachedJwt = { token, exp: now + 86400 };
  return token;
}

const intlMiddleware = wrapI18nMiddleware(createIntlMiddleware(routing));

export default async function middleware(request: NextRequest, event: NextFetchEvent) {
  if (PROXY_PORT && VPS_PATH_RE.test(request.nextUrl.pathname)) {
    const jwt = await getJwt();
    if (jwt) {
      const headers = new Headers(request.headers);
      headers.set("authorization", `Bearer ${jwt}`);
      return NextResponse.next({ request: { headers } });
    }
  }
  return intlMiddleware(request, event);
}

// Matcher is inlined (not imported) because Next 15.5+ requires the value
// to be statically resolvable at build time. Mirrors I18N_MIDDLEWARE_MATCHER
// in @ellul.ai/i18n/middleware; keep these in sync.
export const config = {
  matcher: [
    "/((?!api/.*|srv/.*|vps-proxy/.*|auth-proxy/.*|_next/static|_next/image|.*\\.(?:svg|png|jpg|jpeg|gif|ico|webp|woff2?|txt|xml)$).*)",
  ],
};
