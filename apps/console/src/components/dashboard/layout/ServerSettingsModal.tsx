// SPDX-License-Identifier: MIT
"use client";

import {
  X,
  Maximize2,
  Columns2,
  Check,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { TabHome } from "../tabs/TabHome";
import { TabAI } from "../tabs/TabAI";
import { ContextSettings } from "../ContextSettings";
import { LanguagePicker } from "../LanguagePicker";
// import { ServerSettingsDomains } from "../ServerSettingsDomains"; // TODO: re-enable when domains UI is complete
import { canShowServerSettingsTab } from "@/lib/tier-utils";
import { isLocalServer } from "@/lib/domains";
import { useState } from "react";
import { useVisualViewport } from "@/hooks/useVisualViewport";
import type { ServerSettingsModalProps } from "./layout-types";

export function ServerSettingsModal({
  server,
  plan,
  aiQuota,
  serverDomain,
  product,
  desktopViewMode,
  onSetViewMode,
  onClose,
  onDeleteServer,
  isDeleting,
  onRebuildServer,
  isRebuilding,
  onRollbackServer,
  isRollingBack,
  snapshotExpiresAt,
  agentUpdate,
  adapterUpdates,
  onUpdateServer,
  isUpdating,
  onSetAgentUpdateMode,
  isSettingAgentUpdateMode,
  onUpgrade,
  onResetWorkspace,
}: ServerSettingsModalProps) {
  const t = useTranslations("console.serverSettings");
  const vh = useVisualViewport();
  const isLocal = isLocalServer(server);
  const [serverSettingsTab, setServerSettingsTab] = useState<"general" | "appearance" | "ai" | "billing" | "context" | "domains">("general");

  // Body scroll is permanently locked by MobileDashboardLayout (position:fixed).

  return (
    <div className="fixed inset-x-0 top-0 z-[100] flex items-end sm:items-center justify-center" style={{ height: vh, paddingTop: "max(env(safe-area-inset-top, 0px), var(--ellul-safe-top, 0px))" }}>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-0 bg-black/60 backdrop-blur-sm animate-in fade-in-0 duration-200"
        onClick={onClose}
      />

      {/* Modal Content */}
      <div className="relative z-10 w-full sm:w-[90%] sm:max-w-2xl h-[calc(100%-0.5rem)] sm:h-auto sm:max-h-[80vh] bg-card border border-border rounded-t-xl sm:rounded-xl overflow-hidden flex flex-col animate-in slide-in-from-bottom-4 sm:zoom-in-95 sm:slide-in-from-bottom-0 duration-200">
        {/* Modal Header */}
        <div className="shrink-0 flex items-center justify-between px-5 py-3.5 border-b border-border">
          <h2 className="text-base font-semibold text-cream tracking-tight">{t("modalTitle")}</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-cream/[0.06] text-cream/60 hover:text-cream transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Tabs - segmented control style */}
        <div className="shrink-0 px-5 py-3 border-b border-border">
          <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-cream/[0.03] border border-cream/[0.06]">
            {([
              { id: "general" as const, label: t("tabs.general") },
              { id: "appearance" as const, label: t("tabs.appearance") },
              { id: "ai" as const, label: "AI" },
              // { id: "domains" as const, label: t("tabs.domains") }, // TODO: re-enable when domains UI is complete
              { id: "billing" as const, label: t("tabs.billing") },
              { id: "context" as const, label: t("tabs.context") },
            ] as const).filter((tab) => canShowServerSettingsTab(tab.id, product)).map((tab) => (
              <button
                key={tab.id}
                onClick={() => setServerSettingsTab(tab.id)}
                className={`flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                  serverSettingsTab === tab.id
                    ? "bg-cream/[0.08] text-cream shadow-sm"
                    : "text-cream/45 hover:text-cream/75"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Modal Body - Scrollable */}
        <div className="flex-1 overflow-y-auto">
          {serverSettingsTab === "general" && (
            <TabHome
              server={server}
              plan={plan}
              onDeleteServer={onDeleteServer}
              isDeleting={isDeleting}
              onRebuildServer={onRebuildServer}
              isRebuilding={isRebuilding}
              onRollbackServer={onRollbackServer}
              isRollingBack={isRollingBack}
              snapshotExpiresAt={snapshotExpiresAt}
              agentUpdate={agentUpdate}
              adapterUpdates={adapterUpdates}
              onUpdateServer={onUpdateServer}
              isUpdating={isUpdating}
              onSetAgentUpdateMode={onSetAgentUpdateMode}
              isSettingAgentUpdateMode={isSettingAgentUpdateMode}
              onUpgrade={onUpgrade}
              onResetWorkspace={onResetWorkspace}
              section="server"
            />
          )}
          {serverSettingsTab === "appearance" && (
            <div className="p-4 sm:p-5 space-y-5">
              {/* Product Info */}
              <section className="rounded-xl border border-cream/[0.06] bg-cream/[0.02] overflow-hidden">
                <div className="px-4 py-3 border-b border-cream/[0.04]">
                  <h3 className="text-sm font-medium text-cream">{t("product")}</h3>
                  <p className="text-[10px] text-cream/45 mt-0.5">
                    {product === "cloud_platform" && t("productCloudPlatform")}
                    {product === "shield_proxy" && t("productShieldProxy")}
                  </p>
                </div>
              </section>

              {/* Desktop Layout */}
              <section className="hidden md:block rounded-xl border border-cream/[0.06] bg-cream/[0.02] overflow-hidden">
                <div className="px-4 py-3 border-b border-cream/[0.04]">
                  <h3 className="text-sm font-medium text-cream">{t("desktopLayout")}</h3>
                  <p className="text-[10px] text-cream/45 mt-0.5">{t("desktopLayoutHint")}</p>
                </div>
                <div className="p-4 grid grid-cols-2 gap-3">
                  {([
                    { id: "focus" as const, label: t("modeFocus"), desc: t("modeFocusDesc"), icon: Maximize2 },
                    { id: "studio" as const, label: t("modeStudio"), desc: t("modeStudioDesc"), icon: Columns2 },
                  ] as const).map((mode) => {
                    const Icon = mode.icon;
                    const isActive = desktopViewMode === mode.id;
                    return (
                      <button
                        key={mode.id}
                        onClick={() => onSetViewMode(mode.id)}
                        className={`relative flex flex-col items-center gap-2 p-4 rounded-lg border transition-all ${
                          isActive
                            ? "border-sodium/40 bg-sodium/[0.07] ring-1 ring-sodium/20"
                            : "border-cream/[0.06] bg-cream/[0.02] hover:bg-cream/[0.04] hover:border-cream/[0.1]"
                        }`}
                      >
                        {isActive && (
                          <div className="absolute top-2 right-2 w-4 h-4 rounded-full bg-sodium/20 flex items-center justify-center">
                            <Check className="h-2.5 w-2.5 text-sodium" />
                          </div>
                        )}
                        <Icon className={`h-5 w-5 ${isActive ? "text-sodium" : "text-cream/45"}`} />
                        <div className="text-center">
                          <span className={`text-xs font-medium block ${isActive ? "text-cream" : "text-cream/75"}`}>
                            {mode.label}
                          </span>
                          <span className="text-[10px] text-cream/45 mt-0.5 block">{mode.desc}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>

              {/* Language — user-identity preference, api DB authoritative.
                  Lives in this Appearance tab alongside Desktop Layout because
                  both surface as UI rendering choices. The picker writes to
                  api via PATCH /api/me/preferences (optimistic — UI flips
                  instantly, rolls back on error). Per Playbook Appendix D
                  polarity rule: this column is NOT in VPS settings.json
                  because it travels across every surface the user has. */}
              <section className="rounded-xl border border-cream/[0.06] bg-cream/[0.02]">
                <div className="px-4 py-3 border-b border-cream/[0.04]">
                  <h3 className="text-sm font-medium text-cream">{t("language")}</h3>
                  <p className="text-[10px] text-cream/45 mt-0.5">
                    {t("languageHint")}
                  </p>
                </div>
                <div className="p-4">
                  <LanguagePicker className="w-full" />
                </div>
              </section>
            </div>
          )}
          {serverSettingsTab === "ai" && (
            <TabAI
              serverId={server.id}
              serverDomain={serverDomain}
              aiQuota={aiQuota}
            />
          )}
          {serverSettingsTab === "billing" && (
            <TabHome
              server={server}
              plan={plan}
              onDeleteServer={onDeleteServer}
              isDeleting={isDeleting}
              onUpgrade={onUpgrade}
              section="billing"
            />
          )}
          {serverSettingsTab === "context" && (
            <ContextSettings
              serverDomain={serverDomain}
              globalOnly={true}
            />
          )}
          {/* TODO: re-enable when domains UI is complete
          {serverSettingsTab === "domains" && (
            <ServerSettingsDomains
              serverId={server.id}
              isSovereign={server.securityTier === "private_locked"}
              apiUrl={process.env.NEXT_PUBLIC_API_URL || ""}
            />
          )}
          */}
        </div>
      </div>
    </div>
  );
}
