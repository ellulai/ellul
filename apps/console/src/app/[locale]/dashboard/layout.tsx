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
import { isNativeApp } from "@/lib/utils";
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

function DashboardLayoutContent({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const t = useTranslations("console");
  const [session, setSession] = useState<Session | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);

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
      const MAX_RETRIES = 3;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const { data, error } = await getSession();
        if (data) {
          setSession(data);
          return;
        }
        // Distinguish "no session" (401) from transient API error (500/network)
        const isTransient = error && typeof error === "object" && "status" in error &&
          ((error as { status?: number }).status === undefined || (error as { status?: number }).status! >= 500);
        if (isTransient && attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
          continue;
        }
        // Either a definitive "no session" or exhausted retries
        window.location.href = isNativeApp() ? "/sign-up" : WEB_URL;
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
    enabled: !MOCK_MODE && !!session,
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
    enabled: !MOCK_MODE && !!session && hasServer && !!activeServerId,
    serverId: activeServerId,
  });
  sseConnectedRef.current = sseConnected;

  const effectiveServerStatus = MOCK_MODE ? mockServerStatus : serverStatus;
  const effectiveIsStatusLoading = MOCK_MODE ? false : isStatusLoading;

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

  if (isAuthLoading || effectiveIsStatusLoading) {
    return <LoadingScreen message="Loading dashboard..." />;
  }

  if (!MOCK_MODE && session && !serverStatus && statusError) {
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

  if (!MOCK_MODE && session && !serverStatus) {
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
