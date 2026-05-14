// SPDX-License-Identifier: MIT
"use client";

import {
  RefreshCw,
  CreditCard,
  AlertTriangle,
  Trash2,
  Lock,
  KeyRound,
  Shield,
  ShieldAlert,
  Mail,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { ServerStatus } from "@/contexts/DashboardContext";
import type { UseMutationResult } from "@tanstack/react-query";

// ── Error state ──────────────────────────────────────────────────

interface ErrorOverlayProps {
  serverStatus: ServerStatus;
  deleteServerMutation: UseMutationResult<unknown, Error, { serverId: string; passkeyConfirmation?: string }>;
}

export function ErrorOverlay({ serverStatus, deleteServerMutation }: ErrorOverlayProps) {
  const t = useTranslations("console.statusOverlays");
  if (serverStatus.state !== "error") return null;

  return (
    <div className="fixed inset-0 flex items-center justify-center z-10 bg-background/95 backdrop-blur-sm p-4">
      <div className="max-w-lg w-full">
        <div className="panel-ascente p-8 text-center">
          <div className="w-14 h-14 rounded-xl bg-terra/10 flex items-center justify-center mx-auto mb-4">
            <AlertTriangle className="h-7 w-7 text-terra" />
          </div>
          <h2 className="mb-2 text-xl font-semibold text-cream">{t("errorTitle")}</h2>
          <p className="text-cream/60 text-sm mb-6">{t("errorBody")}</p>
          <Button
            variant="outline"
            onClick={() =>
              serverStatus.server?.id &&
              deleteServerMutation.mutate({ serverId: serverStatus.server.id })
            }
            disabled={deleteServerMutation.isPending}
            className="border-terra/20 text-terra hover:bg-terra/10"
          >
            {deleteServerMutation.isPending ? (
              <Spinner size="sm" className="mr-2" />
            ) : (
              <Trash2 className="mr-2 h-4 w-4" />
            )}
            {t("errorAction")}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Awaiting Volume Unlock ───────────────────────────────────────

interface AwaitingUnlockOverlayProps {
  serverStatus: ServerStatus;
  isUnlocking: boolean;
  unlockError: string | null;
  setUnlockError: (v: string | null) => void;
  getPrfKey: () => Promise<string>;
  prfKeyRef: React.MutableRefObject<string | null>;
  unlockVolume: (params: { serverId: string; prfKey: string }) => Promise<unknown>;
}

export function AwaitingUnlockOverlay({
  serverStatus, isUnlocking, unlockError, setUnlockError, getPrfKey, prfKeyRef, unlockVolume,
}: AwaitingUnlockOverlayProps) {
  const t = useTranslations("console.statusOverlays");
  if (serverStatus.state !== "awaiting_unlock") return null;

  return (
    <div className="fixed inset-0 flex items-center justify-center z-10 bg-background/95 backdrop-blur-sm p-4">
      <div className="max-w-lg w-full">
        <div className="panel-ascente p-6 sm:p-10">
          <div className="flex items-center justify-center py-6">
            <div className="relative">
              <div className="w-20 h-20 rounded-full border-4 border-sodium/20" />
              {isUnlocking ? (
                <div className="absolute inset-0 m-auto w-16 h-16 rounded-full border-4 border-sodium border-t-transparent animate-spin" />
              ) : null}
              <div className="absolute inset-0 flex items-center justify-center">
                <Lock className="h-6 w-6 text-sodium" />
              </div>
            </div>
          </div>
          <h2 className="mb-2 text-xl font-semibold text-center text-cream">
            {isUnlocking ? t("unlockingTitle") : t("lockedTitle")}
          </h2>
          <p className="text-center text-sodium text-sm font-medium mb-2">
            {isUnlocking ? t("unlockingBody") : t("lockedBody")}
          </p>

          {unlockError && (
            <div className="mt-2 p-3 rounded-lg bg-terra/10 border border-terra/20 text-center">
              <p className="text-sm text-terra mb-3">{unlockError}</p>
            </div>
          )}

          {!isUnlocking && (
            <div className="mt-4 text-center">
              <Button
                variant="outline"
                className="border-sodium/30 text-sodium"
                onClick={async () => {
                  setUnlockError(null);
                  try {
                    const key = await getPrfKey();
                    prfKeyRef.current = key;
                    const serverId = serverStatus.server?.id;
                    if (serverId) {
                      await unlockVolume({ serverId, prfKey: key });
                      prfKeyRef.current = null;
                    }
                  } catch (err) {
                    prfKeyRef.current = null;
                    const msg = err instanceof Error ? err.message : t("passkeyFailed");
                    if (!msg.includes("cancelled") && !msg.includes("abort")) {
                      setUnlockError(msg);
                    }
                  }
                }}
              >
                <KeyRound className="mr-2 h-4 w-4" />
                {t("tapToUnlock")}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Pending Deletion ─────────────────────────────────────────────

interface PendingDeletionOverlayProps {
  serverStatus: ServerStatus;
  handleManageSubscription: () => void;
  portalMutation: UseMutationResult<{ url: string }, Error, void>;
}

export function PendingDeletionOverlay({ serverStatus, handleManageSubscription, portalMutation }: PendingDeletionOverlayProps) {
  const t = useTranslations("console.statusOverlays");
  if (serverStatus.state !== "pending_deletion") return null;

  return (
    <div className="fixed inset-0 flex items-center justify-center z-10 bg-background/95 backdrop-blur-sm p-4">
      <div className="max-w-lg w-full">
        <div className="panel-ascente p-8 text-center">
          <div className="w-14 h-14 rounded-xl bg-sodium/10 flex items-center justify-center mx-auto mb-4">
            <CreditCard className="h-7 w-7 text-sodium" />
          </div>
          <h2 className="mb-2 text-xl font-semibold text-cream">{t("pendingDeletionTitle")}</h2>
          <p className="text-cream/60 text-sm mb-6">
            {t("pendingDeletionBody")}
          </p>
          <Button
            onClick={handleManageSubscription}
            disabled={portalMutation.isPending}
            className="bg-sodium hover:bg-sodium"
          >
            {portalMutation.isPending ? <Spinner size="sm" className="mr-2" /> : <CreditCard className="mr-2 h-4 w-4" />}
            {t("resubscribeNow")}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Frozen ───────────────────────────────────────────────────────

interface FrozenOverlayProps {
  serverStatus: ServerStatus;
  onRefresh: () => void;
}

export function FrozenOverlay({ serverStatus, onRefresh }: FrozenOverlayProps) {
  const t = useTranslations("console.statusOverlays");
  if (serverStatus.state !== "frozen") return null;

  return (
    <div className="fixed inset-0 flex items-center justify-center z-10 bg-background/95 backdrop-blur-sm p-4">
      <div className="max-w-lg w-full">
        <div className="panel-ascente p-8">
          <div className="w-16 h-16 rounded-2xl bg-terra/10 border border-terra/20 flex items-center justify-center mx-auto mb-6">
            <ShieldAlert className="h-8 w-8 text-terra" />
          </div>
          <h2 className="mb-2 text-xl font-semibold text-cream text-center">{t("frozenTitle")}</h2>
          <p className="text-cream/60 text-sm text-center mb-4">
            {t("frozenBody")}
          </p>

          {serverStatus.frozenReason && (
            <div className="rounded-lg border border-terra/15 bg-terra/[0.05] px-4 py-3 mb-6">
              <p className="text-[11px] font-medium text-cream/45 uppercase tracking-wider mb-1">{t("frozenReasonLabel")}</p>
              <p className="text-sm text-cream/75">{serverStatus.frozenReason}</p>
            </div>
          )}

          <div className="rounded-xl border border-cream/5 bg-cream/[0.02] p-4 mb-6">
            <div className="flex items-start gap-3">
              <Shield className="h-5 w-5 text-cream/60 shrink-0 mt-0.5" />
              <div className="text-sm text-cream/75">
                <p className="font-medium text-cream mb-1.5">{t("dataSafeTitle")}</p>
                <p className="text-cream/60 text-xs leading-relaxed">
                  {t("dataSafeBody")}
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Button
              onClick={() => window.location.href = "mailto:support@ellul.ai?subject=Server%20Suspended%20-%20Review%20Request&body=Server%20ID%3A%20" + (serverStatus.server?.id || "")}
              className="bg-terra hover:bg-terra text-cream"
            >
              <Mail className="mr-2 h-4 w-4" />
              {t("contactSupport")}
            </Button>
            <Button variant="outline" className="border-cream/[0.08] text-cream/75" onClick={onRefresh}>
              <RefreshCw className="mr-2 h-4 w-4" />
              {t("checkStatus")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
