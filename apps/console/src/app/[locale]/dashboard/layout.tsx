// SPDX-License-Identifier: MIT
"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
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

function TauriConnectScreen() {
  const [status, setStatus] = useState<"idle" | "waiting" | "establishing">("idle");

  const handleConnect = async () => {
    const invoke = (window as any).__TAURI_INTERNALS__?.invoke;
    if (!invoke) return;
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let connectId = "";
    for (let i = 0; i < 32; i++) connectId += chars[Math.floor(Math.random() * chars.length)];
    const connectUrl = `${CONSOLE_URL}/connect?connect_id=${connectId}`;
    try {
      await invoke("open_external", { url: connectUrl });
    } catch { return; }
    setStatus("waiting");
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const data = await invoke("poll_connect", { connectId });
        if (data.status === "complete" && data.code) {
          setStatus("establishing");
          const domain = data.hasServer ? data.serverDomain : null;
          await invoke("set_app_mode", { mode: "cloud", cloudDomain: domain });
          const establishUrl = `${TAURI_API_URL}/api/auth/native/session/establish?code=${encodeURIComponent(data.code)}&redirect=${encodeURIComponent(CONSOLE_URL + "/dashboard")}`;
          window.location.replace(establishUrl);
          return;
        }
      } catch {}
    }
    setStatus("idle");
  };

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
          disabled={status !== "idle"}
          className="w-full bg-sodium hover:bg-sodium/90 text-ink font-medium"
          size="lg"
        >
          {status === "waiting" ? "Waiting for sign-in..." : status === "establishing" ? "Connecting..." : "Connect to Cloud"}
        </Button>
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
  const [tauriServerStatus, setTauriServerStatus] = useState<ServerStatus | null>(null);
  const [tauriNeedsAuth, setTauriNeedsAuth] = useState(false);
  const [tauriNeedsConnect, setTauriNeedsConnect] = useState(false);
  const isTauri = isTauriApp();

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
    const checkSession = async () => {
      if (isTauriApp()) {
        const invoke = (cmd: string, args?: Record<string, unknown>) =>
          (window as any).__TAURI_INTERNALS__.invoke(cmd, args);
        let domain: string | undefined;
        let hasShieldSession = false;
        const appConfig = (window as any).__ELLUL_APP_CONFIG__;
        domain = appConfig?.cloudDomain as string | undefined;
        try {
          const info = await invoke("plugin:shield|shield_session_info");
          if (info?.active) {
            hasShieldSession = true;
            if (!domain && info.serverDomain) domain = info.serverDomain;
          }
        } catch {}
        const stubSession = {
          user: { id: "tauri", name: "Local", email: "", image: null, emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
          session: { id: "tauri", userId: "tauri", token: "", expiresAt: new Date(Date.now() + 86400000), createdAt: new Date(), updatedAt: new Date() },
        } as Session;
        if (!domain) {
          setTauriNeedsConnect(true);
          setSession(stubSession);
          return;
        }
        let tier: "standard" | "web_locked" | "private_locked" = "standard";
        try {
          const probe = await fetch(`https://${domain}/_auth/login/options`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          });
          if (probe.status !== 404) tier = "web_locked";
        } catch {}
        setTauriServerStatus({
          state: "running",
          plan: "hobby",
          hasActiveSubscription: true,
          server: {
            id: domain.split("-")[0] || "tauri",
            ipAddress: "0.0.0.0",
            domain,
            createdAt: new Date().toISOString(),
            performanceStatus: "good" as const,
            size: "cx22",
            terminalEnabled: true,
            sshEnabled: true,
            securityTier: tier,
            serverPlan: "hobby" as const,
          },
        } as ServerStatus);
        if (tier !== "standard" && !hasShieldSession) setTauriNeedsAuth(true);
        setSession(stubSession);
        return;
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
    enabled: !MOCK_MODE && !isTauri && !!session,
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

  const hasServer = !!serverStatus?.server;
  const { isConnected: sseConnected } = useServerEvents({
    enabled: !MOCK_MODE && !isTauri && !!session && hasServer && !!activeServerId,
    serverId: activeServerId,
  });
  sseConnectedRef.current = sseConnected;

  const effectiveServerStatus = MOCK_MODE ? mockServerStatus : isTauri ? (tauriServerStatus ?? undefined) : serverStatus;
  const effectiveIsStatusLoading = MOCK_MODE || isTauri ? false : isStatusLoading;

  // ── Mutations ──

  const mutations = useServerMutations(serverStatus);

  // ── Lifecycle (wake, resize, transitions, encryption) ──

  const lifecycle = useServerLifecycle(
    serverStatus,
    effectiveServerStatus,
    mutations.wakeServerMutation,
    mutations.triggerRapidPoll,
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

  const [authReady, setAuthReady] = useState(MOCK_MODE);
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
    MOCK_MODE
      ? null
      : effectiveServerStatus?.state === "running"
        ? (effectiveServerStatus?.server?.id ?? null)
        : null,
    effectiveServerStatus?.server?.product === "shield_proxy"
      ? "shield_proxy"
      : effectiveServerStatus?.server?.serverPlan,
  );

  // ── Loading guard ──

  if (isAuthLoading || effectiveIsStatusLoading || (isTauri && !tauriNeedsConnect && !tauriServerStatus)) {
    return <LoadingScreen message="Loading dashboard..." />;
  }

  if (isTauri && tauriNeedsConnect) {
    return <TauriConnectScreen />;
  }

  if (isTauri && tauriNeedsAuth) {
    return (
      <TauriAuthScreen
        domain={tauriServerStatus!.server!.domain!}
        onAuthenticated={() => setTauriNeedsAuth(false)}
      />
    );
  }

  if (!MOCK_MODE && !isTauri && session && !serverStatus && statusError) {
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

  if (!MOCK_MODE && !isTauri && session && !serverStatus) {
    return <LoadingScreen message="Loading dashboard..." />;
  }

  // ── Render ──

  return (
    <DashboardShell
      session={session}
      serverStatus={isTauri ? (tauriServerStatus ?? undefined) : serverStatus}
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

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Suspense fallback={<LoadingScreen message="Loading dashboard..." />}>
      <DashboardLayoutContent>{children}</DashboardLayoutContent>
    </Suspense>
  );
}
