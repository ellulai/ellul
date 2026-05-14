// SPDX-License-Identifier: MIT
"use client";

import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { Plus, Trash2, Settings2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { TabAddMenu } from "../TabAddMenu";
import { resolveIconKey } from "@/lib/workspace-extension-registry";
import { useWorkspaceExtensionLabels } from "@/lib/workspace-extension-labels";
import type { DesktopTabBarProps } from "./layout-types";

export function DesktopTabBar({
  currentTabs,
  currentTabId,
  appContext,
  onTabChange,
  workspaceConfig,
  onCreateIntegrationGroup,
  onDeleteIntegrationGroup,
  integrationGroups,
}: DesktopTabBarProps & {
  onCreateIntegrationGroup?: () => void;
  onDeleteIntegrationGroup?: (groupId: string) => void;
  integrationGroups?: Array<{ id: string; name: string; iconKey: string; routeRole: string | null }>;
}) {
  const t = useTranslations("console.desktopTabBar");
  const extLabels = useWorkspaceExtensionLabels();
  const [showGroupMenu, setShowGroupMenu] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const isIntegrations = appContext === "integrations";

  useEffect(() => {
    if (!showGroupMenu) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") setShowGroupMenu(false); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [showGroupMenu]);

  const openGroupMenu = () => {
    if (menuBtnRef.current) {
      const rect = menuBtnRef.current.getBoundingClientRect();
      setMenuPos({ top: rect.bottom + 4, left: rect.left });
    }
    setShowGroupMenu(true);
  };

  return (
    <nav className="hidden md:flex items-center justify-between px-6">
      <div className="flex gap-1">
        {currentTabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = currentTabId === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-all ${
                isActive
                  ? "border-sodium text-cream"
                  : "border-transparent text-cream/60 hover:text-cream/75"
              }`}
            >
              <Icon className={`h-4 w-4 ${isActive ? "text-sodium" : ""}`} />
              {extLabels.tabLabel(tab.extensionId, tab.tabId, tab.label)}
            </button>
          );
        })}

        {/* Tab management — actions live in the chat iframe (vps-ui) */}
        <div className="flex items-center gap-2 ml-auto pr-1">
          {/* Integrations: group management menu */}
          {isIntegrations && onCreateIntegrationGroup && (
            <>
              <button
                ref={menuBtnRef}
                onClick={openGroupMenu}
                className="flex items-center justify-center w-8 h-8 rounded-md text-cream/45 hover:text-cream/75 hover:bg-cream/[0.05] transition-all"
                title={t("manageGroupsTooltip")}
              >
                <Settings2 className="h-4 w-4" />
              </button>

              {showGroupMenu && menuPos && createPortal(
                <>
                  <div className="fixed inset-0 z-[60]" onClick={() => setShowGroupMenu(false)} />
                  <div
                    className="fixed z-[70] w-56 bg-card border border-border rounded-lg shadow-2xl py-1 animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-150"
                    style={{ top: menuPos.top, left: menuPos.left }}
                  >
                    <button
                      onClick={() => { onCreateIntegrationGroup(); setShowGroupMenu(false); }}
                      className="flex items-center gap-2.5 w-full px-3 py-2.5 text-left text-sm text-cream/75 hover:bg-cream/[0.05] hover:text-cream transition-colors"
                    >
                      <Plus className="h-4 w-4 text-sodium" />
                      {t("newGroup")}
                    </button>

                    {integrationGroups && integrationGroups.length > 0 && (
                      <>
                        <div className="my-1 border-t border-cream/[0.06]" />
                        <div className="px-3 py-1.5 text-[10px] font-medium text-cream/35 uppercase tracking-wider">
                          {t("groupsHeading")}
                        </div>
                        {integrationGroups.map(g => {
                          const GIcon = resolveIconKey(g.iconKey);
                          return (
                            <div key={g.id} className="flex items-center justify-between px-3 py-1.5 group">
                              <div className="flex items-center gap-2 text-sm text-cream/60">
                                <GIcon className="h-3.5 w-3.5" />
                                <span className="truncate">{g.name}</span>
                                {g.routeRole && (
                                  <span className="text-[9px] text-sodium/60 bg-sodium/10 px-1 rounded">
                                    {g.routeRole.replace("-default", "")}
                                  </span>
                                )}
                              </div>
                              {onDeleteIntegrationGroup && (
                                <button
                                  onClick={() => { onDeleteIntegrationGroup(g.id); setShowGroupMenu(false); }}
                                  className="p-1 rounded text-cream/35 hover:text-terra opacity-0 group-hover:opacity-100 transition-all"
                                  title={t("deleteGroupTitle", { name: g.name })}
                                >
                                  <Trash2 className="h-3 w-3" />
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </>
                    )}
                  </div>
                </>,
                document.body,
              )}
            </>
          )}

          {/* Non-integrations: workspace tab management */}
          {!isIntegrations && (
            <TabAddMenu
              activeTabs={workspaceConfig.resolved.contexts[appContext]?.tabs.filter(t => t.availability.state !== "hidden") ?? []}
              availableTabs={workspaceConfig.getAvailableTabs(appContext)}
              onAdd={(extId, tabId) => workspaceConfig.addTab(appContext, extId, tabId)}
              onRemove={(extId, tabId) => workspaceConfig.removeTab(appContext, extId, tabId)}
              onMove={(extId, tabId, newIdx) => workspaceConfig.moveTab(appContext, extId, tabId, newIdx)}
            />
          )}
        </div>
      </div>
    </nav>
  );
}
