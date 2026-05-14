// SPDX-License-Identifier: MIT
"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import { Plus, X, ArrowUp, ArrowDown, Lock, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import { resolveIconKey } from "@/lib/workspace-extension-registry";
import { useWorkspaceExtensionLabels } from "@/lib/workspace-extension-labels";
import { useVisualViewport } from "@/hooks/useVisualViewport";
import type { ResolvedTab } from "@/lib/workspace-extensions";

interface TabAddMenuProps {
  // Currently active tabs in this context
  activeTabs?: ResolvedTab[];
  // Available tabs that can be added
  availableTabs: ResolvedTab[];
  // Called when user adds a tab
  onAdd: (extensionId: string, tabId: string) => void;
  // Called when user removes a tab
  onRemove?: (extensionId: string, tabId: string) => void;
  // Called when user reorders a tab
  onMove?: (extensionId: string, tabId: string, newIndex: number) => void;
}

export function TabAddMenu({
  activeTabs = [],
  availableTabs,
  onAdd,
  onRemove,
  onMove,
}: TabAddMenuProps) {
  const t = useTranslations("console.tabAddMenu");
  const extLabels = useWorkspaceExtensionLabels();
  const vh = useVisualViewport();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  // Body scroll is permanently locked by MobileDashboardLayout (position:fixed).

  const hasContent = activeTabs.length > 0 || availableTabs.length > 0;
  if (!hasContent) return null;

  const removableTabs = activeTabs.filter((t) => !t.required && t.availability.state !== "hidden");

  return (
    <>
      <button
        ref={buttonRef}
        onClick={() => setOpen(true)}
        className="flex items-center justify-center w-8 h-8 rounded-md text-cream/45 hover:text-cream/75 active:text-cream/85 hover:bg-cream/[0.05] active:bg-cream/[0.08] transition-all"
        title={t("manageTabs")}
      >
        <Plus className="h-4 w-4" />
      </button>

      {open && createPortal(
        <div className="fixed inset-x-0 top-0 z-[100] flex items-end sm:items-center justify-center" style={{ height: vh }}>
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm animate-in fade-in-0 duration-200"
            onClick={() => setOpen(false)}
          />

          {/* Modal */}
          <div className="relative w-full sm:max-w-sm max-h-[85%] flex flex-col bg-card border border-cream/[0.08] rounded-t-2xl sm:rounded-2xl shadow-2xl animate-in slide-in-from-bottom-4 sm:zoom-in-95 duration-200 overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-cream/[0.06] shrink-0">
              <h3 className="text-sm font-semibold text-cream">{t("manageTabsTitle")}</h3>
              <button
                onClick={() => setOpen(false)}
                className="p-1 rounded-md text-cream/45 hover:text-cream transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-3 space-y-4">
              {/* Current tabs */}
              {activeTabs.length > 0 && (
                <div>
                  <div className="text-[10px] font-medium text-cream/45 uppercase tracking-wider px-1 mb-2">
                    {t("currentTabs")}
                  </div>
                  <div className="space-y-1">
                    {activeTabs.map((tab, index) => {
                      const Icon = resolveIconKey(tab.iconKey);
                      return (
                        <div
                          key={tab.qualifiedId}
                          className="flex items-center gap-2 px-2.5 py-2 rounded-lg bg-cream/[0.03] border border-cream/[0.06]"
                        >
                          <Icon className="h-4 w-4 text-cream/60 shrink-0" />
                          <span className="text-sm text-cream flex-1 truncate">{extLabels.tabLabel(tab.extensionId, tab.tabId, tab.label)}</span>

                          {tab.required ? (
                            <Lock className="h-3 w-3 text-cream/35 shrink-0" />
                          ) : (
                            <div className="flex items-center gap-0.5 shrink-0">
                              {onMove && (
                                <>
                                  <button
                                    onClick={() => {
                                      if (index > 0) onMove(tab.extensionId, tab.tabId, index - 1);
                                    }}
                                    disabled={index === 0}
                                    className="p-1 rounded text-cream/45 hover:text-cream disabled:opacity-20 disabled:cursor-default transition-colors"
                                  >
                                    <ArrowUp className="h-3 w-3" />
                                  </button>
                                  <button
                                    onClick={() => {
                                      if (index < activeTabs.length - 1) onMove(tab.extensionId, tab.tabId, index + 1);
                                    }}
                                    disabled={index === activeTabs.length - 1}
                                    className="p-1 rounded text-cream/45 hover:text-cream disabled:opacity-20 disabled:cursor-default transition-colors"
                                  >
                                    <ArrowDown className="h-3 w-3" />
                                  </button>
                                </>
                              )}
                              {onRemove && (
                                <button
                                  onClick={() => {
                                    onRemove(tab.extensionId, tab.tabId);
                                  }}
                                  className="p-1 rounded text-cream/45 hover:text-terra transition-colors"
                                >
                                  <Minus className="h-3 w-3" />
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Available tabs */}
              {availableTabs.length > 0 && (
                <div>
                  <div className="text-[10px] font-medium text-cream/45 uppercase tracking-wider px-1 mb-2">
                    {t("addSection")}
                  </div>
                  <div className="space-y-1">
                    {availableTabs.map((tab) => {
                      const Icon = resolveIconKey(tab.iconKey);
                      const isLocked = tab.availability.state === "disabled";
                      return (
                        <button
                          key={tab.qualifiedId}
                          onClick={() => {
                            if (!isLocked) {
                              onAdd(tab.extensionId, tab.tabId);
                            }
                          }}
                          disabled={isLocked}
                          className={cn(
                            "flex items-center gap-2.5 w-full px-2.5 py-2.5 rounded-lg border border-dashed transition-colors text-left",
                            isLocked
                              ? "border-cream/[0.04] text-cream/35 cursor-not-allowed"
                              : "border-cream/[0.08] text-cream/75 hover:bg-cream/[0.03] active:bg-cream/[0.05] hover:border-cream/[0.12]"
                          )}
                        >
                          <Plus className={cn("h-4 w-4 shrink-0", isLocked ? "text-cream/85" : "text-cream/45")} />
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium truncate">{extLabels.tabLabel(tab.extensionId, tab.tabId, tab.label)}</div>
                            <div className="text-[11px] text-cream/45 leading-tight truncate">{extLabels.tabDescription(tab.extensionId, tab.tabId, tab.description)}</div>
                          </div>
                          {isLocked && tab.availability.upgradeTarget && (
                            <span className="text-[9px] text-sodium/70 shrink-0">{t("upgrade")}</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
