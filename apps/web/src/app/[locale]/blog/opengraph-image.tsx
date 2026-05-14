import { ogImageResponse, OG_SIZE, OG_CONTENT_TYPE } from "@/components/og/template";
import { loadOgStrings } from "@/lib/og-strings";
import type { Locale } from "@ellul.ai/i18n-consts";

export const alt = "ellul blog: agents, workstations, and the laptop problem";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default async function OpengraphImage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const og = await loadOgStrings(locale as Locale, "blog");
  return ogImageResponse({
    title: og.title ?? "",
    highlight: og.highlight,
    eyebrow: og.eyebrow,
    subtitle: og.subtitle,
    locale: locale as Locale,
  });
}
