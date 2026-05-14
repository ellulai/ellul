import { notFound } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import { ALL_LOCALES, type Locale } from "@ellul.ai/i18n-consts";
import { Link } from "@/i18n/routing";
import { getDocsBySection } from "@/lib/docs";
import { Hero } from "@/components/Hero";

interface PageProps {
  params: Promise<{ locale: string }>;
}

export default async function DocsHome({ params }: PageProps) {
  const { locale: rawLocale } = await params;
  if (!ALL_LOCALES.includes(rawLocale as Locale)) notFound();
  const locale = rawLocale as Locale;
  setRequestLocale(locale);

  const sections = getDocsBySection(locale);

  return (
    <div>
      {/* Hero sits directly on the yellow casing — no container */}
      <Hero />

      {/* Doc listing inside a purple bonded panel */}
      <div className="mx-4 mb-4 panel-ascente p-5 sm:p-8 lg:mx-0">
        <div className="mx-auto max-w-3xl">
          <div className="space-y-8 sm:space-y-10">
            {Object.entries(sections).map(([section, docs]) => (
              <div key={section}>
                <h2 className="text-xs font-semibold tracking-tight text-sodium">
                  {section}
                </h2>
                <ul className="mt-3 divide-y divide-[rgba(245, 239, 230, 0.07)]">
                  {docs.map((doc) => (
                    <li key={doc.slug}>
                      <Link
                        href={`/${doc.slug}`}
                        className="block py-3 text-cream/75 transition-colors hover:text-sodium"
                      >
                        <span className="font-medium text-cream">
                          {doc.title}
                        </span>
                        {doc.description && (
                          <span className="mt-0.5 block text-sm text-cream/60">
                            {doc.description}
                          </span>
                        )}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
