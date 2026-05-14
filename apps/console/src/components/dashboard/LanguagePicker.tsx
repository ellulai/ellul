// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Check, ChevronDown } from "lucide-react";
import { ALL_LOCALES, LOCALE_DISPLAY, type Locale } from "@ellul.ai/i18n-consts";
import { usePreferredLocale } from "@/lib/use-preferred-locale";
import { cn } from "@/lib/utils";

/**
 * Account-language picker.
 *
 * Themed dropdown — matches the rest of the dashboard surface (bg-card,
 * sodium focus ring, lucide chevron, check icon for the active item)
 * rather than a native <select>. Width adapts to the longest native
 * locale name + chevron so the trigger is laid out the same in every
 * locale; the menu inherits the trigger width and grows downward.
 *
 * Reads the active locale from next-intl (URL-driven) and writes via
 * `usePreferredLocale` (optimistic): UI flips instantly; the api PATCH
 * happens in the background; on failure, state rolls back with a toast.
 */
export function LanguagePicker({ className }: { className?: string }) {
  const t = useTranslations("console.languagePicker");
  const current = useLocale() as Locale;
  const { setLocale, isUpdating } = usePreferredLocale();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listboxId = useId();

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
        triggerRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  const handleSelect = (next: Locale) => {
    close();
    if (next === current) return;
    void setLocale(next);
  };

  const currentInfo = LOCALE_DISPLAY[current];

  return (
    <div className={cn("relative", className)}>
      <button
        ref={triggerRef}
        type="button"
        disabled={isUpdating}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-label={t("currentLanguage", { language: currentInfo.nativeName })}
        className={cn(
          "w-full inline-flex items-center justify-between gap-2",
          "rounded-md border border-cream/[0.08] bg-cream/[0.03]",
          "px-3 py-2 text-sm text-cream/85",
          "transition-colors",
          "hover:border-cream/[0.16] hover:text-cream",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-sodium/60",
          "disabled:opacity-50 disabled:cursor-not-allowed",
        )}
      >
        <span className="inline-flex items-center gap-2 min-w-0">
          <span aria-hidden className="text-base leading-none flex-none">
            {currentInfo.flag}
          </span>
          <span className="truncate">{currentInfo.nativeName}</span>
        </span>
        <ChevronDown
          className={cn(
            "h-4 w-4 flex-none text-cream/55 transition-transform",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </button>

      {open && (
        <>
          {/* Click-outside scrim */}
          <div
            className="fixed inset-0 z-40"
            onClick={close}
            aria-hidden
          />
          <ul
            id={listboxId}
            role="listbox"
            aria-label={t("selectLanguage")}
            className={cn(
              "absolute left-0 right-0 bottom-full mb-1 z-50",
              "rounded-md border border-cream/[0.08] bg-card",
              "shadow-lg shadow-black/30",
              "py-1 max-h-[60vh] overflow-y-auto",
            )}
          >
            {ALL_LOCALES.map((locale) => {
              const info = LOCALE_DISPLAY[locale];
              const selected = locale === current;
              return (
                <li key={locale} role="none">
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => handleSelect(locale)}
                    className={cn(
                      "w-full inline-flex items-center gap-2",
                      "px-3 py-2 text-sm text-left",
                      "transition-colors",
                      "hover:bg-cream/[0.06] focus:bg-cream/[0.06] focus:outline-none",
                      selected ? "text-cream" : "text-cream/80",
                    )}
                  >
                    <span aria-hidden className="text-base leading-none flex-none">
                      {info.flag}
                    </span>
                    <span className="flex-1 min-w-0 truncate">{info.nativeName}</span>
                    {selected && (
                      <Check className="h-4 w-4 flex-none text-sodium" aria-hidden />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
