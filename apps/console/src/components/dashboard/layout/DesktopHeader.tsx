// SPDX-License-Identifier: MIT
"use client";

import { useState, useRef } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import {
  Settings,
  ChevronDown,
  ArrowLeft,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ServerSwitcher } from "../ServerSwitcher";
import { AppSelector } from "./AppSelector";
import type { DesktopHeaderProps } from "./layout-types";

export function DesktopHeader({
  server,
  mainView,
  serverDomain,
  selectedApp,
  previewApp,
  onPreviewStart,
  appContext,
  visibleContexts,
  onContextChange,
  onBackToOverview,
  onShowServerSettings,
  allServers,
  activeServerId,
  updateActiveServer,
}: DesktopHeaderProps) {
  const t = useTranslations("console.desktopHeader");
  const router = useRouter();
  const [showContextDropdown, setShowContextDropdown] = useState(false);
  const contextButtonRef = useRef<HTMLButtonElement>(null);
  const [contextDropdownPosition, setContextDropdownPosition] = useState<{ top: number; left: number } | null>(null);

  // Get current context config
  const currentContextConfig = visibleContexts.find(c => c.id === appContext) ?? visibleContexts[0];
  const ContextIcon = currentContextConfig?.icon || Settings;

  const handleContextChange = (ctx: typeof appContext) => {
    onContextChange(ctx);
    setShowContextDropdown(false);
  };

  return (
    <div className="flex items-center justify-between px-4 sm:px-5 md:px-6 h-14 sm:h-16">
      {/* Left side - Logo or Back button with app name */}
      {mainView === "overview" ? (
        // Overview: Show logo + server switcher
        <div className="flex items-center gap-3 min-w-0">
          <span className="font-semibold text-cream text-base sm:text-lg shrink-0">
            ellul
          </span>
          {allServers.length > 1 && (
            <ServerSwitcher
              servers={allServers}
              activeServerId={activeServerId}
              onSelectServer={updateActiveServer}
              onCreateServer={() => router.push("/dashboard?new=1")}
            />
          )}
        </div>
      ) : (
        // App view: Show back button, app selector, and context selector
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={onBackToOverview}
            className="p-2 rounded-lg hover:bg-cream/[0.06] text-cream/60 hover:text-cream transition-colors shrink-0"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>

          {/* Context Selector Dropdown */}
          <div className="relative shrink-0">
            <button
              ref={contextButtonRef}
              onClick={() => {
                if (contextButtonRef.current) {
                  const rect = contextButtonRef.current.getBoundingClientRect();
                  setContextDropdownPosition({
                    top: rect.bottom + 4,
                    left: rect.left,
                  });
                }
                setShowContextDropdown(!showContextDropdown);
              }}
              className="flex items-center gap-1 sm:gap-1.5 px-2 sm:px-2.5 py-1.5 rounded-lg bg-secondary hover:bg-secondary/80 border border-border transition-colors"
            >
              <ContextIcon className="h-4 w-4 sm:h-3.5 sm:w-3.5 text-sodium" />
              <span className="text-xs text-cream/85 font-medium max-w-[80px] sm:max-w-none truncate">
                {currentContextConfig?.label}
              </span>
              <ChevronDown
                className={`h-3 w-3 text-cream/60 transition-transform ${showContextDropdown ? "rotate-180" : ""}`}
              />
            </button>

            {showContextDropdown && contextDropdownPosition && createPortal(
              <>
                <div className="fixed inset-0 z-[60]" onClick={(e) => { e.stopPropagation(); setShowContextDropdown(false); }} />
                <div
                  className="fixed w-48 bg-card border border-border rounded-lg shadow-xl z-[70] py-1 animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-150"
                  style={{ top: contextDropdownPosition.top, left: contextDropdownPosition.left }}
                >
                  {visibleContexts.map((ctx) => {
                    const Icon = ctx.icon;
                    const isActive = appContext === ctx.id;
                    return (
                      <button
                        key={ctx.id}
                        onClick={() => handleContextChange(ctx.id)}
                        className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors ${
                          isActive ? "bg-sodium/10" : "hover:bg-secondary"
                        }`}
                      >
                        {isActive && (
                          <span className="w-1.5 h-1.5 rounded-full bg-sodium shrink-0" />
                        )}
                        <Icon className={`h-4 w-4 ${isActive ? "text-sodium" : "text-cream/60"}`} />
                        <span className={`text-sm ${isActive ? "text-cream" : "text-cream/75"}`}>
                          {ctx.label}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </>,
              document.body
            )}
          </div>

          {/* Sandbox / app picker — lets the user switch without
              rewinding to the overview every time. */}
          <AppSelector
            serverId={server.id}
            serverDomain={serverDomain}
            selectedApp={selectedApp}
            previewApp={previewApp}
            onPreviewStart={onPreviewStart}
          />
        </div>
      )}

      {/* Right side - Settings icon + Status badges */}
      <div className="flex items-center gap-2 sm:gap-3 shrink-0">
        {/* Server Settings Button */}
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onShowServerSettings}
                className="p-2.5 rounded-lg hover:bg-cream/[0.06] text-cream/60 hover:text-cream transition-colors"
              >
                <Settings className="h-5 w-5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="bg-card border border-border text-cream/85">
              {t("platformSettings")}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        {(() => {
          const isOnline = server.state === "running";
          return (
            <div className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border ${
              isOnline
                ? "bg-sodium/10 border-sodium/20"
                : "bg-terra/10 border-terra/20"
            }`}>
              <span className={`inline-flex rounded-full h-2 w-2 ${
                isOnline ? "bg-sodium" : "bg-terra"
              }`} />
              <span className={`text-xs font-medium hidden sm:inline ${
                isOnline ? "text-sodium" : "text-terra"
              }`}>
                {isOnline ? t("online") : t("offline")}
              </span>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
