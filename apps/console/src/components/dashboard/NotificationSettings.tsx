// SPDX-License-Identifier: MIT
"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Bell, BellOff } from "lucide-react";
import { isTauriApp } from "@/lib/utils";
import { API_URL } from "@/lib/api";
import {
  getNotificationPrefs,
  setNotificationPref,
  type NotificationCategory,
} from "@/hooks/useNativeNotifications";

const CATEGORY_KEYS: { key: NotificationCategory; labelKey: string; descKey: string }[] = [
  { key: "gate_request", labelKey: "gateRequest", descKey: "gateRequestDesc" },
  { key: "cli_prompt", labelKey: "cliPrompt", descKey: "cliPromptDesc" },
  { key: "task_complete", labelKey: "taskComplete", descKey: "taskCompleteDesc" },
  { key: "task_error", labelKey: "taskError", descKey: "taskErrorDesc" },
  { key: "server_status", labelKey: "serverStatus", descKey: "serverStatusDesc" },
  { key: "deploy_status", labelKey: "deployStatus", descKey: "deployStatusDesc" },
];

// Sync notification preferences to the API for remote push.
let syncTimer: ReturnType<typeof setTimeout> | null = null;

function syncPrefsToApi(prefs: Record<NotificationCategory, boolean>) {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    try {
      // Get registered tokens and update their preferences
      const tokensRes = await fetch(`${API_URL}/api/push/tokens`, {
        credentials: "include",
      });
      if (!tokensRes.ok) return;

      const { tokens } = await tokensRes.json();
      for (const token of tokens) {
        await fetch(`${API_URL}/api/push/preferences`, {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tokenId: token.id,
            preferences: prefs,
          }),
        });
      }
    } catch {
      // Silently fail — local prefs are authoritative for local notifications
    }
  }, 500);
}

export function NotificationSettings() {
  const t = useTranslations("console.notificationSettings");
  const [prefs, setPrefs] = useState(getNotificationPrefs);
  const [isNative, setIsNative] = useState(false);

  useEffect(() => {
    setIsNative(isTauriApp());
  }, []);

  if (!isNative) return null;

  const toggle = (key: NotificationCategory) => {
    const newVal = !prefs[key];
    setNotificationPref(key, newVal);
    const updated = { ...prefs, [key]: newVal };
    setPrefs(updated);
    syncPrefsToApi(updated);
  };

  const allEnabled = Object.values(prefs).every(Boolean);
  const toggleAll = () => {
    const newVal = !allEnabled;
    for (const cat of CATEGORY_KEYS) {
      setNotificationPref(cat.key, newVal);
    }
    const updated = getNotificationPrefs();
    setPrefs(updated);
    syncPrefsToApi(updated);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium text-cream">
          <Bell className="h-4 w-4" />
          {t("title")}
        </div>
        <button
          onClick={toggleAll}
          className="text-xs text-sodium hover:text-sodium transition-colors"
        >
          {allEnabled ? t("disableAll") : t("enableAll")}
        </button>
      </div>
      <div className="space-y-1">
        {CATEGORY_KEYS.map((cat) => (
          <button
            key={cat.key}
            onClick={() => toggle(cat.key)}
            className="w-full flex items-center justify-between rounded-lg px-3 py-2 text-left transition-colors hover:bg-cream/5"
          >
            <div>
              <div className="text-sm text-cream">{t(`categories.${cat.labelKey}` as `categories.gateRequest`)}</div>
              <div className="text-xs text-cream/40">{t(`categories.${cat.descKey}` as `categories.gateRequestDesc`)}</div>
            </div>
            {prefs[cat.key] ? (
              <Bell className="h-4 w-4 text-sodium shrink-0" />
            ) : (
              <BellOff className="h-4 w-4 text-cream/20 shrink-0" />
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
