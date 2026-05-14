// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { memo } from "react";
import { ChevronDownIcon, FolderIcon } from "lucide-react";
import { useTranslations } from "use-intl";

export interface SandboxItem {
  id: string;
  name: string;
  warm: boolean;
  proSlotsHere: number;
}

export interface SandboxSwitcherProps {
  active: SandboxItem | null;
  options: ReadonlyArray<SandboxItem>;
  onSelect: (id: string) => void;
}

export const SandboxSwitcher = memo(function SandboxSwitcher({ active, options, onSelect }: SandboxSwitcherProps) {
  const tChat = useTranslations("chat");
  return (
    <div className="relative inline-block">
      <select
        aria-label={tChat("sandbox.switchAria")}
        className="appearance-none rounded-md border border-border bg-background px-2 py-1 pr-6 text-sm font-medium hover:bg-muted/40"
        value={active?.id ?? ""}
        onChange={(e) => onSelect(e.target.value)}
      >
        {!active && <option value="">{tChat("sandbox.noSandbox")}</option>}
        {options.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name} {s.warm ? tChat("sandbox.warm") : tChat("sandbox.cold")}{s.proSlotsHere > 0 ? tChat("sandbox.proSlots", { count: s.proSlotsHere }) : ""}
          </option>
        ))}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute right-1 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <FolderIcon className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground opacity-0" />
    </div>
  );
});
