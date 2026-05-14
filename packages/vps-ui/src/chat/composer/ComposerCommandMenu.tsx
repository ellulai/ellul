// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/web/src/components/chat/ComposerCommandMenu.tsx

import { BotIcon } from "lucide-react";
import { memo, useLayoutEffect, useMemo, useRef } from "react";
import { useTranslations } from "use-intl";
import { cn } from "@shared/utils";
import { formatProviderSkillInstallSource } from "../lib/provider-skill-presentation";
import type { ComposerTriggerKind } from "../lib/composer-logic";
import {
  Command,
  CommandGroup,
  CommandGroupLabel,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "../ui/command";
import type { ComposerCommandItem } from "./types";

type ComposerCommandGroup = {
  id: string;
  label: string | null;
  items: ComposerCommandItem[];
};

function SkillGlyph(props: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.85"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
      aria-hidden="true"
    >
      <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <path d="m3.3 7 8.7 5 8.7-5" />
      <path d="M12 22V12" />
    </svg>
  );
}

function groupCommandItems(
  items: ComposerCommandItem[],
  triggerKind: ComposerTriggerKind | null,
  groupSlashCommandSections: boolean,
  labels: { skills: string; builtIn: string; provider: string },
): ComposerCommandGroup[] {
  if (triggerKind === "skill") {
    return items.length > 0 ? [{ id: "skills", label: labels.skills, items }] : [];
  }
  if (triggerKind !== "slash-command" || !groupSlashCommandSections) {
    return [{ id: "default", label: null, items }];
  }

  const builtInItems = items.filter((item) => item.type === "slash-command");
  const providerItems = items.filter((item) => item.type === "provider-slash-command");

  const groups: ComposerCommandGroup[] = [];
  if (builtInItems.length > 0) {
    groups.push({ id: "built-in", label: labels.builtIn, items: builtInItems });
  }
  if (providerItems.length > 0) {
    groups.push({ id: "provider", label: labels.provider, items: providerItems });
  }
  return groups;
}

export interface ComposerCommandMenuProps {
  items: ComposerCommandItem[];
  resolvedTheme?: "light" | "dark";
  isLoading: boolean;
  triggerKind: ComposerTriggerKind | null;
  groupSlashCommandSections?: boolean;
  emptyStateText?: string;
  activeItemId: string | null;
  onHighlightedItemChange: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
}

export const ComposerCommandMenu = memo(function ComposerCommandMenu(
  props: ComposerCommandMenuProps,
) {
  const tChat = useTranslations("chat");
  const listRef = useRef<HTMLDivElement>(null);
  const groups = useMemo(
    () =>
      groupCommandItems(props.items, props.triggerKind, props.groupSlashCommandSections ?? true, {
        skills: tChat("commandMenu.skillsLabel"),
        builtIn: tChat("commandMenu.builtInLabel"),
        provider: tChat("commandMenu.providerLabel"),
      }),
    [props.groupSlashCommandSections, props.items, props.triggerKind, tChat],
  );

  useLayoutEffect(() => {
    if (!props.activeItemId || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-composer-item-id="${CSS.escape(props.activeItemId)}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [props.activeItemId]);

  return (
    <Command
      autoHighlight={false}
      mode="none"
      onItemHighlighted={(highlightedValue) => {
        props.onHighlightedItemChange(
          typeof highlightedValue === "string" ? highlightedValue : null,
        );
      }}
    >
      <div
        ref={listRef}
        className="relative overflow-hidden rounded-xl border border-border/80 bg-popover/95 shadow-panel-lift backdrop-blur-sm"
      >
        <CommandList className="max-h-72">
          {groups.map((group, groupIndex) => (
            <div key={group.id}>
              {groupIndex > 0 ? <CommandSeparator className="my-0.5" /> : null}
              <CommandGroup>
                {group.label ? (
                  <CommandGroupLabel className="px-3 pt-2 pb-1">{group.label}</CommandGroupLabel>
                ) : null}
                {group.items.map((item) => (
                  <ComposerCommandMenuItem
                    key={item.id}
                    item={item}
                    isActive={props.activeItemId === item.id}
                    onHighlight={props.onHighlightedItemChange}
                    onSelect={props.onSelect}
                  />
                ))}
              </CommandGroup>
            </div>
          ))}
        </CommandList>
        {props.items.length === 0 ? (
          <div className="px-3 py-2">
            {props.triggerKind === "skill" ? (
              <CommandGroup>
                <CommandGroupLabel className="px-0 pt-0 pb-1">{tChat("commandMenu.skillsLabel")}</CommandGroupLabel>
                <p className="text-xs text-muted-foreground/70">
                  {props.isLoading
                    ? tChat("commandMenu.searchingSkills")
                    : (props.emptyStateText ?? tChat("commandMenu.noMatchingSkills"))}
                </p>
              </CommandGroup>
            ) : (
              <p className="text-xs text-muted-foreground/70">
                {props.isLoading
                  ? tChat("commandMenu.searchingFiles")
                  : (props.emptyStateText ?? tChat("commandMenu.noMatchingCommand"))}
              </p>
            )}
          </div>
        ) : null}
      </div>
    </Command>
  );
});

const ComposerCommandMenuItem = memo(function ComposerCommandMenuItem(props: {
  item: ComposerCommandItem;
  isActive: boolean;
  onHighlight: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const tChat = useTranslations("chat");
  const skillSourceLabel =
    props.item.type === "skill" ? formatProviderSkillInstallSource(props.item.skill, tChat) : null;

  return (
    <CommandItem
      value={props.item.id}
      data-composer-item-id={props.item.id}
      className={cn(
        "cursor-pointer select-none gap-2 hover:bg-transparent hover:text-inherit data-[highlighted]:bg-transparent data-[highlighted]:text-inherit",
        props.isActive && "!bg-sodium/15 !text-cream",
      )}
      onMouseMove={() => {
        if (!props.isActive) props.onHighlight(props.item.id);
      }}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        props.onSelect(props.item);
      }}
    >
      {props.item.type === "slash-command" ? (
        <BotIcon className="size-4 shrink-0 text-muted-foreground/80" />
      ) : null}
      {props.item.type === "provider-slash-command" ? (
        <span className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground/80">
          <SkillGlyph className="size-3.5" />
        </span>
      ) : null}
      {props.item.type === "skill" ? (
        <span className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground/80">
          <SkillGlyph className="size-3.5" />
        </span>
      ) : null}
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="shrink-0">{props.item.label}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground/70">
          {props.item.description}
        </span>
      </span>
      {skillSourceLabel ? (
        <span className="shrink-0 pl-2 text-xs text-muted-foreground/70">{skillSourceLabel}</span>
      ) : null}
    </CommandItem>
  );
});
