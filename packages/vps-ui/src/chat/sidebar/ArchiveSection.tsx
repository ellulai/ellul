// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { memo, useState } from "react";
import { useTranslations } from "use-intl";
import { ArchiveIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";

export interface ArchivedThreadItem {
  id: string;
  title: string;
  archivedAt: number;
}

export interface ArchiveSectionProps {
  items: ReadonlyArray<ArchivedThreadItem>;
  onUnarchive: (threadId: string) => void;
  onSelect: (threadId: string) => void;
  defaultOpen?: boolean;
}

export const ArchiveSection = memo(function ArchiveSection({
  items,
  onUnarchive,
  onSelect,
  defaultOpen = false,
}: ArchiveSectionProps) {
  const tChat = useTranslations("chat");
  const [open, setOpen] = useState(defaultOpen);
  if (items.length === 0) return null;
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <section aria-label={tChat("archive.heading")} className="border-t border-border pt-2 mt-2">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted/40"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Chevron className="size-3.5" />
        <ArchiveIcon className="size-3.5" />
        {tChat("archive.title", { count: items.length })}
      </button>
      {open && (
        <ul className="mt-1 space-y-0.5">
          {items.map((t) => (
            <li key={t.id}>
              <div className="flex items-center justify-between rounded-md px-2 py-1 hover:bg-muted/40">
                <button
                  type="button"
                  onClick={() => onSelect(t.id)}
                  className="flex-1 truncate text-left text-xs text-muted-foreground hover:text-foreground"
                >
                  {t.title || tChat("archive.untitledDefault")}
                </button>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onUnarchive(t.id); }}
                  className="ml-2 rounded-md px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
                  title={tChat("archive.unarchiveTooltip")}
                >
                  {tChat("archive.restoreButton")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
});
