// SPDX-License-Identifier: MIT
"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Spinner } from "@/components/ui/spinner";
import { useUserLocale } from "@/lib/use-user-locale";
import { getCodeDomain, getIframeBaseUrl, isValidServerOrigin } from "@/lib/domains";
import { useCodeToken } from "@/contexts/CodeTokenContext";
import { useIsMobile } from "@/hooks/useIsMobile";
import { isTauriApp } from "@/lib/utils";
import type { ApiApp } from "@/contexts/AppsListContext";

type AppInfo = ApiApp;

export type CodeView = "tree" | "changes" | "search";

export interface CodeStateSnapshot {
  view: CodeView;
  changesCount: number;
  loading: boolean;
}

export interface CodeProjectList {
  apps: ReadonlyArray<string>;
  active: string | null;
}

interface TabCodeProps {
  serverDomain: string;
  // Required — this panel only mounts when the workspace state machine is
  app: AppInfo;
  // When set, scopes the file browser to a monorepo package path.
  selectedDirectory?: string | null;
  // Whether the code browser is shown in studio (split) mode
  studio?: boolean;
  // In studio mode the console owns chrome and drives the iframe:
  codeView?: CodeView;
  refreshKey?: number;
  onCodeStateChange?: (state: CodeStateSnapshot) => void;
  onProjectList?: (list: CodeProjectList) => void;
  // Called when the user clicks "Ask AI" in the code browser with selected code context.
  onCodeContext?: (data: { file: string; line?: number; endLine?: number; snippet?: string; context: string }) => void;
}

// TabCode - File Browser Tab
export function TabCode({
  serverDomain,
  app,
  selectedDirectory,
  studio,
  codeView,
  refreshKey,
  onCodeStateChange,
  onProjectList,
  onCodeContext,
}: TabCodeProps) {
  const t = useTranslations("console.tabEditor");
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const codeDomain = getCodeDomain(serverDomain);
  const codeOrigin = getIframeBaseUrl(serverDomain, isTauriApp());
  const directory = selectedDirectory || app.directory;
  // Capture the user-pref locale at MOUNT only — runtime locale flips
  // propagate via postMessage (set_locale) so the iframe doesn't re-mount
  // and lose state on a language toggle. New mounts (e.g. switching servers)
  // pick up the current pref.
  const userLocale = useUserLocale();
  const initialLocaleRef = useRef(userLocale);
  const { token, loading, reauthenticate } = useCodeToken();
  const isMobile = useIsMobile();

  const iframeReady = useRef(false);

  const sendToIframe = useCallback((msg: Record<string, unknown>) => {
    if (!iframeReady.current) return;
    iframeRef.current?.contentWindow?.postMessage(msg, codeOrigin);
  }, [codeDomain]);

  const isReady = !!token && !loading;

  const prevReadyRef = useRef(isReady);
  useEffect(() => {
    if (isReady && !prevReadyRef.current && iframeRef.current) {
      try {
        iframeRef.current.contentWindow?.postMessage(
          { type: "auth_complete" },
          codeOrigin
        );
      } catch { /* iframe not yet loaded on codeDomain — will get config on "ready" */ }
    }
    prevReadyRef.current = isReady;
  }, [isReady, codeDomain]);

  // Refs so the message handler always sees the current callbacks without
  const onCodeStateChangeRef = useRef(onCodeStateChange);
  const onProjectListRef = useRef(onProjectList);
  useEffect(() => { onCodeStateChangeRef.current = onCodeStateChange; }, [onCodeStateChange]);
  useEffect(() => { onProjectListRef.current = onProjectList; }, [onProjectList]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (!isValidServerOrigin(event.origin)) return;
      const data = event.data;
      if (!data || typeof data.type !== "string") return;

      switch (data.type) {
        case "ready":
          iframeReady.current = true;
          sendToIframe({ type: "set_theme", mode: "dark" });
          sendToIframe({ type: "set_app", app: directory });
          sendToIframe({ type: "set_view_mode", mode: studio ? "studio" : "focus", mobile: isMobile });
          sendToIframe({ type: "set_chrome_mode", mode: studio ? "embedded" : "standalone" });
          if (studio && codeView) sendToIframe({ type: "set_view", view: codeView });
          break;
        case "auth_needed":
          reauthenticate().catch(() => {});
          break;
        case "state_update":
          onCodeStateChangeRef.current?.({
            view: data.view as CodeView,
            changesCount: typeof data.changesCount === "number" ? data.changesCount : 0,
            loading: !!data.loading,
          });
          break;
        case "project_list":
          onProjectListRef.current?.({
            apps: Array.isArray(data.apps) ? data.apps : [],
            active: typeof data.active === "string" ? data.active : null,
          });
          break;
        case "ask_ai":
        case "fix_request":
          if (onCodeContext) onCodeContext(data as { file: string; line?: number; endLine?: number; snippet?: string; context: string });
          break;
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [codeDomain, directory, reauthenticate, sendToIframe, studio, isMobile, codeView]);

  // Keep mobile/studio + chrome mode in sync after initial load
  useEffect(() => {
    sendToIframe({ type: "set_view_mode", mode: studio ? "studio" : "focus", mobile: isMobile });
    sendToIframe({ type: "set_chrome_mode", mode: studio ? "embedded" : "standalone" });
  }, [studio, isMobile, sendToIframe]);

  // Drive the iframe's view from the console when in studio mode
  useEffect(() => {
    if (!studio || !codeView) return;
    sendToIframe({ type: "set_view", view: codeView });
  }, [studio, codeView, sendToIframe]);

  // Trigger refresh on key bump
  const prevRefreshKeyRef = useRef(refreshKey);
  useEffect(() => {
    if (refreshKey !== undefined && refreshKey !== prevRefreshKeyRef.current) {
      sendToIframe({ type: "refresh" });
      prevRefreshKeyRef.current = refreshKey;
    }
  }, [refreshKey, sendToIframe]);

  useEffect(() => {
    if (!iframeReady.current) return;
    sendToIframe({ type: "set_app", app: directory });
  }, [directory, sendToIframe]);

  if (!isReady) {
    return (
      <div className="flex-1 flex flex-col min-h-0 relative panel-ascente">
        <div className="flex-1 flex flex-col items-center justify-center">
          <Spinner size="sm" label={t("connecting")} color="muted" />
        </div>
      </div>
    );
  }

  const [codeLoaded, setCodeLoaded] = useState(false);

  // Reset on directory change (switching apps)
  useEffect(() => {
    setCodeLoaded(false);
  }, [directory]);

  // Fallback: 8s timeout if onLoad never fires.
  const codeLoadTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (codeLoaded) return;
    codeLoadTimerRef.current = setTimeout(() => setCodeLoaded(true), 8000);
    return () => clearTimeout(codeLoadTimerRef.current);
  }, [codeLoaded]);

  const handleCodeLoad = useCallback(() => {
    clearTimeout(codeLoadTimerRef.current);
    codeLoadTimerRef.current = setTimeout(() => setCodeLoaded(true), 300);
  }, []);

  return (
    <div className="flex-1 flex flex-col min-h-0 relative panel-ascente">
      {/* Loading overlay — covers iframe white flash with matching theme background.
          Fades out smoothly after SPA hydration. */}
      <div
        className={`absolute inset-0 z-20 flex items-center justify-center bg-[#0B0B0F] transition-opacity duration-300 pointer-events-none ${codeLoaded ? "opacity-0" : "opacity-100"}`}
        onTransitionEnd={(e) => {
          if (codeLoaded) (e.currentTarget as HTMLElement).style.display = "none";
        }}
      >
        <div className="relative w-10 h-10">
          <div className="absolute inset-0 rounded-full border-2 border-cream/[0.06]" />
          <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-sodium animate-spin" />
        </div>
      </div>
      <iframe
        ref={iframeRef}
        src={`${codeOrigin}/browser?app=${encodeURIComponent(directory)}&embedded=true&parentOrigin=${encodeURIComponent(window.location.origin)}&locale=${encodeURIComponent(initialLocaleRef.current)}`}
        className="w-full flex-1 border-0"
        allow="clipboard-read; clipboard-write"
        title={t("iframeTitle")}
        onLoad={handleCodeLoad}
      />
    </div>
  );
}
