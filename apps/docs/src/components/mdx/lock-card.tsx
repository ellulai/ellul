"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";

interface LockCardProps {
  number: number;
  title: string;
  tech: string;
  benefit: string;
  children: ReactNode;
}

export function LockCard({
  number,
  title,
  tech,
  benefit,
  children,
}: LockCardProps) {
  const t = useTranslations("docs.lockCard");

  return (
    <div className="not-prose my-8 overflow-hidden rounded-xl border border-[rgba(245, 239, 230, 0.07)]">
      <div className="flex items-center gap-3 border-b border-[rgba(245, 239, 230, 0.07)] bg-[#0B0B0F] px-6 py-4">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sodium text-sm font-bold text-ink">
          {number}
        </span>
        <h3 className="text-lg font-semibold text-cream">{title}</h3>
      </div>

      <div className="grid gap-px bg-black sm:grid-cols-2">
        <div className="bg-[#13131A] px-6 py-4">
          <p className="mb-1 text-xs font-medium uppercase tracking-wider text-cream/60">
            {t("techLabel")}
          </p>
          <p className="text-sm font-medium text-sodium">{tech}</p>
        </div>
        <div className="bg-[#13131A] px-6 py-4">
          <p className="mb-1 text-xs font-medium uppercase tracking-wider text-cream/60">
            {t("benefitLabel")}
          </p>
          <p className="text-sm font-medium text-cream">{benefit}</p>
        </div>
      </div>

      <div className="border-t border-[rgba(245, 239, 230, 0.07)] bg-[#13131A] px-6 py-5 text-sm leading-relaxed text-cream/75 [&>p]:my-2 [&>ul]:my-2 [&>ul]:list-disc [&>ul]:pl-5 [&_li]:my-1">
        {children}
      </div>
    </div>
  );
}
