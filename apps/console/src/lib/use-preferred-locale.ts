// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

"use client";

import { useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type { Locale } from "@ellul.ai/i18n-consts";
import { ALL_LOCALES } from "@ellul.ai/i18n-consts";
import { writeLocaleCookie } from "@ellul.ai/i18n/cookie";
import { useRouter, usePathname } from "@/i18n/routing";
import { authClient, type Session } from "@/lib/auth-client";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
const SESSION_QUERY_KEY = ["auth", "session"] as const;

function broadcastLocaleToIframes(locale: Locale): void {
  if (typeof document === "undefined") return;
  const iframes = document.querySelectorAll<HTMLIFrameElement>("iframe[src]");
  for (const iframe of iframes) {
    try {
      const origin = new URL(iframe.src).origin;
      iframe.contentWindow?.postMessage({ type: "set_locale", locale }, origin);
    } catch {
      // Bad src or cross-origin lockdown — skip silently
    }
  }
}

export interface UsePreferredLocaleResult {
  isUpdating: boolean;
  setLocale: (locale: Locale) => Promise<void>;
}

export function usePreferredLocale(): UsePreferredLocaleResult {
  const t = useTranslations("console.lib.preferredLocale");
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();

  // Snapshot the server-confirmed original so rapid clicks don't roll
  // back to an in-flight optimistic value.
  const confirmedOriginalRef = useRef<Locale | undefined>(undefined);

  const mutation = useMutation({
    mutationKey: ["me", "preferences", "preferredLocale"],
    mutationFn: async (locale: Locale) => {
      const res = await fetch(`${API_URL}/api/me/preferences`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preferredLocale: locale }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(
          typeof detail.error === "string" ? detail.error : "patch_failed",
        );
      }
      return (await res.json()) as { preferredLocale: Locale };
    },
    onMutate: async (newLocale: Locale) => {
      const previousSession =
        queryClient.getQueryData<Session | null>(SESSION_QUERY_KEY) ?? null;

      if (confirmedOriginalRef.current === undefined) {
        confirmedOriginalRef.current =
          (previousSession?.user?.preferredLocale as Locale | undefined) ??
          undefined;
      }
      const trueOriginal = confirmedOriginalRef.current;

      if (previousSession) {
        queryClient.setQueryData<Session | null>(SESSION_QUERY_KEY, {
          ...previousSession,
          user: {
            ...previousSession.user,
            preferredLocale: newLocale,
          },
        });
      }

      router.replace(pathname || "/", { locale: newLocale as never });
      broadcastLocaleToIframes(newLocale);
      writeLocaleCookie(newLocale);

      return { previousSession, trueOriginal };
    },
    onError: async (err, _newLocale, context) => {
      const fallback = context?.trueOriginal;

      if (context?.previousSession !== undefined) {
        queryClient.setQueryData<Session | null>(
          SESSION_QUERY_KEY,
          context.previousSession,
        );
      }

      if (fallback) {
        router.replace(pathname || "/", { locale: fallback as never });
        broadcastLocaleToIframes(fallback);
        writeLocaleCookie(fallback);
      }

      const message = err instanceof Error ? err.message : "unknown_error";
      toast.error(t("saveFailed", { message }));

      // Network blip may have masked a successful write — re-sync to truth.
      try {
        const { data } = await authClient.getSession();
        if (data) {
          queryClient.setQueryData<Session | null>(SESSION_QUERY_KEY, data);
          const serverLocale = (
            data.user as { preferredLocale?: string | null } | undefined
          )?.preferredLocale as Locale | undefined;
          if (serverLocale && serverLocale !== fallback) {
            router.replace(pathname || "/", { locale: serverLocale as never });
            broadcastLocaleToIframes(serverLocale);
            writeLocaleCookie(serverLocale);
            confirmedOriginalRef.current = serverLocale;
          }
        }
      } catch {
        // getSession also failed; rollback stands.
      }
    },
    onSuccess: (data, _newLocale) => {
      confirmedOriginalRef.current = data.preferredLocale;
      void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      void authClient.getSession();
    },
  });

  return {
    isUpdating: mutation.isPending,
    setLocale: async (locale: Locale) => {
      if (!(ALL_LOCALES as readonly string[]).includes(locale)) {
        throw new Error(`unsupported_locale:${locale}`);
      }
      await mutation.mutateAsync(locale);
    },
  };
}
