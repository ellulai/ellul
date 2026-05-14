import {
  ogImageResponse,
  OG_SIZE,
  OG_CONTENT_TYPE,
} from "@/components/og/template";
import { ALL_LOCALES, type Locale } from "@ellul.ai/i18n-consts";
import {
  getGlossaryTerm,
  listGlossarySlugs,
} from "@/content/glossary/loader";

export const dynamic = "force-static";
export const alt = "ellul glossary term";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export function generateStaticParams() {
  const slugs = listGlossarySlugs();
  return ALL_LOCALES.flatMap((locale) =>
    slugs.map((slug) => ({ locale, slug })),
  );
}

export default async function OpengraphImage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  const term = await getGlossaryTerm(slug, locale as Locale);
  return ogImageResponse({
    title: term?.term ?? "Glossary",
    eyebrow: "Glossary · ellul",
    subtitle: term?.definition.slice(0, 200) ?? "ellul glossary term",
    locale: locale as Locale,
  });
}
