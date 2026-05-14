// SPDX-License-Identifier: MIT
"use client";

import { useTranslations } from "next-intl";
import { Fingerprint } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useDashboard } from "@/contexts/DashboardContext";

function parseRuntimeHash(
  pingedAgentVersion: string | null,
): { semver: string; hash: string | null } | null {
  if (!pingedAgentVersion) return null;
  const plus = pingedAgentVersion.lastIndexOf("+");
  if (plus < 0) return { semver: pingedAgentVersion, hash: null };
  return {
    semver: pingedAgentVersion.slice(0, plus),
    hash: pingedAgentVersion.slice(plus + 1),
  };
}

export function BuildAttestationBadge() {
  const t = useTranslations("console.buildAttestation");
  const { agentUpdate } = useDashboard();
  const parts = parseRuntimeHash(agentUpdate?.pingedAgentVersion ?? null);
  if (!parts?.hash) return null;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-sodium/10 border border-sodium/20 text-[10px] font-mono text-sodium"
            aria-label={t("ariaLabel", { hash: parts.hash })}
          >
            <Fingerprint className="h-3 w-3" aria-hidden="true" />
            <span>#{parts.hash}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent className="max-w-sm text-xs">
          <p className="font-medium mb-1">{t("title")}</p>
          <p className="text-cream/75">
            {t("explainer")}
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
