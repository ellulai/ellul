import { ogImageResponse, OG_SIZE, OG_CONTENT_TYPE } from "@/components/og/template";
import { ALL_LOCALES, type Locale } from "@ellul.ai/i18n-consts";
import enMessages from "@ellul.ai/i18n-messages/messages/en";
import jaMessages from "@ellul.ai/i18n-messages/messages/ja";

// alt is a single static export across all locales (Next.js limitation).
// Brand-anchored text works for every locale; per-locale image content is
// rendered inside the body via ogImageResponse.
export const alt = "ellul: Your agent’s computer";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

const MESSAGES_BY_LOCALE = {
  en: enMessages,
  ja: jaMessages,
} as const;

function pickMessages(locale: Locale) {
  return MESSAGES_BY_LOCALE[locale as keyof typeof MESSAGES_BY_LOCALE] ?? enMessages;
}

export default async function OpengraphImage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale = (ALL_LOCALES.includes(rawLocale as Locale) ? rawLocale : "en") as Locale;
  const m = pickMessages(locale);

  return ogImageResponse({
    title: m.home.cta.headlineLine1,
    highlight: m.home.cta.headlineLine2,
    eyebrow: m.home.hero.eyebrow,
    subtitle: m.home.hero.subhead,
    locale,
  });
}
