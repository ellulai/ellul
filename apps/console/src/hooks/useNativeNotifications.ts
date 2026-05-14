// SPDX-License-Identifier: MIT
"use client";

import { useEffect, useCallback, useRef } from "react";
import { useTranslations } from "next-intl";
import { isTauriApp } from "@/lib/utils";
import { useHapticFeedback, type HapticIntensity } from "./useHapticFeedback";

interface TauriNotificationModule {
  isPermissionGranted: () => Promise<boolean>;
  requestPermission: () => Promise<string>;
  sendNotification: (options: { title: string; body: string }) => void;
}

// Module specifier extracted to bypass TypeScript's static import resolution.
const TAURI_NOTIFICATION_MODULE = "@tauri-apps/plugin-notification";

// Notification categories that users can toggle
export type NotificationCategory =
  | "gate_request"    // Agent needs authorization (deploy, git push, db write, etc.)
  | "cli_prompt"      // Agent asking a question
  | "task_complete"   // Agent finished a task
  | "task_error"      // Agent encountered an error
  | "server_status"   // Server status changes (ready, hibernating, etc.)
  | "deploy_status";  // Deployment success/failure

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

// Map event types to notification content
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

// Map notification categories to haptic feedback intensities
const HAPTIC_INTENSITY_MAP: Record<NotificationCategory, HapticIntensity> = {
  gate_request: "heavy",
  cli_prompt: "medium",
  task_complete: "light",
  task_error: "heavy",
  deploy_status: "medium",
  server_status: "light",
};

// Hook that listens for app events and fires native OS notifications
export function useNativeNotifications() {
  const t = useTranslations("console.notifications");
  const isBackground = useRef(false);
  const notifyModule = useRef<TauriNotificationModule | null>(null);
  const permissionGranted = useRef(false);
  const { triggerHaptic } = useHapticFeedback();

  // Track if app is in background
  useEffect(() => {
    const handleVisibility = () => {
      isBackground.current = document.hidden;
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  // Initialize Tauri notifications
  useEffect(() => {
    if (!isTauriApp()) return;

    (async () => {
      try {
        // Dynamic import — only available in Tauri runtime
        const mod = await import(/* webpackIgnore: true */ TAURI_NOTIFICATION_MODULE) as TauriNotificationModule;
        notifyModule.current = mod;

        // Request permission
        let permission = await mod.isPermissionGranted();
        if (!permission) {
          const result = await mod.requestPermission();
          permission = result === "granted";
        }
        permissionGranted.current = permission;
      } catch (err) {
        console.warn("Failed to init native notifications:", err);
      }
    })();
  }, []);

  const sendNotification = useCallback((eventType: string, data: any) => {
    const payload = buildNotification(eventType, data, t as unknown as Translator);
    if (!payload) return;

    // Check user preferences
    const prefs = getNotificationPrefs();
    if (!prefs[payload.category]) return;

    // Trigger haptic feedback on mobile regardless of foreground/background
    const hapticIntensity = HAPTIC_INTENSITY_MAP[payload.category];
    if (hapticIntensity) {
      triggerHaptic(hapticIntensity);
    }

    // Only send OS notification when app is in background
    if (!isBackground.current) return;
    if (!notifyModule.current || !permissionGranted.current) return;

    notifyModule.current.sendNotification({
      title: payload.title,
      body: payload.body,
    });
  }, [triggerHaptic, t]);

  return { sendNotification };
}
