// SPDX-License-Identifier: MIT

import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { useTranslations } from "next-intl";

export async function generateMetadata() {
  const t = await getTranslations("console.terms");
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
  };
}

interface TermBullet {
  term: string;
  body: string;
}

interface EmphasisBullet {
  emphasis: string;
  body: string;
}

export default function TermsPage() {
  const t = useTranslations("console.terms");

  const descriptionBullets = t.raw("sections.description.bullets") as string[];
  const acceptableBullets = t.raw(
    "sections.acceptableUse.bullets"
  ) as TermBullet[];
  const responsibilitiesBullets = t.raw(
    "sections.responsibilities.bullets"
  ) as string[];
  const paymentBullets = t.raw("sections.payment.bullets") as string[];
  const terminationBullets = t.raw(
    "sections.termination.bullets"
  ) as EmphasisBullet[];
  const liabilityBullets = t.raw("sections.liability.bullets") as string[];

  return (
    <main className="min-h-screen py-16 px-6 relative">
      {/* Ambient gradient orbs */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden" style={{ zIndex: 0 }}>
        <div
          className="absolute -top-1/4 -left-1/4 w-[600px] h-[600px] rounded-full opacity-20"
          style={{
            background: "radial-gradient(circle, rgba(245,239,230,0.6) 0%, transparent 70%)",
            animation: "ambient-float 30s ease-in-out infinite",
          }}
        />
        <div
          className="absolute -bottom-1/4 -right-1/4 w-[500px] h-[500px] rounded-full opacity-15"
          style={{
            background: "radial-gradient(circle, rgba(240,166,90,0.4) 0%, transparent 70%)",
            animation: "ambient-float 40s ease-in-out infinite reverse",
          }}
        />
      </div>

      <div className="max-w-3xl mx-auto panel-ascente p-6 sm:p-10 relative z-10">
        <Link
          href="/"
          className="text-cream/60 hover:text-cream transition-colors text-sm mb-8 inline-block"
        >
          {t("backToHome")}
        </Link>

        <h1 className="text-4xl font-bold text-cream mb-2">{t("title")}</h1>
        <p className="text-cream/60 mb-12">{t("lastUpdated")}</p>

        <div className="prose prose-invert prose-zinc max-w-none">
          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-cream mb-4">
              {t("sections.acceptance.heading")}
            </h2>
            <p className="text-cream/60 leading-relaxed">
              {(t.raw("sections.acceptance.paragraphs") as string[])[0]}
            </p>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-cream mb-4">
              {t("sections.description.heading")}
            </h2>
            <p className="text-cream/60 leading-relaxed mb-4">
              {t("sections.description.intro")}
            </p>
            <ul className="list-disc list-inside text-cream/60 space-y-2 ml-4">
              {descriptionBullets.map((bullet, idx) => (
                <li key={idx}>{bullet}</li>
              ))}
            </ul>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-cream mb-4">
              {t("sections.acceptableUse.heading")}
            </h2>
            <p className="text-cream/60 leading-relaxed mb-4">
              {t("sections.acceptableUse.introBefore")}
              <strong className="text-terra">
                {t("sections.acceptableUse.introEmphasis")}
              </strong>
              {t("sections.acceptableUse.introAfter")}
            </p>

            <div className="bg-terra/10 border border-terra/20 rounded-lg p-6 mb-6">
              <h3 className="text-lg font-semibold text-terra mb-3">
                {t("sections.acceptableUse.prohibitedHeading")}
              </h3>
              <ul className="list-disc list-inside text-cream/60 space-y-2">
                {acceptableBullets.map((bullet, idx) => (
                  <li key={idx}>
                    <strong>{bullet.term}</strong>
                    {bullet.body}
                  </li>
                ))}
              </ul>
            </div>

            <p className="text-cream/60 leading-relaxed">
              {t("sections.acceptableUse.consequenceBefore")}
              <strong className="text-cream">
                {t("sections.acceptableUse.consequenceEmphasis")}
              </strong>
              {t("sections.acceptableUse.consequenceAfter")}
            </p>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-cream mb-4">
              {t("sections.responsibilities.heading")}
            </h2>
            <p className="text-cream/60 leading-relaxed mb-4">
              {t("sections.responsibilities.intro")}
            </p>
            <ul className="list-disc list-inside text-cream/60 space-y-2 ml-4">
              {responsibilitiesBullets.map((bullet, idx) => (
                <li key={idx}>{bullet}</li>
              ))}
            </ul>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-cream mb-4">
              {t("sections.payment.heading")}
            </h2>
            <p className="text-cream/60 leading-relaxed mb-4">
              {t("sections.payment.intro")}
            </p>
            <ul className="list-disc list-inside text-cream/60 space-y-2 ml-4">
              {paymentBullets.map((bullet, idx) => (
                <li key={idx}>{bullet}</li>
              ))}
            </ul>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-cream mb-4">
              {t("sections.termination.heading")}
            </h2>
            <p className="text-cream/60 leading-relaxed mb-4">
              {t("sections.termination.intro")}
            </p>
            <ul className="list-disc list-inside text-cream/60 space-y-2 ml-4">
              {terminationBullets.map((bullet, idx) => (
                <li key={idx}>
                  <strong>{bullet.emphasis}</strong>
                  {bullet.body}
                </li>
              ))}
            </ul>
            <p className="text-cream/60 leading-relaxed mt-4">
              {t("sections.termination.outro")}
            </p>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-cream mb-4">
              {t("sections.infrastructure.heading")}
            </h2>
            <p className="text-cream/60 leading-relaxed">
              {(t.raw("sections.infrastructure.paragraphs") as string[])[0]}
            </p>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-cream mb-4">
              {t("sections.liability.heading")}
            </h2>
            <div className="bg-secondary/50 border border-border rounded-lg p-6">
              <p className="text-cream/60 leading-relaxed mb-4">
                {t("sections.liability.intro")}
              </p>
              <ul className="list-disc list-inside text-cream/60 space-y-2">
                {liabilityBullets.map((bullet, idx) => (
                  <li key={idx}>{bullet}</li>
                ))}
              </ul>
            </div>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-cream mb-4">
              {t("sections.indemnification.heading")}
            </h2>
            <p className="text-cream/60 leading-relaxed">
              {(t.raw("sections.indemnification.paragraphs") as string[])[0]}
            </p>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-cream mb-4">
              {t("sections.law.heading")}
            </h2>
            <p className="text-cream/60 leading-relaxed">
              {(t.raw("sections.law.paragraphs") as string[])[0]}
            </p>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-cream mb-4">
              {t("sections.contact.heading")}
            </h2>
            <p className="text-cream/60 leading-relaxed">
              {t("sections.contact.intro")}
              <a
                href="mailto:legal@ellul.ai"
                className="text-sodium hover:text-sodium"
              >
                legal@ellul.ai
              </a>
            </p>
          </section>
        </div>

        <div className="mt-16 pt-8 border-t border-border">
          <div className="flex gap-6 text-sm text-cream/60">
            <Link href="/privacy" className="hover:text-cream transition-colors">
              {t("footer.privacy")}
            </Link>
            <Link href="/" className="hover:text-cream transition-colors">
              {t("footer.home")}
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
