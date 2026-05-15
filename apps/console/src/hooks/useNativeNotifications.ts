// SPDX-License-Identifier: MIT
"use client";

import { useEffect, useCallback, useRef } from "react";
import { useTranslations } from "next-intl";
import { useHapticFeedback, type HapticIntensity } from "./useHapticFeedback";

export type NotificationCategory =
  | "gate_request"
  | "cli_prompt"
  | "task_complete"
  | "task_error"
  | "server_status"
  | "deploy_status";

const STORAGE_KEY = "ellul_notification_prefs";

const DEFAULT_PREFS: Record<NotificationCategory, boolean> = {
  gate_request: true,
  cli_prompt: true,
  task_complete: true,
  task_error: true,
  server_status: true,
  deploy_status: true,
};

export function getNotificationPrefs(): Record<NotificationCategory, boolean> {
  if (typeof window === "undefined") return DEFAULT_PREFS;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return { ...DEFAULT_PREFS, ...JSON.parse(stored) };
  } catch { /* ignore */ }
  return DEFAULT_PREFS;
}

export function setNotificationPref(category: NotificationCategory, enabled: boolean) {
  const prefs = getNotificationPrefs();
  prefs[category] = enabled;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

interface NotificationPayload {
  title: string;
  body: string;
  category: NotificationCategory;
}

type Translator = (key: string, values?: Record<string, string | number>) => string;

function buildNotification(
  eventType: string,
  data: any,
  t: Translator,
): NotificationPayload | null {
  switch (eventType) {
    case "gate_request": {
      const permission = (data.gate as string | undefined)?.replace(/_/g, " ") ?? "";
      const reason = data.reason as string | undefined;
      return {
        title: t("gateRequest.title"),
        body: reason
          ? t("gateRequest.bodyWithReason", { permission, reason })
          : t("gateRequest.body", { permission }),
        category: "gate_request",
      };
    }

    case "cli_prompt":
      return {
        title: t("cliPrompt.title"),
        body: (data.context as string | undefined)?.slice(0, 120) || t("cliPrompt.body"),
        category: "cli_prompt",
      };

    case "command_complete":
      return {
        title: t("taskComplete.title"),
        body: (data.text?.[0] as string | undefined)?.slice(0, 120) || t("taskComplete.body"),
        category: "task_complete",
      };

    case "command_error":
      return {
        title: t("taskError.title"),
        body: (data.error as string | undefined)?.slice(0, 120) || t("taskError.body"),
        category: "task_error",
      };

    case "state_changed": {
      const state = data.state;
      if (state === "running") {
        return {
          title: t("serverReady.title"),
          body: t("serverReady.body"),
          category: "server_status",
        };
      }
      if (state === "hibernated") {
        return {
          title: t("serverHibernated.title"),
          body: t("serverHibernated.body"),
          category: "server_status",
        };
      }
      return null;
    }

    case "deployment_changed":
      return {
        title: t("deployment.title"),
        body: data.name
          ? t("deployment.bodyNamed", { name: data.name as string })
          : t("deployment.body"),
        category: "deploy_status",
      };

    default:
      return null;
  }
}

const HAPTIC_INTENSITY_MAP: Record<NotificationCategory, HapticIntensity> = {
  gate_request: "heavy",
  cli_prompt: "medium",
  task_complete: "light",
  task_error: "heavy",
  deploy_status: "medium",
  server_status: "light",
};

export function useNativeNotifications() {
  const t = useTranslations("console.notifications");
  const isBackground = useRef(false);
  const permissionGranted = useRef(false);
  const { triggerHaptic } = useHapticFeedback();

  useEffect(() => {
    const handleVisibility = () => {
      isBackground.current = document.hidden;
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  useEffect(() => {
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "granted") {
      permissionGranted.current = true;
    } else if (Notification.permission !== "denied") {
      Notification.requestPermission().then((result) => {
        permissionGranted.current = result === "granted";
      });
    }
  }, []);

  const sendNotification = useCallback((eventType: string, data: any) => {
    const payload = buildNotification(eventType, data, t as unknown as Translator);
    if (!payload) return;

    const prefs = getNotificationPrefs();
    if (!prefs[payload.category]) return;

    const hapticIntensity = HAPTIC_INTENSITY_MAP[payload.category];
    if (hapticIntensity) {
      triggerHaptic(hapticIntensity);
    }

    if (!isBackground.current) return;
    if (!permissionGranted.current) return;

    new Notification(payload.title, { body: payload.body });
  }, [triggerHaptic, t]);

  return { sendNotification };
}
