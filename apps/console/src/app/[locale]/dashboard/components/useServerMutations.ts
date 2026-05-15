// SPDX-License-Identifier: MIT
"use client";

import { useCallback, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { startRegistration } from "@simplewebauthn/browser";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/types";
import { api, API_URL } from "@/lib/api";
import { isValidServerOrigin } from "@/lib/domains";
import { extractPlan, isLockedTier } from "@/lib/tier-utils";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import type { ServerStatus } from "@/contexts/DashboardContext";

// ─── Types ────────────────────────────────────────────────────────

// Passkey-gated operations. Single source of truth lives in
import type { PasskeyOperation } from "@ellul.ai/vps/auth/valid-operations";

export interface VpsAuthDialogState {
  open: boolean;
  operation: PasskeyOperation | null;
  instructions: string;
  serverDomain?: string;
  tier?: string;
  requiresPasskey?: boolean;
  passkeyPending?: boolean;
}

// ─── Hook ─────────────────────────────────────────────────────────

export function useServerMutations(
  serverStatus: ServerStatus | undefined,
) {
  const queryClient = useQueryClient();
  const t = useTranslations("console");

  const [vpsAuthDialog, setVpsAuthDialog] = useState<VpsAuthDialogState>({
    open: false, operation: null, instructions: "",
  });
  const [actionPending, setActionPending] = useState(false);
  const actionTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pendingTierChangeRef = useRef<{
    serverId: string;
    newTier: string;
    newInterval: string;
    forceMigration?: boolean;
  } | null>(null);
  const pendingAgentUpdateModeRef = useRef<"auto" | "manual" | null>(null);

  const triggerRapidPoll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["server-status"] });
    setActionPending(true);
    clearTimeout(actionTimerRef.current);
    actionTimerRef.current = setTimeout(() => setActionPending(false), 30000);
  }, [queryClient]);

  // ── Create server ──

  const createServerMutation = useMutation({
    mutationFn: async ({ product, plan }: { product: string; plan?: string }) => {
      const response = await api.api.servers.$post({
        json: {
          product: product as "cloud_platform" | "shield_proxy",
          plan: (plan || "hobby") as "free" | "hobby" | "pro",
        },
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error((error as { error?: string }).error || "Failed to create server");
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["server-status"] });
    },
  });

  // ── Wake server ──

  const wakeServerMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch(`${API_URL}/api/servers/wake`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      if (!response.ok) {
        if (response.status === 409) return { alreadyWaking: true };
        const error = await response.json();
        throw new Error((error as { error?: string }).error || "Failed to wake server");
      }
      return response.json();
    },
    onSuccess: () => {
      triggerRapidPoll();
    },
  });

  // ── Stripe checkout ──

  const checkoutMutation = useMutation({
    mutationFn: async ({
      product,
      plan,
      interval,
    }: {
      product: "cloud_platform" | "shield_proxy";
      plan?: "hobby" | "pro";
      interval?: "monthly" | "annual";
    }) => {
      const response = await api.api.stripe.checkout.$post({
        json: { product, plan: plan || "pro", interval },
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error((error as { error?: string }).error || "Failed to create checkout");
      }
      return response.json() as Promise<{ url: string }>;
    },
    onSuccess: (data) => {
      window.location.href = data.url;
    },
  });

  // ── Billing portal ──

  const portalMutation = useMutation({
    mutationFn: async () => {
      const response = await api.api.stripe.portal.$post();
      if (!response.ok) {
        const error = await response.json();
        throw new Error((error as { error?: string }).error || "Failed to open billing portal");
      }
      return response.json() as Promise<{ url: string }>;
    },
    onSuccess: (data) => {
      window.location.href = data.url;
    },
  });

  // ── Protected server mutations (common passkey-challenge pattern) ──

  type ProtectedErrorBody = {
    error?: string; tier?: string; requiresPasskey?: boolean;
    instructions?: string; serverDomain?: string; code?: string;
  };

  const protectedFetch = async (
    url: string,
    method: string,
    operation: VpsAuthDialogState["operation"],
    passkeyConfirmation?: string,
    body?: Record<string, unknown>,
  ) => {
    const headers: Record<string, string> = {};
    if (body) headers["Content-Type"] = "application/json";
    if (passkeyConfirmation) headers["X-VPS-Confirm-Token"] = passkeyConfirmation;
    const response = await fetch(url, {
      method, credentials: "include", headers, ...(body && { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const error = (await response.json()) as ProtectedErrorBody;
      if (isLockedTier(error.tier) && error.requiresPasskey) {
        setVpsAuthDialog({
          open: true, operation,
          instructions: t("toasts.passkeyConfirm", { operation }),
          serverDomain: error.serverDomain, tier: error.tier || "web_locked", requiresPasskey: true,
        });
        throw new Error("PASSKEY_REQUIRED");
      }
      throw new Error(error.error || `Failed to ${operation} server`);
    }
    return response.json();
  };

  const protectedMutationCallbacks = {
    onSuccess: () => { triggerRapidPoll(); setVpsAuthDialog({ open: false, operation: null, instructions: "" }); },
    onError: (error: Error) => { if (error.message !== "PASSKEY_REQUIRED") toast.error(error.message); },
  };

  const deleteServerMutation = useMutation({
    mutationFn: async ({ serverId, passkeyConfirmation }: { serverId: string; passkeyConfirmation?: string }) =>
      protectedFetch(`${API_URL}/api/servers/${serverId}`, "DELETE", "delete", passkeyConfirmation),
    ...protectedMutationCallbacks,
  });

  const rebuildServerMutation = useMutation({
    mutationFn: async ({ serverId, passkeyConfirmation }: { serverId: string; passkeyConfirmation?: string }) =>
      protectedFetch(`${API_URL}/api/servers/${serverId}/rebuild`, "POST", "rebuild", passkeyConfirmation),
    onSuccess: (data) => {
      protectedMutationCallbacks.onSuccess();
      const token = (data as { credentials?: { aiProxyToken?: string } }).credentials?.aiProxyToken;
      if (token) toast.success(t("toasts.rebuildStarted"), { description: t("toasts.rebuildDescription"), duration: 8000 });
    },
    onError: protectedMutationCallbacks.onError,
  });

  const rollbackServerMutation = useMutation({
    mutationFn: async ({ serverId, passkeyConfirmation }: { serverId: string; passkeyConfirmation?: string }) =>
      protectedFetch(`${API_URL}/api/servers/${serverId}/rollback`, "POST", "rollback", passkeyConfirmation),
    ...protectedMutationCallbacks,
  });

  // Apply a pending agent-manifest update. The VPS enters Manual mode
  const updateServerMutation = useMutation({
    mutationFn: async ({
      serverId,
      passkeyConfirmation,
    }: {
      serverId: string;
      passkeyConfirmation?: string;
    }) =>
      protectedFetch(
        `${API_URL}/api/servers/${serverId}/update`,
        "POST",
        "update",
        passkeyConfirmation,
      ),
    // Optimistic banner flip: mark applyInProgress=true in the cache
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["server-status"] });
      const previous = queryClient.getQueryData(["server-status"]) as
        | Record<string, unknown>
        | undefined;
      if (previous?.agentUpdate) {
        const prevAgentUpdate = previous.agentUpdate as Record<string, unknown>;
        queryClient.setQueryData(["server-status"], {
          ...previous,
          agentUpdate: {
            ...prevAgentUpdate,
            applyInProgress: true,
            applyInProgressVersion:
              (prevAgentUpdate.pendingUpdateVersion as number | null) ?? null,
          },
        });
      }
      return { previous };
    },
    onSuccess: () => {
      protectedMutationCallbacks.onSuccess();
      toast.success(t("toasts.updateQueued"), {
        description: t("toasts.updateQueuedDescription"),
        duration: 6000,
      });
    },
    onError: (error: Error, _vars, context) => {
      // Roll back the optimistic applyInProgress flip on enqueue
      if (context && typeof context === "object" && "previous" in context) {
        const ctx = context as { previous?: Record<string, unknown> };
        if (ctx.previous) {
          queryClient.setQueryData(["server-status"], ctx.previous);
        }
      }
      protectedMutationCallbacks.onError(error);
    },
  });

  // Toggle the VPS's agent auto-update mode. Enqueues a signed
  const setAgentUpdateModeMutation = useMutation({
    mutationFn: async ({
      serverId,
      mode,
      passkeyConfirmation,
    }: {
      serverId: string;
      mode: "auto" | "manual";
      passkeyConfirmation?: string;
    }) =>
      protectedFetch(
        `${API_URL}/api/servers/${serverId}/agent-update-mode`,
        "POST",
        "update-mode",
        passkeyConfirmation,
        { mode },
      ),
    onSuccess: (_data, vars) => {
      protectedMutationCallbacks.onSuccess();
      toast.success(
        vars.mode === "auto"
          ? t("toasts.autoUpdatesEnabled")
          : t("toasts.manualUpdatesEnabled"),
        {
          description:
            vars.mode === "auto"
              ? t("toasts.autoUpdatesDescription")
              : t("toasts.manualUpdatesDescription"),
          duration: 6000,
        },
      );
    },
    onError: protectedMutationCallbacks.onError,
  });

  // ── Change tier ──

  const changeTierMutation = useMutation({
    mutationFn: async ({
      serverId,
      newTier,
      newInterval,
      forceMigration,
      passkeyConfirmation,
    }: {
      serverId: string;
      newTier: string;
      newInterval: string;
      forceMigration?: boolean;
      passkeyConfirmation?: string;
    }) => {
      const response = await fetch(`${API_URL}/api/servers/${serverId}/change-tier`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(passkeyConfirmation && { "X-VPS-Confirm-Token": passkeyConfirmation }),
        },
        body: JSON.stringify({
          newPlan: extractPlan(newTier),
          newInterval: newInterval || "monthly",
          forceMigration,
        }),
      });
      if (!response.ok) {
        const error = (await response.json()) as {
          error?: string; code?: string; tier?: string; requiresPasskey?: boolean; serverDomain?: string;
        };

        if (isLockedTier(error.tier) && error.requiresPasskey) {
          const currentSecTier = serverStatus?.server?.securityTier;
          const srvDomain = error.serverDomain;

          // Standard -> needs passkey registration first
          if (!isLockedTier(currentSecTier) && srvDomain) {
            const bridge = document.querySelector('iframe[title="VPS Auth Bridge"]') as HTMLIFrameElement | null;
            if (!bridge?.contentWindow) throw new Error("VPS bridge not available");

            const bridgeCall = <T,>(type: string, data?: Record<string, unknown>): Promise<T> => {
              return new Promise((resolve, reject) => {
                const reqId = crypto.randomUUID();
                const timeout = setTimeout(() => reject(new Error("Bridge timeout")), 30000);
                const handler = (ev: MessageEvent) => {
                  if (ev.data?.requestId !== reqId) return;
                  window.removeEventListener("message", handler);
                  clearTimeout(timeout);
                  if (ev.data.error) reject(new Error(ev.data.error));
                  else resolve(ev.data as T);
                };
                window.addEventListener("message", handler);
                bridge.contentWindow!.postMessage({ type, requestId: reqId, ...data }, `https://${srvDomain}`);
              });
            };

            const regOpts = await bridgeCall<{ options: Record<string, unknown> }>("get_registration_options", { name: "Passkey" });
            const attestation = await startRegistration({ optionsJSON: regOpts.options as unknown as PublicKeyCredentialCreationOptionsJSON });
            await bridgeCall("verify_registration", { attestation, name: "Passkey" });

            const confirmResult = await bridgeCall<{ success: boolean; confirmation: string }>("confirm_operation", { operation: "change-tier" });
            if (!confirmResult.confirmation) throw new Error("Failed to get confirmation");

            const retryRes = await fetch(`${API_URL}/api/servers/${serverId}/change-tier`, {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ newTier, newInterval, forceMigration, passkeyConfirmation: confirmResult.confirmation }),
            });
            if (!retryRes.ok) {
              const retryErr = await retryRes.json();
              throw new Error(retryErr.error || "Failed to change tier");
            }
            return retryRes.json();
          }

          // Already locked (web_locked or private_locked) — just needs confirmation
          pendingTierChangeRef.current = { serverId, newTier, newInterval, forceMigration };
          setVpsAuthDialog({
            open: true,
            operation: "change-tier",
            instructions: t("toasts.passkeyChangePlan"),
            serverDomain: srvDomain,
            tier: error.tier || "web_locked",
            requiresPasskey: true,
          });
          throw new Error("PASSKEY_REQUIRED");
        }
        throw new Error(error.error || "Failed to change tier");
      }
      return response.json();
    },
    onSuccess: () => {
      pendingTierChangeRef.current = null;
      triggerRapidPoll();
      setVpsAuthDialog({ open: false, operation: null, instructions: "" });
      queryClient.invalidateQueries({ queryKey: ["server-status"] });
      queryClient.invalidateQueries({ queryKey: ["tier-options"] });
    },
    onError: (error) => {
      if (error.message !== "PASSKEY_REQUIRED") {
        pendingTierChangeRef.current = null;
      }
    },
  });

  const cancelDowngradeMutation = useMutation({
    mutationFn: async ({ serverId, passkeyConfirmation }: { serverId: string; passkeyConfirmation?: string }) =>
      protectedFetch(`${API_URL}/api/servers/${serverId}/cancel-downgrade`, "POST", "cancel-downgrade", passkeyConfirmation),
    onSuccess: () => {
      protectedMutationCallbacks.onSuccess();
      queryClient.invalidateQueries({ queryKey: ["tier-options"] });
    },
    onError: protectedMutationCallbacks.onError,
  });

  // ── Handler wrappers ──

  const sid = () => serverStatus?.server?.id;

  const handleChangeTier = (params: {
    newTier: string; newInterval?: string; forceMigration?: boolean;
  }) => {
    if (sid()) changeTierMutation.mutate({
      serverId: sid()!, newTier: params.newTier,
      newInterval: params.newInterval || "monthly", forceMigration: params.forceMigration,
    });
  };
  const handleCancelDowngrade = () => { if (sid()) cancelDowngradeMutation.mutate({ serverId: sid()! }); };
  const handleRollbackServer = () => { if (sid()) rollbackServerMutation.mutate({ serverId: sid()! }); };
  const handleUpdateServer = () => { if (sid()) updateServerMutation.mutate({ serverId: sid()! }); };
  const handleSetAgentUpdateMode = (mode: "auto" | "manual") => {
    if (!sid()) return;
    pendingAgentUpdateModeRef.current = mode;
    setAgentUpdateModeMutation.mutate({ serverId: sid()!, mode });
  };
  const handleDeleteServer = () => { if (sid()) deleteServerMutation.mutate({ serverId: sid()! }); };
  const handleRebuildServer = () => { if (sid()) rebuildServerMutation.mutate({ serverId: sid()! }); };
  const handleManageSubscription = () => { portalMutation.mutate(); };
  const handleCheckout = (
    product: "cloud_platform" | "shield_proxy",
    plan: "hobby" | "pro" = "pro",
  ) => { checkoutMutation.mutate({ product, plan }); };
  const handleSignOut = async () => {
    const { signOut } = await import("@/lib/auth-client");
    const { isNativeApp } = await import("@/lib/utils");
    const { clearAllOperatorKeys } = await import("@/lib/operator-key");
    // Zero in-memory operator key + drop wrapped blobs before the session cookie
    // dies — otherwise the IDB blob outlives the server-side session it was
    // bound to, leaving a wrap whose matching pubkey the shield no longer knows.
    try { await clearAllOperatorKeys(); } catch { /* non-fatal on logout */ }
    await signOut();
    window.location.href = isNativeApp() ? "/sign-up" : (process.env.NEXT_PUBLIC_WEB_URL!);
  };

  // ── Passkey confirmation ──

  const handlePasskeyConfirmation = async () => {
    if (!sid() || !vpsAuthDialog.operation || !vpsAuthDialog.serverDomain) return;
    setVpsAuthDialog((prev) => ({ ...prev, passkeyPending: true }));
    try {
      const bridge = document.querySelector('iframe[title="VPS Auth Bridge"]') as HTMLIFrameElement | null;
      if (!bridge?.contentWindow) throw new Error("VPS bridge not available. Please refresh the page.");

      const confirmation = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Passkey confirmation timed out")), 60000);
        const handler = (event: MessageEvent) => {
          if (!isValidServerOrigin(event.origin) &&
              event.origin !== `https://${vpsAuthDialog.serverDomain}`) return;
          if (event.data.requestId !== "passkey_confirm") return;
          window.removeEventListener("message", handler);
          clearTimeout(timeout);
          if (event.data.success && event.data.confirmation) resolve(event.data.confirmation);
          else reject(new Error(event.data.error || "Passkey confirmation failed"));
        };
        window.addEventListener("message", handler);
        bridge.contentWindow!.postMessage(
          { type: "confirm_operation", requestId: "passkey_confirm", operation: vpsAuthDialog.operation },
          `https://${vpsAuthDialog.serverDomain}`,
        );
      });

      const mutationMap: Record<string, () => void> = {
        delete: () => deleteServerMutation.mutate({ serverId: sid()!, passkeyConfirmation: confirmation }),
        rebuild: () => rebuildServerMutation.mutate({ serverId: sid()!, passkeyConfirmation: confirmation }),
        update: () => updateServerMutation.mutate({ serverId: sid()!, passkeyConfirmation: confirmation }),
        "update-mode": () => {
          if (pendingAgentUpdateModeRef.current) {
            setAgentUpdateModeMutation.mutate({
              serverId: sid()!,
              mode: pendingAgentUpdateModeRef.current,
              passkeyConfirmation: confirmation,
            });
          }
        },
        rollback: () => rollbackServerMutation.mutate({ serverId: sid()!, passkeyConfirmation: confirmation }),
        "change-tier": () => { if (pendingTierChangeRef.current) changeTierMutation.mutate({ ...pendingTierChangeRef.current, passkeyConfirmation: confirmation }); },
        "cancel-downgrade": () => cancelDowngradeMutation.mutate({ serverId: sid()!, passkeyConfirmation: confirmation }),
      };
      mutationMap[vpsAuthDialog.operation!]?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("toasts.passkeyFailed"));
      setVpsAuthDialog((prev) => ({ ...prev, passkeyPending: false }));
    }
  };

  return {
    createServerMutation,
    wakeServerMutation,
    checkoutMutation,
    portalMutation,
    deleteServerMutation,
    rebuildServerMutation,
    rollbackServerMutation,
    updateServerMutation,
    setAgentUpdateModeMutation,
    changeTierMutation,
    cancelDowngradeMutation,
    handleChangeTier,
    handleCancelDowngrade,
    handleRollbackServer,
    handleUpdateServer,
    handleSetAgentUpdateMode,
    handleSignOut,
    handleCheckout,
    handleManageSubscription,
    handleDeleteServer,
    handleRebuildServer,
    handlePasskeyConfirmation,
    triggerRapidPoll,
    vpsAuthDialog,
    setVpsAuthDialog,
    actionPending,
    pendingTierChangeRef,
  };
}
