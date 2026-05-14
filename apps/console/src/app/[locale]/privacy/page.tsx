// SPDX-License-Identifier: MIT

import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { useTranslations } from "next-intl";

export async function generateMetadata() {
  const t = await getTranslations("console.privacy");
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
  };
}

interface TermBullet {
  term: string;
  body: string;
}

export default function PrivacyPage() {
  const t = useTranslations("console.privacy");

  const accountBullets = t.raw(
    "sections.informationCollected.accountBullets"
  ) as string[];
  const metadataBullets = t.raw(
    "sections.informationCollected.metadataBullets"
  ) as string[];
  const doNotCollectBullets = t.raw(
    "sections.informationCollected.doNotCollectBullets"
  ) as TermBullet[];
  const howWeUseBullets = t.raw("sections.howWeUse.bullets") as string[];
  const providersBullets = t.raw(
    "sections.dataSharing.providersBullets"
  ) as TermBullet[];
  const securityBullets = t.raw("sections.security.bullets") as string[];
  const retentionBullets = t.raw(
    "sections.retention.bullets"
  ) as TermBullet[];
  const rightsBullets = t.raw("sections.rights.bullets") as TermBullet[];
  const cookiesBullets = t.raw("sections.cookies.bullets") as TermBullet[];

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
              {t("sections.introduction.heading")}
            </h2>
            <p className="text-cream/60 leading-relaxed">
              {(t.raw("sections.introduction.paragraphs") as string[])[0]}
            </p>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-cream mb-4">
              {t("sections.informationCollected.heading")}
            </h2>

            <h3 className="text-lg font-semibold text-cream mb-3 mt-6">
              {t("sections.informationCollected.accountHeading")}
            </h3>
            <ul className="list-disc list-inside text-cream/60 space-y-2 ml-4">
              {accountBullets.map((bullet, idx) => (
                <li key={idx}>{bullet}</li>
              ))}
            </ul>

            <h3 className="text-lg font-semibold text-cream mb-3 mt-6">
              {t("sections.informationCollected.metadataHeading")}
            </h3>
            <ul className="list-disc list-inside text-cream/60 space-y-2 ml-4">
              {metadataBullets.map((bullet, idx) => (
                <li key={idx}>{bullet}</li>
              ))}
            </ul>

            <h3 className="text-lg font-semibold text-cream mb-3 mt-6">
              {t("sections.informationCollected.paymentHeading")}
            </h3>
            <p className="text-cream/60 leading-relaxed">
              {t("sections.informationCollected.paymentBody")}
            </p>

            <div className="bg-sodium/10 border border-sodium/20 rounded-lg p-6 mt-6">
              <h3 className="text-lg font-semibold text-sodium mb-3">
                {t("sections.informationCollected.doNotCollectHeading")}
              </h3>
              <ul className="list-disc list-inside text-cream/60 space-y-2">
                {doNotCollectBullets.map((bullet, idx) => (
                  <li key={idx}>
                    <strong>{bullet.term}</strong>
                    {bullet.body}
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-cream mb-4">
              {t("sections.howWeUse.heading")}
            </h2>
            <p className="text-cream/60 leading-relaxed mb-4">
              {t("sections.howWeUse.intro")}
            </p>
            <ul className="list-disc list-inside text-cream/60 space-y-2 ml-4">
              {howWeUseBullets.map((bullet, idx) => (
                <li key={idx}>{bullet}</li>
              ))}
            </ul>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-cream mb-4">
              {t("sections.dataSharing.heading")}
            </h2>
            <p className="text-cream/60 leading-relaxed mb-4">
              {t("sections.dataSharing.intro")}
            </p>

            <h3 className="text-lg font-semibold text-cream mb-3 mt-6">
              {t("sections.dataSharing.providersHeading")}
            </h3>
            <ul className="list-disc list-inside text-cream/60 space-y-2 ml-4">
              {providersBullets.map((bullet, idx) => (
                <li key={idx}>
                  <strong>{bullet.term}</strong>
                  {bullet.body}
                </li>
              ))}
            </ul>

            <h3 className="text-lg font-semibold text-cream mb-3 mt-6">
              {t("sections.dataSharing.legalHeading")}
            </h3>
            <p className="text-cream/60 leading-relaxed">
              {t("sections.dataSharing.legalBody")}
            </p>

            <p className="text-cream/60 leading-relaxed mt-4">
              <strong className="text-cream">
                {t("sections.dataSharing.noSaleEmphasis")}
              </strong>
              {t("sections.dataSharing.noSaleSuffix")}
            </p>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-cream mb-4">
              {t("sections.security.heading")}
            </h2>
            <p className="text-cream/60 leading-relaxed mb-4">
              {t("sections.security.intro")}
            </p>
            <ul className="list-disc list-inside text-cream/60 space-y-2 ml-4">
              {securityBullets.map((bullet, idx) => (
                <li key={idx}>{bullet}</li>
              ))}
            </ul>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-cream mb-4">
              {t("sections.retention.heading")}
            </h2>
            <ul className="list-disc list-inside text-cream/60 space-y-2 ml-4">
              {retentionBullets.map((bullet, idx) => (
                <li key={idx}>
                  <strong>{bullet.term}</strong>
                  {bullet.body}
                </li>
              ))}
            </ul>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-cream mb-4">
              {t("sections.rights.heading")}
            </h2>
            <p className="text-cream/60 leading-relaxed mb-4">
              {t("sections.rights.intro")}
            </p>
            <ul className="list-disc list-inside text-cream/60 space-y-2 ml-4">
              {rightsBullets.map((bullet, idx) => (
                <li key={idx}>
                  <strong>{bullet.term}</strong>
                  {bullet.body}
                </li>
              ))}
            </ul>
            <p className="text-cream/60 leading-relaxed mt-4">
              {t("sections.rights.outro")}
              <a
                href="mailto:privacy@ellul.ai"
                className="text-sodium hover:text-sodium"
              >
                privacy@ellul.ai
              </a>
            </p>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-cream mb-4">
              {t("sections.cookies.heading")}
            </h2>
            <p className="text-cream/60 leading-relaxed mb-4">
              {t("sections.cookies.intro")}
            </p>
            <ul className="list-disc list-inside text-cream/60 space-y-2 ml-4">
              {cookiesBullets.map((bullet, idx) => (
                <li key={idx}>
                  <strong>{bullet.term}</strong>
                  {bullet.body}
                </li>
              ))}
            </ul>
            <p className="text-cream/60 leading-relaxed mt-4">
              {t("sections.cookies.outro")}
            </p>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-cream mb-4">
              {t("sections.transfers.heading")}
            </h2>
            <p className="text-cream/60 leading-relaxed">
              {(t.raw("sections.transfers.paragraphs") as string[])[0]}
            </p>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-cream mb-4">
              {t("sections.children.heading")}
            </h2>
            <p className="text-cream/60 leading-relaxed">
              {(t.raw("sections.children.paragraphs") as string[])[0]}
            </p>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-cream mb-4">
              {t("sections.changes.heading")}
            </h2>
            <p className="text-cream/60 leading-relaxed">
              {(t.raw("sections.changes.paragraphs") as string[])[0]}
            </p>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-cream mb-4">
              {t("sections.contact.heading")}
            </h2>
            <p className="text-cream/60 leading-relaxed">
              {t("sections.contact.intro")}
            </p>
            <p className="text-cream/60 mt-4">
              {t("sections.contact.emailLabel")}
              <a
                href="mailto:privacy@ellul.ai"
                className="text-sodium hover:text-sodium"
              >
                privacy@ellul.ai
              </a>
            </p>
          </section>
        </div>

        <div className="mt-16 pt-8 border-t border-border">
          <div className="flex gap-6 text-sm text-cream/60">
            <Link href="/terms" className="hover:text-cream transition-colors">
              {t("footer.terms")}
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
