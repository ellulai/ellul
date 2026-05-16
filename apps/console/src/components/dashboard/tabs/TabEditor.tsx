// SPDX-License-Identifier: MIT
"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useTranslations } from "next-intl";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Spinner } from "@/components/ui/spinner";
import { useUserLocale } from "@/lib/use-user-locale";
import { API_URL } from "@/lib/api";
import { useVpsBridge } from "@/lib/vps-bridge";
import { useCodeToken } from "@/contexts/CodeTokenContext";
import { useWorkbenchOptional, type WorkbenchContextValue } from "@/contexts/WorkbenchContext";
import { getCodeApiUrl, isValidServerOrigin } from "@/lib/domains";
import type { ApiApp } from "@/contexts/AppsListContext";

type AppInfo = ApiApp;

interface TabEditorProps {
  serverId: string;
  ipAddress: string;
  domain?: string;
  // User's preferred session for Workbench (persisted in DB)
  preferredSession?: "main" | "claw" | "opencode" | "claude" | "codex" | "cursor" | "grok";
  // Whether this tab is currently visible
  visible?: boolean;
  // App info from backend (props-based data flow)
  app?: AppInfo | null;
  // Fallback project directory used when `app` is null — i.e. the user is
  fallbackDirectory?: string | null;
  // Callback to trigger upgrade
  onUpgrade?: () => void;
  // Desktop view mode — focus mode tells VPS UI to show its built-in thread sidebar
  viewMode?: "focus" | "studio";
  // Exposes a function to send messages to the chat iframe (used by sibling panels like TabCode).
  onRegisterSendToChat?: (send: ((msg: Record<string, unknown>) => void) | null) => void;
}

type WorkbenchSessionId = "main" | "claw" | "opencode" | "claude" | "codex" | "cursor" | "grok";

export function TabEditor({
  serverId,
  ipAddress,
  domain,
  preferredSession = "claw",
  visible,
  app,
  fallbackDirectory,
  onUpgrade,
  viewMode,
  onRegisterSendToChat,
}: TabEditorProps) {
  const t = useTranslations("console.tabEditor");
  const tGit = useTranslations("console.tabGit");
  // User-pref locale, captured at MOUNT only — runtime flips reach the
  // iframe via `set_locale` postMessage (see usePreferredLocale broadcast)
  // so we don't re-mount the chat and lose in-progress state. New mounts
  // (server switch, fresh tab) pick up the current pref.
  const userLocale = useUserLocale();
  const initialLocaleRef = useRef(userLocale);
  // Directory we publish to the VPS bridge via `set_project`. The fallback
  const wireDirectory = fallbackDirectory ?? app?.directory ?? null;
  // Project metadata the chat iframe uses to tailor empty-chat suggestions.
  const wireFramework = app?.framework ?? null;
  const wireType = app?.type ?? null;
  const wireIsMonorepo = app?.isMonorepo ?? false;
  const wireHasLeaves = (app?.workspacePackages?.length ?? 0) > 0;
  const wireOrigin = app?.origin ?? null;
  // Orchestration id resolved server-side. Non-null in the happy path
  // (file-api ensures a project.create has fired for every app via
  // /api/internal/ensure-projects). Null only during a transient bridge
  // outage — vps-ui handles it as "no project yet".
  const wireProjectId = app?.projectId ?? null;
  // Pre-resolved projectId for every workspace package in this monorepo,
  // shipped alongside set_project so vps-ui's "All" sidebar scope can
  // selectSidebarThreadsForProjectRefs() without reverse-resolving paths.
  const wireMonorepoLeafIds: readonly string[] = (app?.workspacePackages ?? [])
    .map((p) => p.projectId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const chatReadyRef = useRef(false);
  const lastIframeThreadRef = useRef<string | null>(null);
  const visibleRef = useRef(visible ?? true);
  const [currentWorkbenchSession, setCurrentWorkbenchSession] = useState<WorkbenchSessionId>(preferredSession);
  const { ready, needsVpsAuth, send, signalAuthNeeded } = useVpsBridge();
  const { fetchWithCodeToken } = useCodeToken();
  const workbench = useWorkbenchOptional();
  const workbenchRef = useRef<WorkbenchContextValue | null>(null);
  workbenchRef.current = workbench;

  const serverDomain = domain || `${ipAddress.replace(/\./g, "-")}.sslip.io`;

  // Cross-origin iframe auth: obtain exchange code via bridge
  const [chatExchangeCode, setChatExchangeCode] = useState<string | null>(null);
  const exchangeCodeFetchedRef = useRef(false);

  useEffect(() => {
    console.log("[ellul-debug][TabEditor] exchange code effect", { ready, exchangeCodeFetched: exchangeCodeFetchedRef.current });
    if (!ready) {
      // Bridge went down (e.g. tier upgrade reload) — reset so we
      exchangeCodeFetchedRef.current = false;
      setChatExchangeCode(null);
      return;
    }
    if (exchangeCodeFetchedRef.current) return;
    exchangeCodeFetchedRef.current = true;

    console.log("[ellul-debug][TabEditor] calling bridge get_exchange_code");
    send<{ code: string }>("get_exchange_code")
      .then((result) => {
        console.log("[ellul-debug][TabEditor] get_exchange_code result", { hasCode: !!result.code, code: result.code?.slice(0, 8) });
        if (!result.code) {
          console.error("[ellul-debug][TabEditor] Exchange code response missing code");
          setChatExchangeCode("error");
          return;
        }
        setChatExchangeCode(result.code);
      })
      .catch((err) => {
        console.error("[ellul-debug][TabEditor] get_exchange_code FAILED:", err?.message || err);
        setChatExchangeCode("error");
      });
  }, [ready, send]);

  // Save user preferences
  const savePreferenceMutation = useMutation({
    mutationFn: async (prefs: { preferredSession?: string }) => {
      const response = await fetch(`${API_URL}/api/servers/${serverId}/preferences`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(prefs),
      });
      if (!response.ok) {
        throw new Error("Failed to save preference");
      }
      return response.json();
    },
  });

  // Handle session change with persistence
  const handleWorkbenchSessionChange = useCallback(
    (newSession: WorkbenchSessionId) => {
      setCurrentWorkbenchSession(newSession);
      savePreferenceMutation.mutate({ preferredSession: newSession });
    },
    [savePreferenceMutation]
  );

  // Send messages to the chat iframe. Guarded by chatReadyRef so calls before
  // the iframe finishes loading (about:blank → cross-origin) are dropped
  // rather than throwing a postMessage origin mismatch.
  const sendToIframe = useCallback((msg: Record<string, unknown>) => {
    if (!chatReadyRef.current) return;
    iframeRef.current?.contentWindow?.postMessage(msg, `https://${serverDomain}`);
  }, [serverDomain]);

  useEffect(() => {
    if (workbench) workbench.chatIframeSendRef.current = sendToIframe;
    return () => { if (workbench) workbench.chatIframeSendRef.current = null; };
  }, [workbench, sendToIframe]);

  useEffect(() => {
    visibleRef.current = visible ?? true;
    if (visible) {
      workbenchRef.current?.setActiveThreadIdFromIframe?.(lastIframeThreadRef.current);
    } else {
      workbenchRef.current?.setActiveThreadIdFromIframe?.(null);
    }
  }, [visible]);

  // When VPS auth transitions to ready, notify the iframe so it retries.
  // Also re-send set_project so threads_list is refreshed (without this,
  // reauth leaves the thread sidebar empty until a manual page reload).
  const prevReadyRef = useRef(ready);
  const prevNeedsAuthRef = useRef(needsVpsAuth);
  useEffect(() => {
    if (ready && !prevReadyRef.current && iframeRef.current) {
      try {
        iframeRef.current.contentWindow?.postMessage(
          { type: "auth_complete" },
          `https://${serverDomain}`
        );
      } catch { /* iframe not yet loaded */ }
    }
    if (prevNeedsAuthRef.current && !needsVpsAuth && ready) {
      sendToIframe({ type: "set_session", session: currentWorkbenchSession });
      if (wireDirectory) {
        sendToIframe({
          type: "set_project",
          project: wireDirectory,
          projectId: wireProjectId,
          monorepoLeafProjectIds: wireMonorepoLeafIds,
          framework: wireFramework,
          projectType: wireType,
          isMonorepo: wireIsMonorepo,
          hasLeaves: wireHasLeaves,
          origin: wireOrigin,
        });
      }
    }
    prevReadyRef.current = ready;
    prevNeedsAuthRef.current = needsVpsAuth;
  }, [ready, needsVpsAuth, serverDomain, sendToIframe, currentWorkbenchSession,
      wireDirectory, wireProjectId, wireMonorepoLeafIds, wireFramework,
      wireType, wireIsMonorepo, wireHasLeaves, wireOrigin]);

  // Register sendToIframe with parent so sibling panels (TabCode) can send
  useEffect(() => {
    onRegisterSendToChat?.(sendToIframe);
    return () => onRegisterSendToChat?.(null);
  }, [sendToIframe, onRegisterSendToChat]);

  // IMPORTANT: This must NOT depend on iframeRef being set — the listener
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const o = event.origin;
      if (!isValidServerOrigin(o) && !o.endsWith(".sslip.io")) return;
      const data = event.data;
      if (!data || typeof data.type !== "string") return;

      switch (data.type) {
        case "gate_request":
          workbenchRef.current?.handleWsMessage(data);
          break;
        case "thread_active": {
          const tid = typeof data.threadId === "string" ? data.threadId : null;
          lastIframeThreadRef.current = tid;
          if (visibleRef.current) {
            workbenchRef.current?.setActiveThreadIdFromIframe?.(tid);
          }
          break;
        }
        case "ready":
          chatReadyRef.current = true;
          sendToIframe({ type: "set_theme", mode: "dark" });
          if (wireDirectory) {
            sendToIframe({
              type: "set_project",
              project: wireDirectory,
              projectId: wireProjectId,
              monorepoLeafProjectIds: wireMonorepoLeafIds,
              framework: wireFramework,
              projectType: wireType,
              isMonorepo: wireIsMonorepo,
              hasLeaves: wireHasLeaves,
              origin: wireOrigin,
            });
          }
          sendToIframe({ type: "set_session", session: currentWorkbenchSession });
          break;
        case "auth_needed":
          signalAuthNeeded();
          break;
        case "action": {
          const action = data.action as string;
          const project = data.project as string;
          if (!project) break;
          const codeApiUrl = getCodeApiUrl(serverDomain);
          if (action === "deploy") {
            fetchWithCodeToken(`${codeApiUrl}/api/deploy-authorize`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ project }),
            })
              .then((r) => r.json())
              .then((d) => {
                if (d.error) {
                  toast.error(d.error);
                  sendToIframe({ type: "action_result", action, success: false, error: d.error });
                } else {
                  toast.success(tGit("deployInitiated"));
                  sendToIframe({ type: "action_result", action, success: true });
                }
              })
              .catch((e: Error) => {
                toast.error(tGit("deployFailed", { message: e.message }));
                sendToIframe({ type: "action_result", action, success: false, error: e.message });
              });
          } else if (action === "git-push" || action === "git-sync") {
            // Accept both ids — "git-push" is the new registry id used by
            fetchWithCodeToken(`${codeApiUrl}/api/git-push-authorize`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ project }),
            })
              .then((r) => r.json())
              .then((d) => {
                if (d.error) {
                  toast.error(d.error);
                  sendToIframe({ type: "action_result", action, success: false, error: d.error });
                } else {
                  toast.success(tGit("gitSyncInitiated"));
                  sendToIframe({ type: "action_result", action, success: true });
                }
              })
              .catch((e: Error) => {
                toast.error(tGit("gitSyncFailed", { message: e.message }));
                sendToIframe({ type: "action_result", action, success: false, error: e.message });
              });
          }
          break;
        }
      }
    };

    window.addEventListener("message", handleMessage);
    workbenchRef.current?.setWsSend(sendToIframe);

    return () => {
      window.removeEventListener("message", handleMessage);
      workbenchRef.current?.setWsSend(null);
    };
  }, [serverDomain, wireDirectory, signalAuthNeeded, fetchWithCodeToken, sendToIframe]);

  // Re-publish project when the wire directory changes (covers cases where
  useEffect(() => {
    if (!wireDirectory) return;
    sendToIframe({
      type: "set_project",
      project: wireDirectory,
      projectId: wireProjectId,
      monorepoLeafProjectIds: wireMonorepoLeafIds,
      framework: wireFramework,
      projectType: wireType,
      isMonorepo: wireIsMonorepo,
      hasLeaves: wireHasLeaves,
    });
  }, [wireDirectory, wireProjectId, wireMonorepoLeafIds, wireFramework, wireType, wireIsMonorepo, wireHasLeaves, wireOrigin, sendToIframe]);

  // Update session when user switches in console
  useEffect(() => {
    sendToIframe({ type: "set_session", session: currentWorkbenchSession });
  }, [currentWorkbenchSession, sendToIframe]);

  // Update view mode when user switches focus/studio in console at runtime
  const prevViewModeRef = useRef(viewMode);
  useEffect(() => {
    if (viewMode === prevViewModeRef.current) return;
    prevViewModeRef.current = viewMode;
    sendToIframe({ type: "set_view_mode", mode: viewMode ?? "studio" });
  }, [viewMode, sendToIframe]);

  // --- All hooks MUST be above early returns (React rules of hooks) ---

  const [chatLoaded, setChatLoaded] = useState(false);
  const prevSrcRef = useRef<string | null>(null);
  const loadTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Build iframe src (may be null if exchange code not ready)
  const chatSrc = chatExchangeCode && chatExchangeCode !== "error"
    ? `https://${serverDomain}/_auth/chat?_shield_code=${encodeURIComponent(chatExchangeCode)}&parentOrigin=${encodeURIComponent(window.location.origin)}&locale=${encodeURIComponent(initialLocaleRef.current)}`
    : null;

  // Reset loaded state when src changes (new exchange code, app switch)
  useEffect(() => {
    if (chatSrc && chatSrc !== prevSrcRef.current) {
      chatReadyRef.current = false;
      setChatLoaded(false);
      prevSrcRef.current = chatSrc;
    }
  }, [chatSrc]);

  // Fallback: 8s timeout in case onLoad never fires (network error, blocked)
  useEffect(() => {
    if (chatLoaded || !chatSrc) return;
    loadTimerRef.current = setTimeout(() => setChatLoaded(true), 8000);
    return () => clearTimeout(loadTimerRef.current);
  }, [chatLoaded, chatSrc]);

  const handleChatLoad = useCallback(() => {
    clearTimeout(loadTimerRef.current);
    // Delay reveal slightly to allow SPA to hydrate after HTML load
    loadTimerRef.current = setTimeout(() => setChatLoaded(true), 300);
  }, []);

  // --- Early returns (after all hooks) ---

  // Wait for VPS auth and exchange code before rendering iframe
  if (!ready || chatExchangeCode === null) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center panel-ascente">
        <Spinner size="sm" label={t("connecting")} color="muted" />
      </div>
    );
  }

  if (chatExchangeCode === "error") {
    return (
      <div className="flex-1 flex flex-col items-center justify-center panel-ascente">
        <p className="text-xs text-muted-foreground/60 mb-1">{t("connectionFailed")}</p>
        <button
          className="mt-2 text-xs text-cream/60 hover:text-cream transition-colors"
          onClick={() => {
            exchangeCodeFetchedRef.current = false;
            setChatExchangeCode(null);
          }}
        >
          {t("retry")}
        </button>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 panel-ascente">
      <div className="flex-1 flex min-h-0 overflow-hidden relative">
        {/* Loading overlay — covers iframe white flash with matching theme background.
            Transitions out smoothly instead of popping. */}
        <div
          className={`absolute inset-0 z-10 flex items-center justify-center bg-[#0B0B0F] transition-opacity duration-300 pointer-events-none ${chatLoaded ? "opacity-0" : "opacity-100"}`}
          onTransitionEnd={(e) => {
            // Remove from DOM after fade-out to not block clicks
            if (chatLoaded) (e.currentTarget as HTMLElement).style.display = "none";
          }}
        >
          <div className="relative w-10 h-10">
            <div className="absolute inset-0 rounded-full border-2 border-cream/[0.06]" />
            <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-sodium animate-spin" />
          </div>
        </div>
        <iframe
          ref={iframeRef}
          src={chatSrc ?? undefined}
          className="w-full h-full border-0"
          allow="publickey-credentials-get *; clipboard-read; clipboard-write"
          title="AI Chat"
          onLoad={handleChatLoad}
        />
      </div>
    </div>
  );
}
