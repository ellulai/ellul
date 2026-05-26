// SPDX-License-Identifier: MIT
"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerEvents } from "@/hooks/useServerEvents";
import { getSession } from "@/lib/auth-client";
import { api, API_URL } from "@/lib/api";
import type { Session } from "@/lib/auth-client";
import { isTransitionalState } from "@/contexts/DashboardContext";
import type { ServerStatus, ServerSummary } from "@/contexts/DashboardContext";
import { useBrowserHeartbeat } from "@/hooks/useBrowserHeartbeat";
import { usePushRegistration } from "@/hooks/usePushRegistration";
import { useBackgroundPersistence } from "@/hooks/useBackgroundPersistence";
import { useDesktopIntegration } from "@/hooks/useDesktopIntegration";
import { MOCK_MODE, mockSession, mockServerStatus } from "@/lib/mock-data";
import { setupMockFetch } from "@/lib/mock-fetch";
import { isTauriApp } from "@/lib/utils";
import { LoadingScreen } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { EllulLogo } from "@ellul.ai/ui/ellul-logo";
import { useLocaleSync } from "@/hooks/useLocaleSync";
import { useTranslations } from "next-intl";

// Initialize mock fetch interceptor (no-op outside mock mode)
if (typeof window !== "undefined") {
  setupMockFetch();
}

import { useServerMutations } from "./components/useServerMutations";
import { useServerLifecycle } from "./components/useServerLifecycle";
import { DashboardShell } from "./components/DashboardShell";

const WEB_URL = process.env.NEXT_PUBLIC_WEB_URL!;

const CONSOLE_URL = process.env.NEXT_PUBLIC_CONSOLE_URL || "https://console.ellul.ai";
const TAURI_API_URL = CONSOLE_URL.replace("console.", "api.");

const CONNECT_STORAGE_KEY = "ellul_pending_connect_id";

function getLocalEngine(): "proot" | "lima" | "unknown" {
  const cfg = typeof window !== "undefined" ? (window as any).__ELLUL_APP_CONFIG__ : null;
  if (cfg?.localEngine) return cfg.localEngine;
  const info = typeof window !== "undefined" ? (window as any).__ELLUL_PLATFORM_INFO__ : null;
  if (info?.localEngine) return info.localEngine;
  if (typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent)) return "proot";
  if (typeof navigator !== "undefined" && /Mac/i.test(navigator.platform)) return "lima";
  return "unknown";
}

function buildLocalServerStatus(
  health: Array<{ name: string; healthy: boolean }> | null,
): ServerStatus {
  const core = health?.filter((s) => ["sovereign-shield", "file-api", "agent-bridge"].includes(s.name));
  const allHealthy = !!core?.length && core.every((s) => s.healthy);
  const engine = getLocalEngine();
  const isByos = engine === "lima";
  return {
    state: allHealthy ? "running" : "provisioning",
    plan: "free",
    hasActiveSubscription: false,
    server: {
      id: "local",
      ipAddress: "127.0.0.1",
      domain: "localhost",
      createdAt: new Date().toISOString(),
      performanceStatus: allHealthy ? "good" : "struggling",
      size: "local",
      terminalEnabled: true,
      sshEnabled: false,
      securityTier: "standard",
      serverPlan: "free",
      product: isByos ? "byos" : "self_hosted",
      preferredSession: "opencode",
    },
  };
}

type LocalStage = "checking" | "downloading" | "verifying" | "extracting" | "initializing" | "starting" | "provisioning" | "health" | "ready" | "failed";

const LOCAL_STAGE_KEYS: Record<LocalStage, string> = {
  checking: "checking",
  downloading: "downloading",
  verifying: "verifying",
  extracting: "extracting",
  initializing: "initializing",
  starting: "starting",
  provisioning: "provisioning",
  health: "health",
  ready: "ready",
  failed: "failed",
};

function LocalProvisioningScreen({ onBack, onComplete }: { onBack: () => void; onComplete: () => void }) {
  const t = useTranslations("console.transitions.localProvisioning");
  const [stage, setStage] = useState<LocalStage>("checking");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const invoke = (window as any).__TAURI_INTERNALS__?.invoke;
    if (!invoke) { setStage("failed"); setError("Tauri not available"); return; }

    let cancelled = false;
    let eventUnlisten: (() => void) | null = null;

    const engine = getLocalEngine();

    const runProot = async () => {
      const ti = (window as any).__TAURI_INTERNALS__;
      if (ti?.transformCallback) {
        try {
          const handlerId = ti.transformCallback((event: { payload: { stage: string; percent: number } }) => {
            if (cancelled) return;
            const s = event.payload.stage?.toLowerCase() as LocalStage;
            if (s && LOCAL_STAGE_KEYS[s]) { setStage(s); setProgress(event.payload.percent ?? 0); }
          });
          const unlistenId = await ti.invoke("plugin:event|listen", {
            event: "proot://setup-progress",
            target: { kind: "Any" },
            handler: handlerId,
          });
          eventUnlisten = () => { try { ti.invoke("plugin:event|unlisten", { event: unlistenId }); } catch {} };
        } catch {}
      }

      setStage("checking");
      const status = await invoke("plugin:proot|proot_setup_status");
      if (status?.complete !== true) {
        setStage("downloading"); setProgress(0);
        await invoke("plugin:proot|proot_setup_start");
      }
      if (cancelled) return;

      setStage("starting"); setProgress(0);
      await invoke("plugin:proot|proot_start");

      setStage("health"); setProgress(0);
      for (let i = 0; i < 60 && !cancelled; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const healthList = await invoke("plugin:proot|proot_health") as Array<{ name: string; healthy: boolean }>;
          const coreServices = healthList.filter((s) => ["sovereign-shield", "file-api", "agent-bridge"].includes(s.name));
          const allHealthy = coreServices.length > 0 && coreServices.every((s: { healthy: boolean }) => s.healthy);
          setProgress(Math.min(Math.round(((i + 1) / 60) * 100), allHealthy ? 100 : 95));
          if (allHealthy) break;
        } catch {}
      }
    };

    const runLima = async () => {
      setStage("checking");
      const st = await invoke("lima_status") as { installed: boolean; vmState: string; templateExists: boolean; provisioned: boolean };
      if (!st.installed) throw new Error("Lima is not installed. Install with: brew install lima");
      if (!st.templateExists) throw new Error("Lima template not found. Run the ellul installer first.");

      if (st.vmState !== "running" || !st.provisioned) {
        setStage("provisioning"); setProgress(0);
        await invoke("lima_setup");
        await invoke("plugin:shield|shield_reload_http");
      }
      if (cancelled) return;

      setStage("health"); setProgress(0);
      let allHealthy = false;
      for (let i = 0; i < 90 && !cancelled; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const healthList = await invoke("lima_health") as Array<{ name: string; healthy: boolean }>;
          allHealthy = healthList.length > 0 && healthList.every((s: { healthy: boolean }) => s.healthy);
          setProgress(Math.min(Math.round(((i + 1) / 90) * 100), allHealthy ? 100 : 95));
          if (allHealthy) break;
        } catch {}
      }
      if (!allHealthy) throw new Error("Services did not become healthy within timeout");
    };

    const run = async () => {
      try {
        if (engine === "lima") await runLima();
        else await runProot();

        if (cancelled) return;

        setStage("ready"); setProgress(100);
        await new Promise((r) => setTimeout(r, 500));
        onComplete();
      } catch (e: any) {
        if (!cancelled) {
          setStage("failed");
          setError(typeof e === "string" ? e : e?.message ?? "Setup failed");
        }
      }
    };

    run();
    return () => { cancelled = true; startedRef.current = false; eventUnlisten?.(); };
  }, []);

  const handleRetry = () => {
    startedRef.current = false;
    setStage("checking");
    setProgress(0);
    setError(null);
    startedRef.current = false;
    // Force re-run by remounting
    window.location.reload();
  };

  const stageLabel = useMemo(() => {
    const key = LOCAL_STAGE_KEYS[stage];
    if (!key) return "";
    try { return t(key as any); } catch { return stage; }
  }, [stage, t]);

  const showProgress = stage === "downloading" || stage === "extracting" || stage === "provisioning" || stage === "health";

  return (
    <div className="fixed inset-0 flex items-center justify-center z-10 bg-background/95 backdrop-blur-sm p-4">
      <div className="max-w-lg w-full">
        <div className="panel-ascente p-6 sm:p-10">
          {stage !== "failed" ? (
            <>
              <div className="flex items-center justify-center py-6">
                <div className="relative">
                  <div className="w-20 h-20 rounded-full border-4 border-sodium/20" />
                  <div className="absolute inset-0 w-20 h-20 rounded-full border-4 border-sodium border-t-transparent animate-spin" />
                  <div className="absolute inset-0 flex items-center justify-center">
                    <EllulLogo className="h-7 w-7 text-sodium" />
                  </div>
                </div>
              </div>
              <h2 className="mb-3 text-2xl font-semibold text-center text-cream">
                {t("title")}
              </h2>
              <p className="text-center text-sodium text-sm font-medium mb-2">
                {stageLabel}
              </p>
              {showProgress && progress > 0 && (
                <div className="max-w-xs mx-auto mb-3">
                  <div className="w-full h-1.5 bg-cream/5 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full bg-sodium transition-all duration-500 ease-out"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                </div>
              )}
              <p className="text-center text-cream/60 text-sm">
                {t("wait")}
              </p>
            </>
          ) : (
            <>
              <div className="flex items-center justify-center py-6">
                <div className="w-20 h-20 rounded-full border-4 border-terra/30 flex items-center justify-center">
                  <svg className="h-8 w-8 text-terra" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                  </svg>
                </div>
              </div>
              <h2 className="mb-3 text-2xl font-semibold text-center text-cream">
                {t("failedTitle")}
              </h2>
              {error && <p className="text-center text-terra text-sm mb-4">{error}</p>}
              <div className="flex gap-3 justify-center">
                <Button variant="outline" size="sm" className="border-cream/[0.08] text-cream/75" onClick={onBack}>
                  {t("back")}
                </Button>
                <Button size="sm" className="bg-sodium hover:bg-sodium/90 text-ink" onClick={handleRetry}>
                  {t("retry")}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function TauriSetupScreen({ onLocalReady }: { onLocalReady: () => void }) {
  const [step, setStep] = useState<"choose" | "connect" | "local">(() => {
    if (typeof window !== "undefined") {
      const cfg = (window as any).__ELLUL_APP_CONFIG__;
      if (cfg?.mode === "local") return "local";
      if (localStorage.getItem(CONNECT_STORAGE_KEY)) return "connect";
    }
    return "choose";
  });
  const [connectStatus, setConnectStatus] = useState<"idle" | "waiting" | "establishing">(() => {
    if (typeof window !== "undefined" && localStorage.getItem(CONNECT_STORAGE_KEY)) return "waiting";
    return "idle";
  });

  const pollForConnect = useCallback(async (connectId: string) => {
    const invoke = (window as any).__TAURI_INTERNALS__?.invoke;
    if (!invoke) return;
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      if (!localStorage.getItem(CONNECT_STORAGE_KEY)) return;
      try {
        const data = await invoke("poll_connect", { connectId });
        if (data.status === "complete" && data.code) {
          setConnectStatus("establishing");
          localStorage.removeItem(CONNECT_STORAGE_KEY);
          const domain = data.hasServer ? data.serverDomain : null;
          const newCfg = await invoke("set_app_mode", { mode: "cloud", cloudDomain: domain });
          (window as any).__ELLUL_APP_CONFIG__ = newCfg;
          const establishUrl = `${TAURI_API_URL}/api/auth/native/session/establish?code=${encodeURIComponent(data.code)}&redirect=${encodeURIComponent(CONSOLE_URL + "/dashboard")}`;
          window.location.replace(establishUrl);
          return;
        }
      } catch {}
    }
    localStorage.removeItem(CONNECT_STORAGE_KEY);
    setConnectStatus("idle");
  }, []);

  useEffect(() => {
    const pendingId = localStorage.getItem(CONNECT_STORAGE_KEY);
    if (pendingId) pollForConnect(pendingId);
  }, [pollForConnect]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        const pendingId = localStorage.getItem(CONNECT_STORAGE_KEY);
        if (pendingId) {
          setStep("connect");
          setConnectStatus("waiting");
          pollForConnect(pendingId);
        }
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [pollForConnect]);

  const handleChooseLocal = async () => {
    const invoke = (window as any).__TAURI_INTERNALS__?.invoke;
    if (!invoke) return;
    try {
      const newCfg = await invoke("set_app_mode", { mode: "local" });
      (window as any).__ELLUL_APP_CONFIG__ = newCfg;
      setStep("local");
    } catch {}
  };

  const handleChooseCloud = () => setStep("connect");

  const handleConnect = async () => {
    const invoke = (window as any).__TAURI_INTERNALS__?.invoke;
    if (!invoke) return;
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let connectId = "";
    for (let i = 0; i < 32; i++) connectId += chars[Math.floor(Math.random() * chars.length)];
    localStorage.setItem(CONNECT_STORAGE_KEY, connectId);
    setConnectStatus("waiting");
    const connectUrl = `${CONSOLE_URL}/connect?connect_id=${connectId}`;
    try {
      await invoke("plugin:shield|shield_open_url", { url: connectUrl });
    } catch {
      try {
        await invoke("open_external", { url: connectUrl });
      } catch {
        window.open(connectUrl, "_blank");
      }
    }
    pollForConnect(connectId);
  };

  if (step === "local") {
    return <LocalProvisioningScreen onBack={() => setStep("choose")} onComplete={onLocalReady} />;
  }

  if (step === "connect") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="text-center max-w-sm p-8">
          <div className="w-16 h-16 rounded-2xl bg-sodium/10 border border-sodium/20 flex items-center justify-center mx-auto mb-6">
            <svg className="h-8 w-8 text-sodium" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15a4.5 4.5 0 004.5 4.5H18a3.75 3.75 0 001.332-7.257 3 3 0 00-3.758-3.848 5.25 5.25 0 00-10.233 2.33A4.502 4.502 0 002.25 15z" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-cream mb-2">Connect to cloud</h2>
          <p className="text-sm text-cream/60 mb-8">
            Sign in with your browser to connect to your cloud development environment.
          </p>
          <Button
            onClick={handleConnect}
            disabled={connectStatus !== "idle"}
            className="w-full bg-sodium hover:bg-sodium/90 text-ink font-medium"
            size="lg"
          >
            {connectStatus === "waiting" ? "Waiting for sign-in..." : connectStatus === "establishing" ? "Connecting..." : "Connect to Cloud"}
          </Button>
          <button
            onClick={() => { localStorage.removeItem(CONNECT_STORAGE_KEY); setStep("choose"); setConnectStatus("idle"); }}
            className="mt-4 text-sm text-cream/40 hover:text-cream/60 transition-colors"
          >
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="max-w-md w-full p-8">
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-sodium/10 border border-sodium/20 flex items-center justify-center mx-auto mb-6">
            <svg className="h-8 w-8 text-sodium" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-cream">Welcome to ellul.ai</h2>
          <p className="text-sm text-cream/60 mt-2">Choose how you want to code</p>
        </div>
        <div className="space-y-3">
          <button
            onClick={handleChooseLocal}
            className="w-full text-left rounded-xl border border-cream/10 hover:border-sodium/40 bg-cream/[0.02] hover:bg-cream/[0.04] p-4 transition-all group"
          >
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                <svg className="h-5 w-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 1.5H8.25A2.25 2.25 0 006 3.75v16.5a2.25 2.25 0 002.25 2.25h7.5A2.25 2.25 0 0018 20.25V3.75a2.25 2.25 0 00-2.25-2.25H13.5m-3 0V3h3V1.5m-3 0h3m-3 18.75h3" />
                </svg>
              </div>
              <div>
                <div className="font-medium text-cream group-hover:text-sodium transition-colors">Free &mdash; On Device</div>
                <div className="text-sm text-cream/50 mt-0.5">Run a full dev environment locally on your device. No account needed.</div>
              </div>
            </div>
          </button>
          <button
            onClick={handleChooseCloud}
            className="w-full text-left rounded-xl border border-cream/10 hover:border-sodium/40 bg-cream/[0.02] hover:bg-cream/[0.04] p-4 transition-all group"
          >
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-lg bg-sodium/10 border border-sodium/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                <svg className="h-5 w-5 text-sodium" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15a4.5 4.5 0 004.5 4.5H18a3.75 3.75 0 001.332-7.257 3 3 0 00-3.758-3.848 5.25 5.25 0 00-10.233 2.33A4.502 4.502 0 002.25 15z" />
                </svg>
              </div>
              <div>
                <div className="font-medium text-cream group-hover:text-sodium transition-colors">Cloud VPS</div>
                <div className="text-sm text-cream/50 mt-0.5">Dedicated cloud server with full Linux, AI agents, and passkey security.</div>
              </div>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}

function TauriAuthScreen({ domain, onAuthenticated }: { domain: string; onAuthenticated: () => void }) {
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const handlePasskeyLogin = async () => {
    setIsAuthenticating(true);
    setAuthError(null);
    try {
      await (window as any).__TAURI_INTERNALS__.invoke(
        "plugin:shield|shield_passkey_login",
        { serverDomain: domain },
      );
      onAuthenticated();
    } catch (e) {
      setAuthError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsAuthenticating(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="text-center max-w-sm p-8">
        <div className="w-16 h-16 rounded-2xl bg-sodium/10 border border-sodium/20 flex items-center justify-center mx-auto mb-6">
          <svg className="h-8 w-8 text-sodium" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
          </svg>
        </div>
        <h2 className="text-xl font-semibold text-cream mb-2">Sign in to your server</h2>
        <p className="text-sm text-cream/60 mb-8">
          Authenticate with your passkey to access {domain}.
        </p>
        <Button
          onClick={handlePasskeyLogin}
          disabled={isAuthenticating}
          className="w-full bg-sodium hover:bg-sodium/90 text-ink font-medium"
          size="lg"
        >
          {isAuthenticating ? "Authenticating..." : "Login with Passkey"}
        </Button>
        {authError && (
          <p className="mt-4 text-xs text-red-400">{authError}</p>
        )}
      </div>
    </div>
  );
}

function DashboardLayoutContent({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const t = useTranslations("console");
  const [session, setSession] = useState<Session | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [tauriNeedsConnect, setTauriNeedsConnect] = useState(false);
  const [isLocalMode, setIsLocalMode] = useState(
    typeof window !== "undefined" &&
      (window.location.hostname === "localhost" ||
        window.location.hostname === "127.0.0.1"),
  );
  const isTauri = isTauriApp();

  const activateLocalMode = useCallback(() => {
    setIsLocalMode(true);
    setTauriNeedsConnect(false);
    setSession({
      user: { id: "local", name: "Local User", email: "local@localhost", emailVerified: true, image: null, createdAt: new Date(), updatedAt: new Date() },
      session: { id: "local", userId: "local", token: "local", expiresAt: new Date(Date.now() + 86400000), createdAt: new Date(), updatedAt: new Date(), ipAddress: "127.0.0.1", userAgent: "" },
    });
    setIsAuthLoading(false);
  }, []);

  // ── Tier / checkout ──

  const [checkoutMessage, setCheckoutMessage] = useState<{
    type: "success" | "cancelled";
    message: string;
  } | null>(null);
  const [selectedTier, setSelectedTier] = useState("cloud_platform:hobby");
  const [awaitingPaymentConfirmation, setAwaitingPaymentConfirmation] =
    useState(false);
  const [tierChangeError, setTierChangeError] = useState<string | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.message) {
        setTierChangeError(detail.message);
        setTimeout(() => setTierChangeError(null), 15000);
      }
    };
    window.addEventListener("ellul:tier-change-error", handler);
    return () =>
      window.removeEventListener("ellul:tier-change-error", handler);
  }, []);

  useEffect(() => {
    const checkout = searchParams.get("checkout");
    const tier = searchParams.get("tier") as string | null;
    if (checkout === "success") {
      if (tier) setSelectedTier(tier);
      setAwaitingPaymentConfirmation(true);
      router.replace("/dashboard");
    } else if (checkout === "cancelled") {
      setCheckoutMessage({
        type: "cancelled",
        message: "Checkout was cancelled. You can try again when ready.",
      });
      router.replace("/dashboard");
    }
  }, [searchParams, router]);

  // ── Authentication ──

  useEffect(() => {
    if (MOCK_MODE) {
      setSession(mockSession);
      setIsAuthLoading(false);
      return;
    }
    if (isLocalMode && session) return;
    const checkSession = async () => {
      const isLocalhost =
        typeof window !== "undefined" &&
        (window.location.hostname === "localhost" ||
          window.location.hostname === "127.0.0.1");
      if (isLocalhost) {
        try {
          const healthUrl = `${window.location.protocol}//${window.location.host}/health`;
          const r = await fetch(healthUrl, { credentials: "include" });
          if (r.ok) {
            activateLocalMode();
            return;
          }
        } catch {}
      }
      if (isTauriApp()) {
        const invoke = (window as any).__TAURI_INTERNALS__?.invoke;
        let appConfig = (window as any).__ELLUL_APP_CONFIG__;
        if (invoke) {
          try {
            appConfig = await invoke("get_app_mode");
            (window as any).__ELLUL_APP_CONFIG__ = appConfig;
          } catch {}
        }
        const engine = getLocalEngine();
        if (engine === "proot" && invoke) {
          for (let attempt = 0; attempt < 30; attempt++) {
            try {
              const health = await invoke("plugin:proot|proot_health") as { name: string; healthy: boolean }[];
              const allHealthy = health?.length > 0 && health.every((s) => s.healthy);
              if (allHealthy) {
                activateLocalMode();
                return;
              }
            } catch {}
            if (attempt < 29) await new Promise((r) => setTimeout(r, 2000));
          }
        }
        if (appConfig?.mode === "local") {
          let localRunning = false;
          if (invoke) {
            try {
              if (engine === "lima") {
                const st = await invoke("lima_status") as { vmState: string; provisioned: boolean };
                localRunning = st?.vmState === "running" && st?.provisioned === true;
              }
            } catch {}
          }
          if (localRunning) {
            activateLocalMode();
            return;
          }
          setTauriNeedsConnect(true);
          setIsAuthLoading(false);
          return;
        }
        if (appConfig?.mode !== "cloud") {
          setTauriNeedsConnect(true);
          setIsAuthLoading(false);
          return;
        }
      }
      const MAX_RETRIES = 3;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const { data, error } = await getSession();
        if (data) {
          setSession(data);
          return;
        }
        const isTransient = error && typeof error === "object" && "status" in error &&
          ((error as { status?: number }).status === undefined || (error as { status?: number }).status! >= 500);
        if (isTransient && attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
          continue;
        }
        if (isTauriApp()) {
          const tauriCfg = (window as any).__ELLUL_APP_CONFIG__;
          if (tauriCfg?.mode === "cloud") {
            window.location.href = `${CONSOLE_URL}/sign-in`;
          } else {
            setTauriNeedsConnect(true);
          }
          return;
        }
        window.location.href = WEB_URL;
        return;
      }
    };
    checkSession().finally(() => setIsAuthLoading(false));
  }, [router]);

  useLocaleSync(session);

  // ── SSE + server status ──

  const sseConnectedRef = useRef(false);
  const serverStateRef = useRef<string | undefined>(undefined);
  // True while a signed apply-pending-update command is in flight on
  const applyInProgressRef = useRef(false);

  const [activeServerId, setActiveServerId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return localStorage.getItem("ellul-active-server") || null;
  });
  const updateActiveServer = useCallback((id: string | null) => {
    setActiveServerId(id);
    if (id) localStorage.setItem("ellul-active-server", id);
    else localStorage.removeItem("ellul-active-server");
  }, []);

  const {
    data: serverStatus,
    isLoading: isStatusLoading,
    error: statusError,
  } = useQuery<ServerStatus>({
    // rest of the app's query-key convention (security-tier,
    // snapshot (staleTime Infinity compounds any cache-miss bug). Now
    queryKey: ["server-status"],
    queryFn: async () => {
      const response = await api.api.servers.status.$get();
      if (!response.ok) throw new Error("Failed to fetch server status");
      return response.json() as Promise<ServerStatus>;
    },
    enabled: !MOCK_MODE && !isLocalMode && !!session,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: 5,
    retryDelay: (attempt) => Math.min(1000 * Math.pow(2, attempt), 10_000),
    refetchInterval: (query) => {
      // No data yet (initial load failed) — retry aggressively
      if (!query.state.data) return 5_000;
      // Safety net: poll every 5s during transitional states even when SSE is
      // stream buffering, or network issues that don't trigger reconnect.
      if (isTransitionalState(serverStateRef.current)) return 5_000;
      // An in-flight apply-pending-update is also transitional for UX
      if (applyInProgressRef.current) return 5_000;
      return sseConnectedRef.current ? false : 30_000;
    },
  });

  serverStateRef.current = serverStatus?.state;
  applyInProgressRef.current = serverStatus?.agentUpdate?.applyInProgress === true;

  const allServers = (
    serverStatus as unknown as Record<string, unknown>
  )?.servers as Array<ServerSummary> | undefined;

  useEffect(() => {
    if (!allServers?.length) return;
    const ids = allServers
      .map((s) => s.server?.id)
      .filter((id): id is string => !!id);
    if (activeServerId && ids.includes(activeServerId)) return;
    const firstId = ids[0];
    if (firstId) updateActiveServer(firstId);
  }, [allServers, activeServerId, updateActiveServer]);

  // ── Local health polling ──

  const [localHealth, setLocalHealth] = useState<Array<{ name: string; healthy: boolean }> | null>(null);

  useEffect(() => {
    if (!isLocalMode) return;
    let cancelled = false;
    const healthUrl = `${window.location.protocol}//${window.location.host}/health`;
    const fetchHealth = async () => {
      try {
        const r = await fetch(healthUrl, { credentials: "include", signal: AbortSignal.timeout(3000) });
        const healthy = r.ok;
        if (!cancelled) setLocalHealth([
          { name: "sovereign-shield", healthy },
          { name: "file-api", healthy },
          { name: "agent-bridge", healthy },
        ]);
      } catch {
        if (!cancelled) setLocalHealth([
          { name: "sovereign-shield", healthy: false },
          { name: "file-api", healthy: false },
          { name: "agent-bridge", healthy: false },
        ]);
      }
    };
    const invoke = (window as any).__TAURI_INTERNALS__?.invoke;
    const engine = getLocalEngine();
    const cmd = engine === "lima" ? "lima_health" : "plugin:proot|proot_health";
    const poll = async () => {
      if (invoke) {
        try {
          const h = await invoke(cmd) as Array<{ name: string; healthy: boolean }>;
          if (!cancelled) setLocalHealth(h);
          return;
        } catch {}
      }
      await fetchHealth();
    };
    poll();
    const interval = setInterval(poll, 10_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [isLocalMode]);

  const hasServer = !!serverStatus?.server || isLocalMode;
  const { isConnected: sseConnected } = useServerEvents({
    enabled: !MOCK_MODE && !isLocalMode && !!session && hasServer && !!activeServerId,
    serverId: activeServerId,
  });
  sseConnectedRef.current = sseConnected;

  const effectiveServerStatus = MOCK_MODE ? mockServerStatus : isLocalMode ? buildLocalServerStatus(localHealth) : serverStatus;
  const effectiveIsStatusLoading = MOCK_MODE ? false : isLocalMode ? false : isStatusLoading;

  // ── Mutations ──

  const mutations = useServerMutations(serverStatus);

  // ── Lifecycle (wake, resize, transitions, encryption) ──

  const lifecycle = useServerLifecycle(
    serverStatus,
    effectiveServerStatus,
    mutations.wakeServerMutation,
    mutations.triggerRapidPoll,
    isLocalMode,
  );

  // ── Desktop integration ──

  const { updateServerStatus } = useDesktopIntegration(
    () => {},
    () => {},
  );
  useEffect(() => {
    if (effectiveServerStatus?.state)
      updateServerStatus(effectiveServerStatus.state);
  }, [effectiveServerStatus?.state, updateServerStatus]);

  useEffect(() => {
    if (awaitingPaymentConfirmation && serverStatus?.hasActiveSubscription)
      setAwaitingPaymentConfirmation(false);
  }, [awaitingPaymentConfirmation, serverStatus?.hasActiveSubscription]);

  // ── Auto-provision ──

  const [autoProvisionTriggered, setAutoProvisionTriggered] = useState(false);
  useEffect(() => {
    if (
      serverStatus?.hasActiveSubscription &&
      serverStatus?.state === "none" &&
      !mutations.createServerMutation.isPending &&
      !autoProvisionTriggered
    ) {
      setAutoProvisionTriggered(true);
      mutations.createServerMutation.mutate({
        product: "cloud_platform",
        plan: selectedTier.endsWith(":hobby") ? "hobby" : "pro",
      });
    }
  }, [
    serverStatus?.hasActiveSubscription,
    serverStatus?.state,
    mutations.createServerMutation,
    selectedTier,
    autoProvisionTriggered,
  ]);

  // ── Signup tier from sessionStorage ──

  const [signupTierHandled, setSignupTierHandled] = useState(false);
  useEffect(() => {
    if (
      serverStatus?.state !== "none" ||
      signupTierHandled ||
      serverStatus?.hasActiveSubscription
    )
      return;
    const signupProductPlan = sessionStorage.getItem("ps_signup_product_plan");
    if (!signupProductPlan) return;
    sessionStorage.removeItem("ps_signup_product_plan");
    setSignupTierHandled(true);
    const [signupProduct, signupPlan] = signupProductPlan.includes(":")
      ? (signupProductPlan.split(":") as [string, string])
      : [signupProductPlan, "hobby"];
    mutations.checkoutMutation.mutate({
      product: signupProduct as
        | "cloud_platform"
        | "shield_proxy",
      plan: signupPlan as "hobby" | "pro",
    });
  }, [
    serverStatus?.state,
    signupTierHandled,
    serverStatus?.hasActiveSubscription,
    mutations.createServerMutation,
    mutations.checkoutMutation,
    selectedTier,
  ]);

  // ── Terminal token pre-fetch ──

  const [authReady, setAuthReady] = useState(MOCK_MODE || isLocalMode);
  const terminalServerId =
    effectiveServerStatus?.state === "running"
      ? effectiveServerStatus.server?.id
      : null;
  const terminalEnabled =
    effectiveServerStatus?.server?.terminalEnabled ?? true;
  const activeServerTier = effectiveServerStatus?.server?.securityTier;

  useEffect(() => {
    if (
      MOCK_MODE ||
      isLocalMode ||
      !terminalServerId ||
      !terminalEnabled ||
      activeServerTier !== "standard"
    ) {
      setAuthReady(true);
      return;
    }
    const controller = new AbortController();
    fetch(`${API_URL}/api/servers/${terminalServerId}/terminal/token`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
    })
      .then(() => setAuthReady(true))
      .catch(() => {
        if (!controller.signal.aborted) setAuthReady(true);
      });
    return () => controller.abort();
  }, [terminalServerId, terminalEnabled, activeServerTier]);

  // ── Hooks above early returns (Rules of Hooks) ──

  usePushRegistration();
  useBackgroundPersistence();

  const { sessionInfo, forceRefresh: refreshHeartbeat } = useBrowserHeartbeat(
    MOCK_MODE || isLocalMode
      ? null
      : effectiveServerStatus?.state === "running"
        ? (effectiveServerStatus?.server?.id ?? null)
        : null,
    effectiveServerStatus?.server?.product === "shield_proxy"
      ? "shield_proxy"
      : effectiveServerStatus?.server?.serverPlan,
  );

  // ── Loading guard ──

  if (isTauri && tauriNeedsConnect) {
    return <TauriSetupScreen onLocalReady={() => {
      activateLocalMode();
    }} />;
  }

  if (isAuthLoading || effectiveIsStatusLoading) {
    return <LoadingScreen message="Loading dashboard..." />;
  }

  if (!MOCK_MODE && !isLocalMode && session && !serverStatus && statusError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <div className="panel-ascente max-w-md w-full p-8 text-center">
          <h2 className="text-xl font-semibold text-cream mb-3">{t("connection.title")}</h2>
          <p className="text-cream/60 text-sm mb-6">
            {t("connection.retryingMessage")}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="border-cream/[0.08] text-cream/75"
            onClick={() => queryClient.invalidateQueries({ queryKey: ["server-status"] })}
          >
            {t("connection.retryNow")}
          </Button>
        </div>
      </div>
    );
  }

  if (!MOCK_MODE && !isLocalMode && session && !serverStatus) {
    return <LoadingScreen message="Loading dashboard..." />;
  }

  // ── Render ──

  return (
    <DashboardShell
      session={session}
      serverStatus={serverStatus}
      effectiveServerStatus={effectiveServerStatus}
      effectiveIsStatusLoading={effectiveIsStatusLoading}
      isStatusLoading={isStatusLoading}
      statusError={statusError as Error | null}
      allServers={allServers || []}
      activeServerId={activeServerId}
      updateActiveServer={updateActiveServer}
      selectedTier={selectedTier}
      setSelectedTier={setSelectedTier}
      mutations={mutations}
      authReady={authReady}
      resizeElapsed={lifecycle.resizeElapsed}
      wakeElapsed={lifecycle.wakeElapsed}
      setAutoWakeTriggered={lifecycle.setAutoWakeTriggered}
      setWakeStartedAt={lifecycle.setWakeStartedAt}
      setWakeElapsed={lifecycle.setWakeElapsed}
      unlockError={lifecycle.unlockError}
      setUnlockError={lifecycle.setUnlockError}
      isUnlocking={lifecycle.isUnlocking}
      getPrfKey={lifecycle.getPrfKey}
      prfKeyRef={lifecycle.prfKeyRef}
      unlockVolume={lifecycle.unlockVolume}
      checkoutMessage={checkoutMessage}
      setCheckoutMessage={setCheckoutMessage}
      tierChangeError={tierChangeError}
      setTierChangeError={setTierChangeError}
      awaitingPaymentConfirmation={awaitingPaymentConfirmation}
      setAutoProvisionTriggered={setAutoProvisionTriggered}
      sessionInfo={sessionInfo}
      refreshHeartbeat={refreshHeartbeat}
      onRetryStatus={() =>
        queryClient.invalidateQueries({ queryKey: ["server-status"] })
      }
    >
      {children}
    </DashboardShell>
  );
}

function TauriGate({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!isTauriApp()) { setReady(true); return; }
    const cfg = (window as any).__ELLUL_APP_CONFIG__;
    if (cfg?.mode === "cloud" || cfg?.mode === "local") { setReady(true); return; }
    const invoke = (window as any).__TAURI_INTERNALS__?.invoke;
    if (!invoke) { setReady(true); return; }
    invoke("get_app_mode")
      .then((loaded: any) => { (window as any).__ELLUL_APP_CONFIG__ = loaded; })
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);

  if (!ready) return <LoadingScreen message="Loading..." />;
  return <>{children}</>;
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <TauriGate>
      <Suspense fallback={<LoadingScreen message="Loading dashboard..." />}>
        <DashboardLayoutContent>{children}</DashboardLayoutContent>
      </Suspense>
    </TauriGate>
  );
}
