import { GET as localeGet } from "../../[locale]/blog/rss.xml/route";

export const dynamic = "force-static";

// /blog/rss.xml: unprefixed default-locale RSS. next-intl's middleware does
// not rewrite route handlers, so we expose the default locale's feed here
// directly. Other locales' feeds live at /<locale>/blog/rss.xml.
export async function GET(req: Request) {
  return localeGet(req, { params: Promise.resolve({ locale: "en" }) });
}
