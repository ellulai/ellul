import { ogImageResponse, OG_SIZE, OG_CONTENT_TYPE } from "@/components/og/template";
import { ALL_LOCALES, type Locale } from "@ellul.ai/i18n-consts";

export const dynamic = "force-static";
export const alt = "ellul documentation";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export function generateStaticParams() {
  return ALL_LOCALES.map((locale) => ({ locale }));
}

export default async function OpengraphImage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  return ogImageResponse({
    title: "Documentation.",
    eyebrow: "Docs · Ellul",
    subtitle: "Architecture, security model, sandbox primitives, agent integration.",
    locale: locale as Locale,
  });
}
