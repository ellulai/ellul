// SPDX-License-Identifier: MIT
"use client";

// it; future devices don't re-fire the toast
// • No authz material           — this component never grants/denies, only

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { usePermissionInboxOptional, type InboxRequest } from "@/contexts/PermissionInboxContext";

interface DispatcherProps {
  activeThreadId: string | null;
  onReview: (threadId: string) => void;
}

const KNOWN_GATES = new Set(["logs", "env", "db", "db_read", "db_write", "db_migrate", "db_full", "git", "deploy", "tool", "wallet_spend", "vault_read", "exec"]);

export function PermissionToastDispatcher({ activeThreadId, onReview }: DispatcherProps) {
  const t = useTranslations("console.permissionToast");

  const describe = (r: InboxRequest): string => {
    const gateKey = String(r.gate);
    const base = KNOWN_GATES.has(gateKey)
      ? t(`${gateKey}` as `logs`)
      : t("fallback", { gate: gateKey });
    if (r.requestedBy.toolName) {
      return t("describeWithTool", { kind: base, tool: r.requestedBy.toolName });
    }
    return t("describe", { kind: base });
  };

  const inbox = usePermissionInboxOptional();
  const toastedRef = useRef<Set<string>>(new Set());
  const toastIdsRef = useRef<Map<string, string | number>>(new Map());

  // Suppress toasts until inbox hydration completes. Before that, we
  // don't know which requests are genuinely new vs stale-from-DB, and
  // activeThreadId may not be set yet (would cause false toasts for
  // the thread the user is about to auto-select).
  const hydrated = inbox?.status.hydrated ?? false;

  useEffect(() => {
    if (!inbox) return;
    if (!hydrated) return;

    for (const request of inbox.byId.values()) {
      if (request.status !== "pending") continue;
      if (toastedRef.current.has(request.id)) continue;

      if (activeThreadId && request.threadId === activeThreadId) {
        continue;
      }

      toastedRef.current.add(request.id);

      const threadLabel = request.threadId.slice(0, 8);
      const toastId = toast.info(describe(request), {
        description: t("thread", { id: threadLabel }),
        duration: 15000,
        action: {
          label: t("review"),
          onClick: () => {
            onReview(request.threadId);
            void inbox.markSeen(request.id);
          },
        },
        cancel: {
          label: t("dismiss"),
          onClick: () => { void inbox.markSeen(request.id); },
        },
      });
      toastIdsRef.current.set(request.id, toastId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inbox, activeThreadId, onReview, t]);

  useEffect(() => {
    if (!inbox) return;
    for (const [requestId, toastId] of toastIdsRef.current) {
      const req = inbox.byId.get(requestId);
      const resolved = !req || req.status !== "pending";
      const modalTakeover = req && activeThreadId && req.threadId === activeThreadId;
      if (resolved || modalTakeover) {
        toast.dismiss(toastId);
        toastIdsRef.current.delete(requestId);
        toastedRef.current.delete(requestId);
      }
    }
  }, [inbox, activeThreadId]);

  return null;
}
