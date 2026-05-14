// SPDX-License-Identifier: MIT
"use client";

import { useState } from "react";
import { ChevronUp, ChevronDown, ArrowUpRight } from "lucide-react";
import { useTranslations } from "next-intl";

interface BacklinkEntry {
  sourceNoteId: string;
  sourcePath: string;
  sourceTitle: string;
  context: string;
  lineNumber: number;
}

interface VaultBacklinksPaneProps {
  backlinks: BacklinkEntry[];
  restrictedCount: string;
  onNoteClick: (noteId: string) => void;
}

// Restricted counts are clamped to buckets to prevent side-channel leakage:
export function VaultBacklinksPane({
  backlinks,
  restrictedCount,
  onNoteClick,
}: VaultBacklinksPaneProps) {
  const t = useTranslations("console.vault.backlinks");
  const [expanded, setExpanded] = useState(true);
  const hasBacklinks = backlinks.length > 0 || restrictedCount !== "none";

  if (!hasBacklinks) return null;

  return (
    <div className="border-t border-cream/[0.06] bg-cream/[0.01]">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-[11px] font-medium text-cream/60 uppercase tracking-wider hover:text-cream/75 transition-colors select-none"
      >
        <ArrowUpRight className="h-3 w-3" />
        <span>
          {t("linkedMentions", { count: backlinks.length })}
          {restrictedCount !== "none" && (
            <span className="ml-1 normal-case tracking-normal text-cream/45 font-normal">
              {t("restrictedSuffix", { count: restrictedCount })}
            </span>
          )}
        </span>
        {expanded ? (
          <ChevronDown className="h-3 w-3 ml-auto" />
        ) : (
          <ChevronUp className="h-3 w-3 ml-auto" />
        )}
      </button>

      {expanded && (
        <div className="px-4 pb-3 space-y-1">
          {backlinks.map((bl, i) => (
            <button
              key={`${bl.sourceNoteId}-${i}`}
              onClick={() => onNoteClick(bl.sourceNoteId)}
              className="w-full text-left flex items-start gap-2 px-3 py-2 rounded-lg border border-transparent hover:border-cream/[0.04] hover:bg-cream/[0.02] transition-colors group"
            >
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-cream/75 group-hover:text-sodium truncate transition-colors">
                  {bl.sourceTitle}
                </div>
                <div className="text-[10px] text-cream/45 truncate mt-0.5">
                  {bl.context}
                </div>
              </div>
            </button>
          ))}

          {restrictedCount !== "none" && (
            <div className="text-[10px] text-cream/35 px-3 py-1.5">
              {restrictedCount === "some" && t("someRestricted")}
              {restrictedCount === "several" && t("severalRestricted")}
              {restrictedCount === "many" && t("manyRestricted")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
