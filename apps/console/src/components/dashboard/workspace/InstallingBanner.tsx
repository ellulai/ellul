// SPDX-License-Identifier: MIT
"use client";

import { useTranslations } from "next-intl";
import { Spinner } from "@/components/ui/spinner";
import { Package } from "lucide-react";

// Sticky-top banner shown while a cloned app's dependencies are still
export function InstallingBanner() {
  const t = useTranslations("console.installingBanner");
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 border-b border-cyan-500/25 bg-cyan-500/5 text-cyan-200">
      <div className="flex items-center gap-2 shrink-0">
        <Package className="h-4 w-4 text-cyan-400" aria-hidden />
        <Spinner size="sm" color="primary" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-cyan-100">{t("title")}</p>
        <p className="text-[11px] text-cyan-300/70 truncate">
          {t.rich("subtitle", {
            code: (chunks) => <code className="font-mono">{chunks}</code>,
          })}
        </p>
      </div>
    </div>
  );
}
