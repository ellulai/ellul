// SPDX-License-Identifier: MIT
"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { Plus, Trash2, Star } from "lucide-react";
import { TabAddMenu } from "../TabAddMenu";
import { resolveIconKey } from "@/lib/workspace-extension-registry";
import { useWorkspaceExtensionLabels } from "@/lib/workspace-extension-labels";
import type { MobileBottomNavProps } from "./layout-types";

interface IntegrationGroupSummary {
  id: string;
  name: string;
  iconKey: string;
  routeRole: string | null;
}

export function MobileBottomNav({
  currentTabs,
  currentTabId,
  appContext,
  onTabChange,
  workspaceConfig,
  onCreateGroup,
  onDeleteGroup,
  integrationGroups,
}: MobileBottomNavProps & {
  onCreateGroup?: () => void;
  onDeleteGroup?: (groupId: string) => void;
  integrationGroups?: IntegrationGroupSummary[];
}) {
  const t = useTranslations("console.mobileBottomNav");
  const extLabels = useWorkspaceExtensionLabels();
  const isIntegrations = appContext === "integrations";
  const [showGroupMenu, setShowGroupMenu] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const THRESHOLD = 150;
    const onResize = () => {
      setKeyboardOpen(window.innerHeight - vv.height > THRESHOLD);
    };
    vv.addEventListener("resize", onResize);
    return () => vv.removeEventListener("resize", onResize);
  }, []);

  if (keyboardOpen) return null;

  return (
    <nav
      className="md:hidden flex-none h-[60px] panel-ascente relative z-10"
      style={{ filter: "drop-shadow(0 -2px 8px rgba(0,0,0,0.2))", marginBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      <div className="flex items-center justify-around h-full">
        {currentTabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = currentTabId === tab.id;

          return (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              className={`flex flex-col items-center justify-center flex-1 h-full transition-all ${
                isActive ? "text-sodium" : "text-cream/45"
              }`}
            >
              <Icon className="h-5 w-5" />
              <span className="text-[11px] font-medium mt-0.5">{extLabels.tabLabel(tab.extensionId, tab.tabId, tab.label)}</span>
            </button>
          );
        })}
        {/* Actions live in the chat iframe (vps-ui) */}
        {/* Integrations: inline group menu (thread-sidebar style) */}
        {isIntegrations && onCreateGroup && (
          <div className="relative">
            <button
              onClick={() => setShowGroupMenu(!showGroupMenu)}
              className="flex flex-col items-center justify-center w-12 h-full text-cream/45 active:text-cream/75 transition-all"
            >
              <Plus className="h-5 w-5" />
              <span className="text-[9px] font-medium mt-0.5">{t("groups")}</span>
            </button>
            {showGroupMenu && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowGroupMenu(false)} />
                <div className="absolute right-0 bottom-full mb-2 z-20 bg-card border border-cream/10 rounded-lg shadow-2xl py-1 min-w-[180px]">
                  <button
                    onClick={() => { onCreateGroup(); setShowGroupMenu(false); }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-cream/10 transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5 text-sodium" />
                    <span className="text-cream/75 font-medium">{t("newGroup")}</span>
                  </button>
                  {integrationGroups && integrationGroups.length > 0 && (
                    <>
                      <div className="my-1 border-t border-cream/[0.06]" />
                      {integrationGroups.map(g => {
                        const GIcon = resolveIconKey(g.iconKey);
                        return (
                          <div key={g.id} className="flex items-center justify-between px-3 py-1.5">
                            <div className="flex items-center gap-2 text-xs text-cream/60 min-w-0">
                              <GIcon className="h-3.5 w-3.5 shrink-0" />
                              <span className="truncate">{g.name}</span>
                              {g.routeRole && <Star className="h-2.5 w-2.5 text-sodium shrink-0" />}
                            </div>
                            {onDeleteGroup && (
                              <button
                                onClick={() => { onDeleteGroup(g.id); setShowGroupMenu(false); }}
                                className="p-1 rounded text-cream/35 active:text-terra transition-colors"
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
              </>
            )}
          </div>
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
    </nav>
  );
}
